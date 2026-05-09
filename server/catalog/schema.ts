import type { InStatement } from "@libsql/client"

import type { CatalogDatabaseClient } from "./database"

const schemaStatements: InStatement[] = [
  `
    CREATE TABLE IF NOT EXISTS raw_ecosystems_packages (
      package_key TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      downloads INTEGER NOT NULL,
      downloads_period TEXT,
      dependent_packages_count INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS packages (
      package_key TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      search_name TEXT NOT NULL,
      description TEXT,
      homepage_url TEXT,
      primary_url TEXT NOT NULL,
      repository_name TEXT,
      npm_package_name TEXT,
      last_published_at TEXT,
      stars INTEGER,
      downloads INTEGER NOT NULL,
      downloads_period TEXT,
      dependent_packages_count INTEGER NOT NULL,
      raw_ecosystems_fetched_at TEXT NOT NULL,
      npm_synced_at TEXT,
      github_synced_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
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
      package_key TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      source TEXT NOT NULL,
      raw_value TEXT NOT NULL,
      PRIMARY KEY (package_key, tag_id, source, raw_value),
      FOREIGN KEY (package_key) REFERENCES packages(package_key) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS packages_source_type_idx
    ON packages(source_type, is_active)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_search_name_idx
    ON packages(search_name)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_stars_idx
    ON packages(stars DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_downloads_idx
    ON packages(downloads DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS packages_dependent_packages_count_idx
    ON packages(dependent_packages_count DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS package_tags_tag_id_idx
    ON package_tags(tag_id, package_key)
  `,
  `
    CREATE INDEX IF NOT EXISTS package_tags_package_key_idx
    ON package_tags(package_key, tag_id)
  `,
]

const destructiveResetStatements: InStatement[] = [
  "DROP INDEX IF EXISTS package_tags_package_key_idx",
  "DROP INDEX IF EXISTS package_tags_tag_id_idx",
  "DROP INDEX IF EXISTS packages_dependent_packages_count_idx",
  "DROP INDEX IF EXISTS packages_downloads_idx",
  "DROP INDEX IF EXISTS packages_stars_idx",
  "DROP INDEX IF EXISTS packages_search_name_idx",
  "DROP INDEX IF EXISTS packages_source_type_idx",
  "DROP INDEX IF EXISTS packages_hits_idx",
  "DROP TABLE IF EXISTS package_tags",
  "DROP TABLE IF EXISTS tag_aliases",
  "DROP TABLE IF EXISTS tags",
  "DROP TABLE IF EXISTS packages",
  "DROP TABLE IF EXISTS raw_ecosystems_packages",
  "DROP TABLE IF EXISTS raw_jsdelivr_packages",
]

export async function ensureCatalogSchema(client: CatalogDatabaseClient) {
  for (const statement of schemaStatements) {
    await client.execute(statement)
  }

  await ensurePackagesColumn(client, "homepage_url", "TEXT")
  await ensurePackagesColumn(client, "last_published_at", "TEXT")
}

export async function resetCatalogSchema(client: CatalogDatabaseClient) {
  for (const statement of destructiveResetStatements) {
    await client.execute(statement)
  }

  await ensureCatalogSchema(client)
}

async function ensurePackagesColumn(
  client: CatalogDatabaseClient,
  columnName: string,
  columnType: string
) {
  const result = await client.execute("PRAGMA table_info(packages)")
  const existingColumns = new Set(result.rows.map((row) => String(row.name)))

  if (existingColumns.has(columnName)) {
    return
  }

  await client.execute(
    `ALTER TABLE packages ADD COLUMN ${columnName} ${columnType}`
  )
}
