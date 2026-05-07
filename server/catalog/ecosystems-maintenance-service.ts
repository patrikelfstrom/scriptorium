import type { CatalogDatabaseClient } from "./database"
import {
  extractLastPublishedAtFromRawJson,
  normalizeOptionalString,
  shouldDeleteEcosystemsPackageRow,
} from "./ecosystems-normalization"
import type { PruneEcosystemsPackagesOptions } from "./ecosystems-types"

export async function pruneEcosystemsPackages(
  client: CatalogDatabaseClient,
  options: PruneEcosystemsPackagesOptions = {}
) {
  const result = await client.execute(`
    SELECT p.package_key, rep.raw_json
    FROM packages p
    JOIN raw_ecosystems_packages rep ON rep.package_key = p.package_key
    WHERE p.source_type = 'npm'
  `)

  const packageKeysToDelete = result.rows
    .filter((row) => shouldDeleteEcosystemsPackageRow(row.raw_json, options.now))
    .map((row) => String(row.package_key))

  if (packageKeysToDelete.length === 0) {
    return { deletedCount: 0 }
  }

  for (const batch of chunkValues(packageKeysToDelete, 100)) {
    const placeholders = batch.map(() => "?").join(", ")

    await client.execute({
      sql: `DELETE FROM packages WHERE package_key IN (${placeholders})`,
      args: batch,
    })
    await client.execute({
      sql: `DELETE FROM raw_ecosystems_packages WHERE package_key IN (${placeholders})`,
      args: batch,
    })
  }

  await client.execute(`
    DELETE FROM tag_aliases
    WHERE tag_id NOT IN (SELECT DISTINCT tag_id FROM package_tags)
  `)
  await client.execute(`
    DELETE FROM tags
    WHERE tag_id NOT IN (SELECT DISTINCT tag_id FROM package_tags)
  `)

  return {
    deletedCount: packageKeysToDelete.length,
  }
}

export async function backfillLastPublishedAtFromRawEcosystems(
  client: CatalogDatabaseClient
) {
  const result = await client.execute(`
    SELECT p.package_key, p.last_published_at, rep.raw_json
    FROM packages p
    JOIN raw_ecosystems_packages rep ON rep.package_key = p.package_key
    WHERE p.source_type = 'npm'
  `)

  let updatedCount = 0

  for (const row of result.rows) {
    const nextPublishedAt = extractLastPublishedAtFromRawJson(row.raw_json)
    const currentPublishedAt = normalizeOptionalString(row.last_published_at)

    if (!nextPublishedAt || nextPublishedAt === currentPublishedAt) {
      continue
    }

    await client.execute({
      sql: `
        UPDATE packages
        SET last_published_at = ?
        WHERE package_key = ?
      `,
      args: [nextPublishedAt, row.package_key],
    })

    updatedCount += 1
  }

  return {
    packageCount: result.rows.length,
    updatedCount,
  }
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = []

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }

  return chunks
}
