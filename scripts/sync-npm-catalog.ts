import { syncNpmCatalog } from "../server/catalog/admin-service"
import { loadDotEnvFile } from "../server/catalog/load-env"
import { createNodeCatalogDatabaseClient } from "../server/catalog/node-database"
import { ensureCatalogSchema } from "../server/catalog/schema"

loadDotEnvFile()

const client = createNodeCatalogDatabaseClient()

await ensureCatalogSchema(client)

try {
  const githubToken = process.env.GITHUB_TOKEN?.trim()

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required for npm catalog sync.")
  }

  const result = await syncNpmCatalog(client, {
    githubToken,
    syncLimit: parsePositiveInteger(process.env.NPM_SYNC_LIMIT, 10_000),
    npmRegistryBaseUrl: process.env.NPM_REGISTRY_BASE_URL,
    githubGraphqlUrl: process.env.GITHUB_GRAPHQL_URL,
    onProgress(message) {
      console.log(`[${new Date().toISOString()}] ${message}`)
    },
  })

  console.log(`Synced ${result.syncedCount} npm packages into the catalog.`)
} finally {
  await client.close?.()
}

function parsePositiveInteger(
  value: string | undefined,
  fallbackValue: number
) {
  if (!value) {
    return fallbackValue
  }

  const parsedValue = Number.parseInt(value, 10)
  return Number.isInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallbackValue
}
