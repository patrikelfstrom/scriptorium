import {
  canonicalizeCatalogTags,
  parseCatalogSearchParams,
  parseCatalogTagListParams,
  tokenizeCatalogQuery,
} from "../shared/catalog"
import type { CatalogTagListResponse } from "../shared/catalog"
import {
  createCatalogDatabaseClient,
  getCatalogDatabaseIdentity,
} from "../server/catalog/database"
import { listCatalogTags, searchCatalog } from "../server/catalog/read-service"
import { ensureCatalogSchema } from "../server/catalog/schema"

export type WorkerEnv = {
  SCRIPTORIUM_DATA_DIR?: string
  TURSO_DATABASE_URL?: string
  TURSO_AUTH_TOKEN?: string
  CATALOG_CACHE?: CatalogCacheNamespace
}

type CatalogCacheNamespace = {
  get(key: string, type: "json"): Promise<unknown | null>
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number
    }
  ): Promise<void>
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

const TAG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400"
const SEARCH_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
const TAG_MEMORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const TAG_KV_CACHE_TTL_SECONDS = 24 * 60 * 60
const SEARCH_KV_CACHE_TTL_SECONDS = 60 * 60
const CATALOG_CACHE_VERSION = "v1"

const schemaReadyPromises = new Map<string, Promise<void>>()
const tagPayloadCache = new Map<
  string,
  {
    expiresAt: number
    payload: CatalogTagListResponse
  }
>()

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      })
    }

    const url = new URL(request.url)

    try {
      switch (url.pathname) {
        case "/api/search":
          return await handleSearchRequest(url, env)
        case "/api/tags":
          return await handleTagsRequest(request, url, env)
        default:
          return jsonResponse({ error: "Not found" }, 404)
      }
    } catch (error) {
      return jsonResponse(
        {
          error:
            error instanceof Error ? error.message : "Unknown worker error",
        },
        500
      )
    }
  },
}

async function handleSearchRequest(url: URL, env: WorkerEnv) {
  const params = parseCatalogSearchParams(url.searchParams)
  const request = createCanonicalSearchRequest(url, params)
  const edgeCachedResponse = await getCachedEdgeResponse(request)

  if (edgeCachedResponse) {
    return edgeCachedResponse
  }

  const databaseIdentity = getCatalogDatabaseIdentity(env)
  const kvCacheKey = await createKvCacheKey("search", databaseIdentity, request)
  const kvCachedPayload = await getKvCachedPayload<
    Awaited<ReturnType<typeof searchCatalog>>
  >(env, kvCacheKey)

  if (kvCachedPayload) {
    const response = jsonResponse(kvCachedPayload, 200, {
      "Cache-Control": SEARCH_CACHE_CONTROL,
    })
    await cacheEdgeResponse(request, response)
    return response
  }

  await ensureCatalogSchemaReady(env)

  const client = createCatalogDatabaseClient(env)

  try {
    const payload = await searchCatalog(client, params)

    const response = jsonResponse(payload, 200, {
      "Cache-Control": SEARCH_CACHE_CONTROL,
    })

    await putKvCachedPayload(
      env,
      kvCacheKey,
      payload,
      SEARCH_KV_CACHE_TTL_SECONDS
    )
    await cacheEdgeResponse(request, response)

    return response
  } finally {
    client.close?.()
  }
}

function createCanonicalSearchRequest(
  url: URL,
  params: ReturnType<typeof parseCatalogSearchParams>
) {
  const requestUrl = new URL(url.toString())
  const searchParams = new URLSearchParams({
    limit: String(params.limit),
    sort: params.sort,
    direction: params.direction,
  })

  if (params.query) {
    searchParams.set("q", tokenizeCatalogQuery(params.query).join(" "))
  }

  const normalizedTags = canonicalizeCatalogTags(params.tags)

  if (normalizedTags.length > 0) {
    searchParams.set("tags", normalizedTags.join(","))
  }

  if (params.cursor) {
    searchParams.set("cursor", params.cursor)
  }

  requestUrl.search = searchParams.toString()

  return new Request(requestUrl.toString())
}

