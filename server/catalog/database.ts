import { createClient, type Client } from "@libsql/client"

export type CatalogDatabaseClient = Client

export type CatalogDatabaseBindings = {
  SCRIPTORIUM_DATA_DIR?: string
  TURSO_DATABASE_URL?: string
  TURSO_AUTH_TOKEN?: string
}

export function getCatalogDatabaseUrl(bindings: CatalogDatabaseBindings) {
  if (bindings.TURSO_DATABASE_URL) {
    return bindings.TURSO_DATABASE_URL
  }

  return resolveLocalDatabaseUrl(bindings)
}

export function getCatalogDatabaseIdentity(bindings: CatalogDatabaseBindings) {
  const databaseUrl = getCatalogDatabaseUrl(bindings)

  if (!databaseUrl) {
    throw new Error(
      "TURSO_DATABASE_URL is required for this runtime. Use a Node-based local runtime or set SCRIPTORIUM_DATA_DIR for local fallback."
    )
  }

  return databaseUrl
}

export function createCatalogDatabaseClient(
  bindings: CatalogDatabaseBindings
): CatalogDatabaseClient {
  const databaseUrl = getCatalogDatabaseUrl(bindings)

  if (!databaseUrl) {
    throw new Error(
      "TURSO_DATABASE_URL is required for this runtime. Use a Node-based local runtime or set SCRIPTORIUM_DATA_DIR for local fallback."
    )
  }

  if (!bindings.TURSO_DATABASE_URL) {
    return createClient({
      url: databaseUrl,
    })
  }

  return createClient({
    url: databaseUrl,
    authToken: bindings.TURSO_AUTH_TOKEN,
  })
}

function resolveLocalDatabaseUrl(bindings: CatalogDatabaseBindings) {
  const runtimeProcess = globalThis as {
    process?: {
      cwd?: () => string
    }
  }
  const dataDirectory =
    bindings.SCRIPTORIUM_DATA_DIR ??
    (typeof runtimeProcess.process?.cwd === "function"
      ? `${runtimeProcess.process.cwd()}/.data`
      : undefined)

  return dataDirectory ? `file:${dataDirectory}/scriptorium.db` : undefined
}
