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
  const { clauses, args } = buildSearchWhereClause(
    queryTerms,
    normalizedTags,
    params.source
  )
  const listArgs = [...args, params.limit + 1, params.offset]
  const orderByClause = getCatalogOrderByClause(params.sort, params.direction)

  const rowsResult = await client.execute({
    sql: `
      WITH filtered AS (
        SELECT
          p.package_key,
          p.source_type,
          p.source_name,
          p.display_name,
          p.description,
          p.primary_url,
          p.repository_name,
          p.npm_package_name,
          p.stars,
          p.downloads,
          p.downloads_period,
          p.dependent_packages_count,
          COALESCE((
            SELECT GROUP_CONCAT(ordered_tags.tag_id, ' ')
            FROM (
              SELECT pt.tag_id
              FROM package_tags pt
              WHERE pt.package_key = p.package_key
              ORDER BY pt.tag_id ASC
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
      SELECT COUNT(*) AS total
      FROM packages p
      ${clauses}
    `,
    args,
  })

  const rows = rowsResult.rows
  const hasMore = rows.length > params.limit
  const visibleRows = rows.slice(0, params.limit)
  const tagMap = await fetchTagsForPackageKeys(
    client,
    visibleRows.map((row) => String(row.package_key))
  )

  return {
    items: visibleRows.map((row) => ({
      packageKey: String(row.package_key),
      sourceType: String(row.source_type),
      sourceName: String(row.source_name),
      name: String(row.display_name),
      description: normalizeNullableString(row.description),
      url: normalizeNullableString(row.primary_url),
      repositoryName: normalizeNullableString(row.repository_name),
      npmPackageName: normalizeNullableString(row.npm_package_name),
      stars: normalizeNullableNumber(row.stars),
      downloads: normalizeNumber(row.downloads),
      downloadsPeriod: normalizeNullableString(row.downloads_period),
      dependentPackagesCount: normalizeNumber(row.dependent_packages_count),
      tags: tagMap.get(String(row.package_key)) ?? [],
    })),
    nextCursor: hasMore ? encodeCatalogCursor(params.offset + params.limit) : null,
    totalApprox: normalizeNumber(countResult.rows[0]?.total),
  }
}

export async function listCatalogTags(
  client: CatalogDatabaseClient,
  params: CatalogTagListParams
): Promise<CatalogTagListResponse> {
  const sourceClause = params.source ? "AND p.source_type = ?" : ""
  const result = await client.execute({
    sql: `
      SELECT
        t.tag_id,
        t.label,
        COUNT(DISTINCT pt.package_key) AS package_count
      FROM tags t
      JOIN package_tags pt ON pt.tag_id = t.tag_id
      JOIN packages p ON p.package_key = pt.package_key
      WHERE p.is_active = 1
      ${sourceClause}
      GROUP BY t.tag_id, t.label
      ORDER BY package_count DESC, t.tag_id ASC
      LIMIT 500
    `,
    args: params.source ? [params.source] : [],
  })

  return {
    items: result.rows.map((row) => ({
      id: String(row.tag_id),
      label: String(row.label),
      packageCount: normalizeNumber(row.package_count),
    })),
  }
}

function buildSearchWhereClause(
  queryTerms: string[],
  tags: string[],
  source?: string
) {
  const clauses = ["WHERE p.is_active = 1"]
  const args: Array<string | number> = []

  if (source) {
    clauses.push("AND p.source_type = ?")
    args.push(source)
  }

  for (const term of queryTerms) {
    clauses.push(
      `AND (
        p.search_name LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.description, '')) LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.repository_name, '')) LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.npm_package_name, '')) LIKE '%' || ? || '%'
        OR EXISTS (
          SELECT 1
          FROM package_tags pt_search
          WHERE pt_search.package_key = p.package_key
            AND pt_search.tag_id LIKE '%' || ? || '%'
        )
      )`
    )
    args.push(term, term, term, term, term)
  }

  if (tags.length > 0) {
    const placeholders = tags.map(() => "?").join(", ")
    clauses.push(
      `AND p.package_key IN (
        SELECT package_key
        FROM package_tags
        WHERE tag_id IN (${placeholders})
        GROUP BY package_key
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
      return `COALESCE(stars, 0) ${normalizedDirection}, LOWER(display_name) ASC, package_key ASC`
    case "tags":
      return `LOWER(tags_sort_value) ${normalizedDirection}, LOWER(display_name) ASC, package_key ASC`
    case "name":
    default:
      return `LOWER(display_name) ${normalizedDirection}, package_key ASC`
  }
}

async function fetchTagsForPackageKeys(
  client: CatalogDatabaseClient,
  packageKeys: string[]
) {
  const tagMap = new Map<string, string[]>()

  if (packageKeys.length === 0) {
    return tagMap
  }

  const placeholders = packageKeys.map(() => "?").join(", ")
  const result = await client.execute({
    sql: `
      SELECT DISTINCT package_key, tag_id
      FROM package_tags
      WHERE package_key IN (${placeholders})
      ORDER BY package_key ASC, tag_id ASC
    `,
    args: packageKeys,
  })

  for (const row of result.rows) {
    const packageKey = String(row.package_key)
    const currentTags = tagMap.get(packageKey) ?? []
    currentTags.push(String(row.tag_id))
    tagMap.set(packageKey, currentTags)
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
