import type { InStatement } from "@libsql/client"

import type { CatalogDatabaseClient } from "./database"
import { createRebuildPackageSearchStatements } from "./package-store"

const EXPECTED_TABLE_COLUMNS = {
  packages: [
    "package_name",
    "repository_url",
    "package_url",
    "package_description",
    "homepage_url",
    "repository_stars",
    "package_downloads",
    "package_downloads_period",
    "package_last_published_at",
    "last_synced_at",
  ],
  package_tags: ["package_name", "tag_id", "raw_value"],
  repository_tags: ["package_name", "tag_id", "raw_value"],
  tags: ["tag_id", "label"],
  tag_aliases: ["alias", "tag_id"],
} as const

const schemaStatements: InStatement[] = [
  `
    CREATE TABLE IF NOT EXISTS packages (
      package_name TEXT PRIMARY KEY,
      repository_url TEXT,
      package_url TEXT NOT NULL,
      package_description TEXT,
      homepage_url TEXT,
      repository_stars INTEGER,
      package_downloads INTEGER NOT NULL,
      package_downloads_period TEXT,
      package_last_published_at TEXT,
      last_synced_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS tags (
      tag_id TEXT PRIMARY KEY,
      label TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS package_tags (
      package_name TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      raw_value TEXT NOT NULL,
      PRIMARY KEY (package_name, tag_id, raw_value),
      FOREIGN KEY (package_name) REFERENCES packages(package_name) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS repository_tags (
      package_name TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      raw_value TEXT NOT NULL,
      PRIMARY KEY (package_name, tag_id, raw_value),
      FOREIGN KEY (package_name) REFERENCES packages(package_name) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS tag_aliases (
      alias TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL,
      FOREIGN KEY (tag_id) REFERENCES tags(tag_id) ON DELETE CASCADE
    )
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS package_search_fts
    USING fts5(
      package_name UNINDEXED,
      search_text,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_downloads_idx
    ON packages(package_downloads DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_name_nocase_idx
    ON packages(package_name COLLATE NOCASE)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_repository_stars_name_idx
    ON packages(repository_stars DESC, package_name COLLATE NOCASE)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_last_published_at_name_idx
    ON packages(package_last_published_at DESC, package_name COLLATE NOCASE)
  `,
  `
    CREATE INDEX IF NOT EXISTS package_tags_tag_id_idx
    ON package_tags(tag_id, package_name)
  `,
  `
    CREATE INDEX IF NOT EXISTS package_tags_package_name_idx
    ON package_tags(package_name, tag_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS repository_tags_tag_id_idx
    ON repository_tags(tag_id, package_name)
  `,
  `
    CREATE INDEX IF NOT EXISTS repository_tags_package_name_idx
    ON repository_tags(package_name, tag_id)
  `,
]

const obsoleteIndexDropStatements: InStatement[] = [
  "DROP INDEX IF EXISTS packages_package_name_idx",
  "DROP INDEX IF EXISTS packages_last_published_at_idx",
  "DROP INDEX IF EXISTS packages_repository_stars_idx",
]

const destructiveResetStatements: InStatement[] = [
  "DROP INDEX IF EXISTS repository_tags_package_name_idx",
  "DROP INDEX IF EXISTS repository_tags_tag_id_idx",
  "DROP INDEX IF EXISTS package_tags_package_name_idx",
  "DROP INDEX IF EXISTS package_tags_tag_id_idx",
  "DROP INDEX IF EXISTS packages_last_published_at_name_idx",
  "DROP INDEX IF EXISTS packages_repository_stars_name_idx",
  "DROP INDEX IF EXISTS packages_name_nocase_idx",
  "DROP INDEX IF EXISTS packages_package_name_idx",
  "DROP INDEX IF EXISTS packages_last_published_at_idx",
  "DROP INDEX IF EXISTS packages_repository_stars_idx",
  "DROP INDEX IF EXISTS packages_downloads_idx",
  "DROP INDEX IF EXISTS packages_dependent_packages_count_idx",
  "DROP INDEX IF EXISTS packages_stars_idx",
  "DROP INDEX IF EXISTS packages_search_name_idx",
  "DROP INDEX IF EXISTS packages_source_type_idx",
  "DROP INDEX IF EXISTS packages_hits_idx",
  "DROP TABLE IF EXISTS repository_tags",
  "DROP TABLE IF EXISTS package_tags",
  "DROP TABLE IF EXISTS package_search_fts",
  "DROP TABLE IF EXISTS tag_aliases",
  "DROP TABLE IF EXISTS tags",
  "DROP TABLE IF EXISTS packages",
  "DROP TABLE IF EXISTS raw_ecosystems_packages",
  "DROP TABLE IF EXISTS raw_jsdelivr_packages",
]

export async function ensureCatalogSchema(client: CatalogDatabaseClient) {
  if (await hasLegacyCatalogSchema(client)) {
    await applyStatements(client, destructiveResetStatements)
  }

  await applyStatements(client, obsoleteIndexDropStatements)
  await applyStatements(client, schemaStatements)
  await applyStatements(client, createRebuildPackageSearchStatements())
}

export async function resetCatalogSchema(client: CatalogDatabaseClient) {
  await applyStatements(client, destructiveResetStatements)
  await applyStatements(client, schemaStatements)
  await applyStatements(client, createRebuildPackageSearchStatements())
}

async function applyStatements(
  client: CatalogDatabaseClient,
  statements: InStatement[]
) {
  if (statements.length === 0) {
    return
  }

  await client.batch(statements, "write")
}

async function hasLegacyCatalogSchema(client: CatalogDatabaseClient) {
  const tables = await Promise.all(
    Object.entries(EXPECTED_TABLE_COLUMNS).map(
      async ([tableName, expectedColumns]) => ({
        currentColumns: await getTableColumns(client, tableName),
        expectedColumns,
      })
    )
  )

  for (const { currentColumns, expectedColumns } of tables) {
    if (currentColumns === null) {
      continue
    }

    const currentColumnSet = new Set(currentColumns)

    if (
      currentColumns.length !== expectedColumns.length ||
      expectedColumns.some((column) => !currentColumnSet.has(column))
    ) {
      return true
    }
  }

  return false
}

async function getTableColumns(
  client: CatalogDatabaseClient,
  tableName: string
) {
  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [tableName],
  })

  if (result.rows.length === 0) {
    return null
  }

  const columns = await client.execute(`PRAGMA table_info(${tableName})`)
  return columns.rows.map((row) => String(row.name))
}
