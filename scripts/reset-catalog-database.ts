import { createNodeCatalogDatabaseClient } from "../server/catalog/node-database"
import { loadDotEnvFile } from "../server/catalog/load-env"
import { resetCatalogSchema } from "../server/catalog/schema"

loadDotEnvFile()

const client = createNodeCatalogDatabaseClient()

try {
  await resetCatalogSchema(client)
  console.log(
    "Catalog database reset complete. Run `pnpm sync:npm-catalog` to repopulate it."
  )
} finally {
  client.close?.()
}
