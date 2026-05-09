import {
  parseCatalogSearchParams,
  parseCatalogTagListParams,
} from "../shared/catalog"
import { createCatalogDatabaseClient } from "../server/catalog/database"
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
          return await handleTagsRequest(url, env)
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
  const client = createCatalogDatabaseClient(env)

  try {
    await ensureCatalogSchema(client)

    const payload = await searchCatalog(
      client,
      parseCatalogSearchParams(url.searchParams)
    )

    return jsonResponse(payload)
  } finally {
    client.close?.()
  }
}

async function handleTagsRequest(_url: URL, env: WorkerEnv) {
  const client = createCatalogDatabaseClient(env)

  try {
    await ensureCatalogSchema(client)

    const payload = await listCatalogTags(client, parseCatalogTagListParams())

    return jsonResponse(payload)
  } finally {
    client.close?.()
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  })
}
