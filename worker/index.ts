import {
  canonicalizeCatalogTags,
  parseCatalogSearchParams,
  parseCatalogTagListParams,
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

  await ensureCatalogSchemaReady(env)

  const client = createCatalogDatabaseClient(env)

  try {
    const payload = await searchCatalog(client, params)

    const response = jsonResponse(payload, 200, {
      "Cache-Control": SEARCH_CACHE_CONTROL,
    })

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
    searchParams.set("q", params.query)
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
