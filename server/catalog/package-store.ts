import type { InStatement } from "@libsql/client"

import type { CatalogDatabaseClient } from "./database"
import { createTagLabel, normalizeTagValue } from "./tag-normalization"

export type CatalogPackageRecord = {
  packageKey: string
  sourceType: string
  sourceName: string
  displayName: string
  searchName: string
  description: string | null
  homepageUrl: string | null
  primaryUrl: string | null
  repositoryName: string | null
  npmPackageName: string | null
  publishedAt: string | null
  stars: number | null
  downloads: number
  downloadsPeriod: string | null
  dependentPackagesCount: number
  rawEcosystemsFetchedAt: string
  npmSyncedAt: string | null
  githubSyncedAt: string | null
  isActive: number
}

export function createPackageKey(sourceType: string, sourceName: string) {
  return `${sourceType}:${sourceName}`
}

export function createPrimaryUrl(sourceType: string, sourceName: string) {
  if (sourceType === "npm") {
    return `https://www.npmjs.com/package/${encodePackageNameForPage(sourceName)}`
  }

  if (sourceType === "gh") {
    return `https://github.com/${sourceName}`
  }

  return null
}

export function encodePackageNameForPage(packageName: string) {
  return packageName.split("/").map(encodeURIComponent).join("/")
}

export async function upsertPackage(
  client: CatalogDatabaseClient,
  packageRecord: CatalogPackageRecord
) {
  await client.execute(createUpsertPackageStatement(packageRecord))
}

export async function replacePackageTags(
  client: CatalogDatabaseClient,
  packageKey: string,
  source: string,
  rawTags: string[]
) {
  await client.batch(
    createReplacePackageTagsStatements(packageKey, source, rawTags),
    "write"
  )
}

export function createUpsertPackageStatement(
  packageRecord: CatalogPackageRecord
): InStatement {
  return {
    sql: `
      INSERT INTO packages (
        package_key,
        source_type,
        source_name,
        display_name,
        search_name,
        description,
        homepage_url,
        primary_url,
        repository_name,
        npm_package_name,
        last_published_at,
        stars,
        downloads,
        downloads_period,
        dependent_packages_count,
        raw_ecosystems_fetched_at,
        npm_synced_at,
        github_synced_at,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_key) DO UPDATE SET
        display_name = excluded.display_name,
        search_name = excluded.search_name,
        description = COALESCE(excluded.description, packages.description),
        homepage_url = COALESCE(excluded.homepage_url, packages.homepage_url),
        primary_url = CASE
          WHEN excluded.primary_url IS NULL OR excluded.primary_url = ''
            THEN packages.primary_url
          ELSE excluded.primary_url
        END,
        repository_name = COALESCE(excluded.repository_name, packages.repository_name),
        npm_package_name = COALESCE(excluded.npm_package_name, packages.npm_package_name),
        last_published_at = COALESCE(excluded.last_published_at, packages.last_published_at),
        stars = COALESCE(excluded.stars, packages.stars),
        downloads = excluded.downloads,
        downloads_period = COALESCE(excluded.downloads_period, packages.downloads_period),
        dependent_packages_count = excluded.dependent_packages_count,
        raw_ecosystems_fetched_at = excluded.raw_ecosystems_fetched_at,
        npm_synced_at = COALESCE(excluded.npm_synced_at, packages.npm_synced_at),
        github_synced_at = COALESCE(excluded.github_synced_at, packages.github_synced_at),
        is_active = excluded.is_active
    `,
    args: [
      packageRecord.packageKey,
      packageRecord.sourceType,
      packageRecord.sourceName,
      packageRecord.displayName,
      packageRecord.searchName,
      packageRecord.description,
      packageRecord.homepageUrl,
      packageRecord.primaryUrl ?? "",
      packageRecord.repositoryName,
      packageRecord.npmPackageName,
      packageRecord.publishedAt,
      packageRecord.stars,
      packageRecord.downloads,
      packageRecord.downloadsPeriod,
      packageRecord.dependentPackagesCount,
      packageRecord.rawEcosystemsFetchedAt,
      packageRecord.npmSyncedAt,
      packageRecord.githubSyncedAt,
      packageRecord.isActive,
    ],
  }
}

export function createReplacePackageTagsStatements(
  packageKey: string,
  source: string,
  rawTags: string[]
): InStatement[] {
  const statements: InStatement[] = [
    {
      sql: "DELETE FROM package_tags WHERE package_key = ? AND source = ?",
      args: [packageKey, source],
    },
  ]

  for (const rawValue of rawTags) {
    const normalizedRawValue = normalizeOptionalString(rawValue)
    const tagId = normalizedRawValue
      ? normalizeTagValue(normalizedRawValue)
      : undefined

    if (!normalizedRawValue || !tagId) {
      continue
    }

    statements.push({
      sql: `
        INSERT INTO tags (tag_id, label)
        VALUES (?, ?)
        ON CONFLICT(tag_id) DO UPDATE SET label = excluded.label
      `,
      args: [tagId, createTagLabel(tagId)],
    })

    statements.push({
      sql: `
        INSERT INTO tag_aliases (alias, tag_id)
        VALUES (?, ?)
        ON CONFLICT(alias) DO UPDATE SET tag_id = excluded.tag_id
      `,
      args: [normalizedRawValue.toLowerCase(), tagId],
    })

    statements.push({
      sql: `
        INSERT OR IGNORE INTO package_tags (package_key, tag_id, source, raw_value)
        VALUES (?, ?, ?, ?)
      `,
      args: [packageKey, tagId, source, normalizedRawValue],
    })
  }

  return statements
}

function normalizeOptionalString(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
