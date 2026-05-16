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
  shouldEagerlyEnsureCatalogSchemaOnRead,
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
const TAG_VERSION_CACHE_TTL_MS = 15 * 1000
const CATALOG_CACHE_VERSION = "v2"

const schemaReadyPromises = new Map<string, Promise<void>>()
const tagsVersionCache = new Map<
  string,
  {
    expiresAt: number
    version: string
  }
>()
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
  const edgeCacheRequest = createVersionedEdgeCacheRequest(request)
  const edgeCachedResponse = await getCachedEdgeResponse(edgeCacheRequest)

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
    await cacheEdgeResponse(edgeCacheRequest, response)
    return response
  }

  const payload = await runCatalogReadWithSchemaRepair(env, (client) =>
    searchCatalog(client, params)
  )
  const response = jsonResponse(payload, 200, {
    "Cache-Control": SEARCH_CACHE_CONTROL,
  })

  await putKvCachedPayload(
    env,
    kvCacheKey,
    payload,
    SEARCH_KV_CACHE_TTL_SECONDS
  )
  await cacheEdgeResponse(edgeCacheRequest, response)

  return response
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
  const databaseIdentity = getCatalogDatabaseIdentity(env)
  const staleEdgeCacheRequest = createVersionedEdgeCacheRequest(request, {
    tagsVersion: "stale",
  })
  const staleKvCacheKey = await createKvCacheKey(
    "tags",
    databaseIdentity,
    request,
    "stale"
  )
  let tagsVersion: string

  try {
    tagsVersion = await resolveTagsCacheVersion(env)
  } catch (error) {
    if (isTagStaleFallbackEligibleError(error)) {
      const staleFallbackResponse = await getStaleTagsFallbackResponse(
        env,
        databaseIdentity,
        staleEdgeCacheRequest,
        staleKvCacheKey
      )

      if (staleFallbackResponse) {
        return staleFallbackResponse
      }
    }

    throw error
  }

  const tagCacheKey = `${databaseIdentity}:${tagsVersion}`
  const edgeCacheRequest = createVersionedEdgeCacheRequest(request, {
    tagsVersion,
  })
  const edgeCachedResponse = await getCachedEdgeResponse(edgeCacheRequest)

  if (edgeCachedResponse) {
    pruneTagPayloadCache(databaseIdentity, tagCacheKey)
    return edgeCachedResponse
  }

  const memoryCachedPayload = getMemoryCachedTagsPayload(tagCacheKey)

  if (memoryCachedPayload) {
    pruneTagPayloadCache(databaseIdentity, tagCacheKey)
    return jsonResponse(memoryCachedPayload, 200, {
      "Cache-Control": TAG_CACHE_CONTROL,
    })
  }

  const kvCacheKey = await createKvCacheKey(
    "tags",
    databaseIdentity,
    request,
    tagsVersion
  )
  const kvCachedPayload = await getKvCachedPayload<CatalogTagListResponse>(
    env,
    kvCacheKey
  )

  if (kvCachedPayload) {
    tagPayloadCache.set(tagCacheKey, {
      expiresAt: Date.now() + TAG_MEMORY_CACHE_TTL_MS,
      payload: kvCachedPayload,
    })
    pruneTagPayloadCache(databaseIdentity, tagCacheKey)

    const response = jsonResponse(kvCachedPayload, 200, {
      "Cache-Control": TAG_CACHE_CONTROL,
    })
    await putKvCachedPayload(
      env,
      staleKvCacheKey,
      kvCachedPayload,
      TAG_KV_CACHE_TTL_SECONDS
    )
    await cacheEdgeResponse(edgeCacheRequest, response)
    await cacheEdgeResponse(staleEdgeCacheRequest, response)
    return response
  }

  let payload: CatalogTagListResponse

  try {
    payload = await runCatalogReadWithSchemaRepair(env, (client) =>
      listCatalogTags(client, parseCatalogTagListParams())
    )
  } catch (error) {
    if (isTagStaleFallbackEligibleError(error)) {
      const staleFallbackResponse = await getStaleTagsFallbackResponse(
        env,
        databaseIdentity,
        staleEdgeCacheRequest,
        staleKvCacheKey
      )

      if (staleFallbackResponse) {
        return staleFallbackResponse
      }
    }

    throw error
  }

  const response = jsonResponse(payload, 200, {
    "Cache-Control": TAG_CACHE_CONTROL,
  })

  tagPayloadCache.set(tagCacheKey, {
    expiresAt: Date.now() + TAG_MEMORY_CACHE_TTL_MS,
    payload,
  })
  pruneTagPayloadCache(databaseIdentity, tagCacheKey)
  await putKvCachedPayload(env, kvCacheKey, payload, TAG_KV_CACHE_TTL_SECONDS)
  await putKvCachedPayload(
    env,
    staleKvCacheKey,
    payload,
    TAG_KV_CACHE_TTL_SECONDS
  )
  await cacheEdgeResponse(edgeCacheRequest, response)
  await cacheEdgeResponse(staleEdgeCacheRequest, response)

  return response
}

