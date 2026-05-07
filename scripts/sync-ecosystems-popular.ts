import { syncEcosystemsPopular } from "../server/catalog/admin-service"
import { loadDotEnvFile } from "../server/catalog/load-env"
import { createNodeCatalogDatabaseClient } from "../server/catalog/node-database"
import { ensureCatalogSchema } from "../server/catalog/schema"

loadDotEnvFile()

const client = createNodeCatalogDatabaseClient()

await ensureCatalogSchema(client)

try {
  const result = await syncEcosystemsPopular(client, {
    ecosystemsBaseUrl:
      process.env.ECOSYSTEMS_BASE_URL ?? "https://packages.ecosyste.ms/api/v1",
    fromAddress: "info@scriptorium.dev",
    userAgent: process.env.SCRIPTORIUM_USER_AGENT ?? "scriptorium/0.1.1",
    syncLimit: parsePositiveInteger(process.env.ECOSYSTEMS_SYNC_LIMIT, 1000),
    updatedAfter: createRollingUpdatedAfter(),
    onProgress(message) {
      console.log(`[${new Date().toISOString()}] ${message}`)
    },
  })

  console.log(`Synced ${result.syncedCount} ecosyste.ms packages into the catalog.`)
} finally {
  client.close?.()
}

function createRollingUpdatedAfter() {
  const updatedAfter = new Date()
  updatedAfter.setUTCDate(updatedAfter.getUTCDate() - 365)
  return updatedAfter.toISOString()
}

function parsePositiveInteger(value: string | undefined, fallbackValue: number) {
  if (!value) {
    return fallbackValue
  }

  const parsedValue = Number.parseInt(value, 10)
  return Number.isInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallbackValue
}