async function handleTagsRequest(request: Request, _url: URL, env: WorkerEnv) {
  const edgeCachedResponse = await getCachedEdgeResponse(request)

  if (edgeCachedResponse) {
    return edgeCachedResponse
  }

  const databaseIdentity = getCatalogDatabaseIdentity(env)
  const memoryCachedPayload = getMemoryCachedTagsPayload(databaseIdentity)

  if (memoryCachedPayload) {
    return jsonResponse(memoryCachedPayload, 200, {
      "Cache-Control": TAG_CACHE_CONTROL,
    })
  }

  const kvCacheKey = await createKvCacheKey("tags", databaseIdentity, request)
  const kvCachedPayload = await getKvCachedPayload<CatalogTagListResponse>(
    env,
    kvCacheKey
  )

  if (kvCachedPayload) {
    tagPayloadCache.set(databaseIdentity, {
      expiresAt: Date.now() + TAG_MEMORY_CACHE_TTL_MS,
      payload: kvCachedPayload,
    })

    const response = jsonResponse(kvCachedPayload, 200, {
      "Cache-Control": TAG_CACHE_CONTROL,
    })
    await cacheEdgeResponse(request, response)
    return response
  }

  await ensureCatalogSchemaReady(env)

  const client = createCatalogDatabaseClient(env)

  try {
    const payload = await listCatalogTags(client, parseCatalogTagListParams())
    const response = jsonResponse(payload, 200, {
      "Cache-Control": TAG_CACHE_CONTROL,
    })

    tagPayloadCache.set(databaseIdentity, {
      expiresAt: Date.now() + TAG_MEMORY_CACHE_TTL_MS,
      payload,
    })
    await putKvCachedPayload(env, kvCacheKey, payload, TAG_KV_CACHE_TTL_SECONDS)
    await cacheEdgeResponse(request, response)

    return response
  } finally {
    client.close?.()
  }
}

async function ensureCatalogSchemaReady(env: WorkerEnv) {
  const databaseIdentity = getCatalogDatabaseIdentity(env)
  const existingPromise = schemaReadyPromises.get(databaseIdentity)

  if (existingPromise) {
    await existingPromise
    return
  }

  const nextPromise = (async () => {
    const client = createCatalogDatabaseClient(env)

    try {
      await ensureCatalogSchema(client)
    } finally {
      client.close?.()
    }
  })().catch((error) => {
    schemaReadyPromises.delete(databaseIdentity)
    throw error
  })

  schemaReadyPromises.set(databaseIdentity, nextPromise)
  await nextPromise
}

function getMemoryCachedTagsPayload(databaseIdentity: string) {
  const cachedEntry = tagPayloadCache.get(databaseIdentity)

  if (!cachedEntry) {
    return null
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    tagPayloadCache.delete(databaseIdentity)
    return null
  }

  return cachedEntry.payload
}

async function getCachedEdgeResponse(request: Request) {
  const edgeCache = getEdgeCache()

  if (!edgeCache) {
    return null
  }

  const response = await edgeCache.match(request)
  return response ?? null
}

async function cacheEdgeResponse(request: Request, response: Response) {
  const edgeCache = getEdgeCache()

  if (!edgeCache) {
    return
  }

  await edgeCache.put(request, response.clone())
}

function getEdgeCache() {
  const runtimeCaches = globalThis as {
    caches?: {
      default?: {
        match: (request: Request) => Promise<Response | undefined>
        put: (request: Request, response: Response) => Promise<void>
      }
    }
  }

  return runtimeCaches.caches?.default
}

async function getKvCachedPayload<T>(env: WorkerEnv, key: string) {
  const cache = env.CATALOG_CACHE

  if (!cache) {
    return null
  }

  try {
    return (await cache.get(key, "json")) as T | null
  } catch {
    return null
  }
}

async function putKvCachedPayload<T>(
  env: WorkerEnv,
  key: string,
  payload: T,
  expirationTtl: number
) {
  const cache = env.CATALOG_CACHE

  if (!cache) {
    return
  }

  try {
    await cache.put(key, JSON.stringify(payload), { expirationTtl })
  } catch {
    // Cache writes are best-effort; serve the fresh payload even if KV fails.
  }
}

async function createKvCacheKey(
  scope: "search" | "tags",
  databaseIdentity: string,
  request: Request
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [CATALOG_CACHE_VERSION, scope, databaseIdentity, request.url].join("\n")
    )
  )

  return `${CATALOG_CACHE_VERSION}:${scope}:${toHex(digest)}`
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: Record<string, string>
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...headers,
    },
  })
}