async function resolveTagsCacheVersion(env: WorkerEnv) {
  const databaseIdentity = getCatalogDatabaseIdentity(env)
  const cachedVersion = getCachedTagsVersion(databaseIdentity)

  if (cachedVersion) {
    return cachedVersion
  }

  const resolvedVersion = await runCatalogReadWithSchemaRepair(
    env,
    async (client) => {
      const result = await client.execute({
        sql: `
        SELECT meta_value
        FROM catalog_meta
        WHERE meta_key = 'tags_version'
        LIMIT 1
      `,
      })

      return String(result.rows[0]?.meta_value ?? "0")
    }
  )

  tagsVersionCache.set(databaseIdentity, {
    expiresAt: Date.now() + TAG_VERSION_CACHE_TTL_MS,
    version: resolvedVersion,
  })

  return resolvedVersion
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

async function runCatalogReadWithSchemaRepair<T>(
  env: WorkerEnv,
  operation: (
    client: ReturnType<typeof createCatalogDatabaseClient>
  ) => Promise<T>
) {
  if (shouldEagerlyEnsureCatalogSchemaOnRead(env)) {
    await ensureCatalogSchemaReady(env)
  }

  let client = createCatalogDatabaseClient(env)

  try {
    return await operation(client)
  } catch (error) {
    if (
      shouldEagerlyEnsureCatalogSchemaOnRead(env) ||
      !isCatalogSchemaCompatibilityError(error)
    ) {
      throw error
    }

    client.close?.()
    await ensureCatalogSchemaReady(env)
    client = createCatalogDatabaseClient(env)
    return await operation(client)
  } finally {
    client.close?.()
  }
}

function isCatalogSchemaCompatibilityError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message.includes("no such table") ||
    error.message.includes("no such column") ||
    error.message.includes("has no column named")
  )
}

function getMemoryCachedTagsPayload(cacheKey: string) {
  const cachedEntry = tagPayloadCache.get(cacheKey)

  if (!cachedEntry) {
    return null
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    tagPayloadCache.delete(cacheKey)
    return null
  }

  return cachedEntry.payload
}

function getLatestMemoryCachedTagsPayload(databaseIdentity: string) {
  const keyPrefix = `${databaseIdentity}:`
  let newestEntry:
    | {
        expiresAt: number
        payload: CatalogTagListResponse
      }
    | undefined

  for (const [cacheKey, cacheEntry] of tagPayloadCache.entries()) {
    if (!cacheKey.startsWith(keyPrefix)) {
      continue
    }

    if (cacheEntry.expiresAt <= Date.now()) {
      tagPayloadCache.delete(cacheKey)
      continue
    }

    if (!newestEntry || cacheEntry.expiresAt > newestEntry.expiresAt) {
      newestEntry = cacheEntry
    }
  }

  return newestEntry?.payload ?? null
}

function pruneTagPayloadCache(
  databaseIdentity: string,
  activeCacheKey: string
) {
  const keyPrefix = `${databaseIdentity}:`

  for (const [cacheKey, cacheEntry] of tagPayloadCache.entries()) {
    if (!cacheKey.startsWith(keyPrefix)) {
      continue
    }

    if (cacheEntry.expiresAt <= Date.now() || cacheKey !== activeCacheKey) {
      tagPayloadCache.delete(cacheKey)
    }
  }
}

async function getStaleTagsFallbackResponse(
  env: WorkerEnv,
  databaseIdentity: string,
  staleEdgeCacheRequest: Request,
  staleKvCacheKey: string
) {
  const staleEdgeCachedResponse = await getCachedEdgeResponse(
    staleEdgeCacheRequest
  )

  if (staleEdgeCachedResponse) {
    return staleEdgeCachedResponse
  }

  const staleMemoryPayload = getLatestMemoryCachedTagsPayload(databaseIdentity)

  if (staleMemoryPayload) {
    return jsonResponse(staleMemoryPayload, 200, {
      "Cache-Control": TAG_CACHE_CONTROL,
    })
  }

  const staleKvCachedPayload = await getKvCachedPayload<CatalogTagListResponse>(
    env,
    staleKvCacheKey
  )

  if (!staleKvCachedPayload) {
    return null
  }

  const response = jsonResponse(staleKvCachedPayload, 200, {
    "Cache-Control": TAG_CACHE_CONTROL,
  })
  await cacheEdgeResponse(staleEdgeCacheRequest, response)
  return response
}

function isTagStaleFallbackEligibleError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()

  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("unable to open") ||
    message.includes("cantopen") ||
    message.includes("closed") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("connection")
  )
}

function getCachedTagsVersion(databaseIdentity: string) {
  const cachedEntry = tagsVersionCache.get(databaseIdentity)

  if (!cachedEntry) {
    return null
  }

  if (cachedEntry.expiresAt <= Date.now()) {
    tagsVersionCache.delete(databaseIdentity)
    return null
  }

  return cachedEntry.version
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

function createVersionedEdgeCacheRequest(
  request: Request,
  options?: {
    tagsVersion?: string
  }
) {
  const url = new URL(request.url)
  url.searchParams.set("__cv", CATALOG_CACHE_VERSION)
  if (options?.tagsVersion) {
    url.searchParams.set("__tv", options.tagsVersion)
  }

  return new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
  })
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
  request: Request,
  versionToken = ""
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [
        CATALOG_CACHE_VERSION,
        scope,
        databaseIdentity,
        versionToken,
        request.url,
      ].join("\n")
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
