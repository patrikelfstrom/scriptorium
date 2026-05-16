import type { InStatement } from "@libsql/client"

import type { CatalogDatabaseClient } from "./database"
import { createTagLabel, normalizeTagValue } from "./tag-normalization"

export type CatalogPackageRecord = {
  packageName: string
  repositoryUrl: string | null
  packageUrl: string
  packageDescription: string | null
  homepageUrl: string | null
  repositoryStars: number | null
  packageDownloads: number
  packageDownloadsPeriod: string | null
  packageLastPublishedAt: string | null
  lastSyncedAt: string
  preserveRepositoryUrlOnNull?: boolean
  preservePackageDescriptionOnNull?: boolean
  preserveHomepageUrlOnNull?: boolean
  preserveRepositoryStarsOnNull?: boolean
}

export function createPackageUrl(packageName: string) {
  return `https://www.npmjs.com/package/${encodePackageNameForPage(packageName)}`
}

export function encodePackageNameForPage(packageName: string) {
  return packageName
    .split("/")
    .map((segment, index) =>
      index === 0 && segment.startsWith("@")
        ? `@${encodeURIComponent(segment.slice(1))}`
        : encodeURIComponent(segment)
    )
    .join("/")
}

export async function upsertPackage(
  client: CatalogDatabaseClient,
  packageRecord: CatalogPackageRecord
) {
  await client.batch(
    [
      createUpsertPackageStatement(packageRecord),
      ...createRefreshPackageSearchStatements(packageRecord.packageName),
    ],
    "write"
  )
}

export async function replacePackageTags(
  client: CatalogDatabaseClient,
  tableName: "package_tags" | "repository_tags",
  packageName: string,
  rawTags: string[]
) {
  await client.batch(
    [
      ...createReplaceTagStatements(tableName, packageName, rawTags),
      ...createRefreshPackageSearchStatements(packageName),
    ],
    "write"
  )
}

export function createUpsertPackageStatement(
  packageRecord: CatalogPackageRecord
): InStatement {
  return {
    sql: `
      INSERT INTO packages (
        package_name,
        repository_url,
        package_url,
        package_description,
        homepage_url,
        repository_stars,
        package_downloads,
        package_downloads_period,
        package_last_published_at,
        last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_name) DO UPDATE SET
        repository_url = CASE
          WHEN ? = 1 AND excluded.repository_url IS NULL
            THEN packages.repository_url
          ELSE excluded.repository_url
        END,
        package_url = excluded.package_url,
        package_description = CASE
          WHEN ? = 1 AND excluded.package_description IS NULL
            THEN packages.package_description
          ELSE excluded.package_description
        END,
        homepage_url = CASE
          WHEN ? = 1 AND excluded.homepage_url IS NULL
            THEN packages.homepage_url
          ELSE excluded.homepage_url
        END,
        repository_stars = CASE
          WHEN ? = 1 AND excluded.repository_stars IS NULL
            THEN packages.repository_stars
          ELSE excluded.repository_stars
        END,
        package_downloads = excluded.package_downloads,
        package_downloads_period = excluded.package_downloads_period,
        package_last_published_at = excluded.package_last_published_at,
        last_synced_at = excluded.last_synced_at
    `,
    args: [
      packageRecord.packageName,
      packageRecord.repositoryUrl,
      packageRecord.packageUrl,
      packageRecord.packageDescription,
      packageRecord.homepageUrl,
      packageRecord.repositoryStars,
      packageRecord.packageDownloads,
      packageRecord.packageDownloadsPeriod,
      packageRecord.packageLastPublishedAt,
      packageRecord.lastSyncedAt,
      packageRecord.preserveRepositoryUrlOnNull ? 1 : 0,
      packageRecord.preservePackageDescriptionOnNull ? 1 : 0,
      packageRecord.preserveHomepageUrlOnNull ? 1 : 0,
      packageRecord.preserveRepositoryStarsOnNull ? 1 : 0,
    ],
  }
}

export function createReplaceTagStatements(
  tableName: "package_tags" | "repository_tags",
  packageName: string,
  rawTags: string[]
): InStatement[] {
  const statements: InStatement[] = [
    {
      sql: `DELETE FROM ${tableName} WHERE package_name = ?`,
      args: [packageName],
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
        INSERT OR IGNORE INTO ${tableName} (package_name, tag_id, raw_value)
        VALUES (?, ?, ?)
      `,
      args: [packageName, tagId, normalizedRawValue],
    })
  }

  return statements
}

export function createRefreshPackageSearchStatements(packageName: string) {
  return createRefreshPackageSearchStatementsForPackages([packageName])
}

export function createRefreshPackageSearchStatementsForPackages(
  packageNames: string[]
) {
  const uniquePackageNames = Array.from(new Set(packageNames))

  if (uniquePackageNames.length === 0) {
    return [] satisfies InStatement[]
  }

  const placeholders = uniquePackageNames.map(() => "?").join(", ")

  return [
    {
      sql: `DELETE FROM package_search_fts WHERE package_name IN (${placeholders})`,
      args: uniquePackageNames,
    },
    {
      sql: `
        INSERT INTO package_search_fts (package_name, search_text)
        SELECT
          p.package_name,
          ${PACKAGE_SEARCH_TEXT_SQL}
        FROM packages p
        WHERE p.package_name IN (${placeholders})
      `,
      args: uniquePackageNames,
    },
  ] satisfies InStatement[]
}

export function createRebuildPackageSearchStatements(): InStatement[] {
  return [
    {
      sql: `DELETE FROM package_search_fts`,
    },
    {
      sql: `
        INSERT INTO package_search_fts (package_name, search_text)
        SELECT
          p.package_name,
          ${PACKAGE_SEARCH_TEXT_SQL}
        FROM packages p
      `,
    },
  ]
}

const PACKAGE_SEARCH_TEXT_SQL = `
  LOWER(
    TRIM(
      COALESCE(p.package_name, '') || ' ' ||
      COALESCE(p.package_description, '') || ' ' ||
      COALESCE(p.repository_url, '') || ' ' ||
      COALESCE((
        SELECT GROUP_CONCAT(tag_value, ' ')
        FROM (
          SELECT DISTINCT tag_value
          FROM (
            SELECT tag_id AS tag_value
            FROM package_tags
            WHERE package_name = p.package_name
            UNION ALL
            SELECT raw_value AS tag_value
            FROM package_tags
            WHERE package_name = p.package_name
            UNION ALL
            SELECT tag_id AS tag_value
            FROM repository_tags
            WHERE package_name = p.package_name
            UNION ALL
            SELECT raw_value AS tag_value
            FROM repository_tags
            WHERE package_name = p.package_name
          )
        )
      ), '')
    )
  )
`

function normalizeOptionalString(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
