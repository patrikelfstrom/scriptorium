import {
  encodeCatalogCursor,
  tokenizeCatalogQuery,
  type CatalogSortColumn,
  type CatalogSortDirection,
  type CatalogSearchResponse,
  type CatalogTagListParams,
  type CatalogTagListResponse,
  type ParsedCatalogSearchParams,
} from "../../shared/catalog"
import type { CatalogDatabaseClient } from "./database"
import { normalizeTagValue } from "./tag-normalization"

export async function searchCatalog(
  client: CatalogDatabaseClient,
  params: ParsedCatalogSearchParams
): Promise<CatalogSearchResponse> {
  const queryTerms = tokenizeCatalogQuery(params.query)
  const normalizedTags = Array.from(
    new Set(
      params.tags
        .map((tag) => normalizeTagValue(tag))
        .filter((tag): tag is string => Boolean(tag))
    )
  )
  const { clauses, args } = buildSearchWhereClause(queryTerms, normalizedTags)
  const listArgs = [...args, params.limit + 1, params.offset]
  const orderByClause = getCatalogOrderByClause(params.sort, params.direction)

  const rowsResult = await client.execute({
    sql: `
      WITH merged_tags AS (
        SELECT package_name, tag_id FROM package_tags
        UNION
        SELECT package_name, tag_id FROM repository_tags
      ),
      filtered AS (
        SELECT
          p.package_name,
          p.repository_url,
          p.package_url,
          p.package_description,
          p.homepage_url,
          p.repository_stars,
          p.package_downloads,
          p.package_downloads_period,
          p.package_last_published_at,
          COALESCE((
            SELECT GROUP_CONCAT(ordered_tags.tag_id, ' ')
            FROM (
              SELECT mt.tag_id
              FROM merged_tags mt
              WHERE mt.package_name = p.package_name
              ORDER BY mt.tag_id ASC
            ) AS ordered_tags
          ), '') AS tags_sort_value
        FROM packages p
        ${clauses}
      )
      SELECT *
      FROM filtered
      ORDER BY ${orderByClause}
      LIMIT ? OFFSET ?
    `,
    args: listArgs,
  })

  const countResult = await client.execute({
    sql: `
      WITH merged_tags AS (
        SELECT package_name, tag_id FROM package_tags
        UNION
        SELECT package_name, tag_id FROM repository_tags
      )
      SELECT COUNT(*) AS total
      FROM packages p
      ${clauses}
    `,
    args,
  })

  const rows = rowsResult.rows
  const hasMore = rows.length > params.limit
  const visibleRows = rows.slice(0, params.limit)
  const tagMap = await fetchTagsForPackageNames(
    client,
    visibleRows.map((row) => String(row.package_name))
  )

  return {
    items: visibleRows.map((row) => ({
      packageName: String(row.package_name),
      repositoryUrl: normalizeNullableString(row.repository_url),
      packageUrl: String(row.package_url),
      packageDescription: normalizeNullableString(row.package_description),
      homepageUrl: normalizeNullableString(row.homepage_url),
      repositoryStars: normalizeNullableNumber(row.repository_stars),
      packageDownloads: normalizeNumber(row.package_downloads),
      packageDownloadsPeriod: normalizeNullableString(
        row.package_downloads_period
      ),
      packageLastPublishedAt: normalizeNullableString(
        row.package_last_published_at
      ),
      tags: tagMap.get(String(row.package_name)) ?? [],
    })),
    nextCursor: hasMore
      ? encodeCatalogCursor(params.offset + params.limit)
      : null,
    totalApprox: normalizeNumber(countResult.rows[0]?.total),
  }
}

export async function listCatalogTags(
  client: CatalogDatabaseClient,
  _params: CatalogTagListParams
): Promise<CatalogTagListResponse> {
  void _params

  const result = await client.execute({
    sql: `
      WITH merged_tags AS (
        SELECT package_name, tag_id FROM package_tags
        UNION
        SELECT package_name, tag_id FROM repository_tags
      )
      SELECT
        t.tag_id,
        t.label,
        COUNT(DISTINCT mt.package_name) AS package_count
      FROM tags t
      JOIN merged_tags mt ON mt.tag_id = t.tag_id
      GROUP BY t.tag_id, t.label
      ORDER BY package_count DESC, t.tag_id ASC
      LIMIT 500
    `,
  })

  return {
    items: result.rows.map((row) => ({
      id: String(row.tag_id),
      label: String(row.label),
      packageCount: normalizeNumber(row.package_count),
    })),
  }
}

function buildSearchWhereClause(queryTerms: string[], tags: string[]) {
  const clauses = ["WHERE 1 = 1"]
  const args: Array<string | number> = []

  for (const term of queryTerms) {
    clauses.push(
      `AND (
        LOWER(p.package_name) LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.package_description, '')) LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.repository_url, '')) LIKE '%' || ? || '%'
        OR EXISTS (
          SELECT 1
          FROM merged_tags mt_search
          WHERE mt_search.package_name = p.package_name
            AND mt_search.tag_id LIKE '%' || ? || '%'
        )
      )`
    )
    args.push(term, term, term, term)
  }

  if (tags.length > 0) {
    const placeholders = tags.map(() => "?").join(", ")
    clauses.push(
      `AND p.package_name IN (
        SELECT package_name
        FROM merged_tags
        WHERE tag_id IN (${placeholders})
        GROUP BY package_name
        HAVING COUNT(DISTINCT tag_id) = ?
      )`
    )
    args.push(...tags, tags.length)
  }

  return {
    clauses: clauses.join("\n"),
    args,
  }
}

function getCatalogOrderByClause(
  sort: CatalogSortColumn,
  direction: CatalogSortDirection
) {
  const normalizedDirection = direction.toUpperCase()

  switch (sort) {
    case "stars":
      return `COALESCE(repository_stars, 0) ${normalizedDirection}, LOWER(package_name) ASC`
    case "published":
      return `CASE WHEN package_last_published_at IS NULL OR package_last_published_at = '' THEN 1 ELSE 0 END ASC, package_last_published_at ${normalizedDirection}, LOWER(package_name) ASC`
    case "tags":
      return `LOWER(tags_sort_value) ${normalizedDirection}, LOWER(package_name) ASC`
    case "name":
    default:
      return `LOWER(package_name) ${normalizedDirection}`
  }
}

async function fetchTagsForPackageNames(
  client: CatalogDatabaseClient,
  packageNames: string[]
) {
  const tagMap = new Map<string, string[]>()

  if (packageNames.length === 0) {
    return tagMap
  }

  const placeholders = packageNames.map(() => "?").join(", ")
  const result = await client.execute({
    sql: `
      WITH merged_tags AS (
        SELECT package_name, tag_id FROM package_tags
        UNION
        SELECT package_name, tag_id FROM repository_tags
      )
      SELECT DISTINCT package_name, tag_id
      FROM merged_tags
      WHERE package_name IN (${placeholders})
      ORDER BY package_name ASC, tag_id ASC
    `,
    args: packageNames,
  })

  for (const row of result.rows) {
    const packageName = String(row.package_name)
    const currentTags = tagMap.get(packageName) ?? []
    currentTags.push(String(row.tag_id))
    tagMap.set(packageName, currentTags)
  }

  return tagMap
}

function normalizeNullableString(value: unknown) {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeNumber(value: unknown) {
  return Number.isFinite(value) ? Math.trunc(value as number) : 0
}

function normalizeNullableNumber(value: unknown) {
  return Number.isFinite(value) ? Math.trunc(value as number) : null
}
