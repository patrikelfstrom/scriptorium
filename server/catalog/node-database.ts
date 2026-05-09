import { mkdirSync } from "node:fs"
import path from "node:path"

import { createClient } from "@libsql/client"

import type { CatalogDatabaseBindings, CatalogDatabaseClient } from "./database"

export type NodeCatalogDatabaseBindings = CatalogDatabaseBindings & {
  SCRIPTORIUM_DATA_DIR?: string
}

export type NodeCatalogDatabaseOptions = {
  cwd?: string
  env?: NodeCatalogDatabaseBindings
  allowLocalFallback?: boolean
}

export function createNodeCatalogDatabaseClient(
  options: NodeCatalogDatabaseOptions = {}
): CatalogDatabaseClient {
  const config = resolveNodeCatalogDatabaseConfig(options)

  return createClient({
    url: config.url,
    authToken: config.authToken,
  })
}

export function resolveNodeCatalogDatabaseConfig(
  options: NodeCatalogDatabaseOptions = {}
) {
  const env = {
    ...readProcessEnv(),
    ...options.env,
  }

  if (env.TURSO_DATABASE_URL) {
    return {
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }
  }

  if (options.allowLocalFallback === false) {
    throw new Error(
      "TURSO_DATABASE_URL is required when local fallback is disabled."
    )
  }

  const baseDirectory =
    env.SCRIPTORIUM_DATA_DIR ??
    path.resolve(options.cwd ?? process.cwd(), ".data")

  mkdirSync(baseDirectory, { recursive: true })

  return {
    url: `file:${path.join(baseDirectory, "scriptorium.db")}`,
    authToken: undefined,
  }
}

function readProcessEnv(): NodeCatalogDatabaseBindings {
  if (typeof process === "undefined") {
    return {}
  }

  return {
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    SCRIPTORIUM_DATA_DIR: process.env.SCRIPTORIUM_DATA_DIR,
  }
}
