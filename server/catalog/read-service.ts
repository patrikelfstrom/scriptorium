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
import { createVisiblePackageSql } from "./package-removal"
import { normalizeTagValue } from "./tag-normalization"

export async function searchCatalog(
  client: CatalogDatabaseClient,
  params: ParsedCatalogSearchParams
): Promise<CatalogSearchResponse> {
  const queryTerms = tokenizeCatalogQuery(params.query)
  const normalizedTags = Array.from(
    new Set(
      params.tags.flatMap((tag) => {
        const normalizedTag = normalizeTagValue(tag)
        return normalizedTag ? [normalizedTag] : []
      })
    )
  )
  const orderByClause = getCatalogOrderByClause(params.sort, params.direction)
  let searchDefinition = buildSearchWhereClause(
    queryTerms,
    normalizedTags,
    true
  )
  let packageNames: string[]

  try {
    packageNames = await fetchVisiblePackageNames(
      client,
      params,
      searchDefinition.clauses,
      searchDefinition.args,
      orderByClause
    )
  } catch (error) {
    if (!isMissingPackageSearchFtsError(error)) {
      throw error
    }

    searchDefinition = buildSearchWhereClause(queryTerms, normalizedTags, false)
    packageNames = await fetchVisiblePackageNames(
      client,
      params,
      searchDefinition.clauses,
      searchDefinition.args,
      orderByClause
    )
  }

  const hasMore = packageNames.length > params.limit
  const visiblePackageNames = packageNames.slice(0, params.limit)
  const [packageMap, tagMap, totalApprox] = await Promise.all([
    fetchPackagesByName(client, visiblePackageNames),
    fetchTagsForPackageNames(client, visiblePackageNames),
    resolveTotalApproximation(
      client,
      params,
      searchDefinition.hasFilters,
      visiblePackageNames.length,
      hasMore
    ),
  ])

  return {
    items: visiblePackageNames.flatMap((packageName) => {
      const row = packageMap.get(packageName)

      if (!row) {
        return []
      }

      return [
        {
          packageName,
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
          tags: tagMap.get(packageName) ?? [],
        },
      ]
    }),
    nextCursor: hasMore
      ? encodeCatalogCursor(params.offset + params.limit)
      : null,
    totalApprox,
  }
}

export async function listCatalogTags(
  client: CatalogDatabaseClient,
  _params: CatalogTagListParams
): Promise<CatalogTagListResponse> {
  void _params

  const result = await client.execute({
    sql: `
      WITH visible_tag_pairs AS (
        SELECT DISTINCT pt.package_name, pt.tag_id
        FROM package_tags pt
        JOIN packages p ON p.package_name = pt.package_name
        WHERE ${createVisiblePackageSql("p")}
        UNION
        SELECT DISTINCT rt.package_name, rt.tag_id
        FROM repository_tags rt
        JOIN packages p ON p.package_name = rt.package_name
        WHERE ${createVisiblePackageSql("p")}
      )
      SELECT
        vtp.tag_id,
        t.label,
        COUNT(*) AS package_count
      FROM visible_tag_pairs vtp
      JOIN tags t ON t.tag_id = vtp.tag_id
      GROUP BY vtp.tag_id, t.label
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

function buildSearchWhereClause(
  queryTerms: string[],
  tags: string[],
  preferFts: boolean
) {
  const clauses = [`WHERE ${createVisiblePackageSql("p")}`]
  const args: Array<string | number> = []
  const { ftsMatchExpression, fallbackTerms } =
    buildCatalogSearchTerms(queryTerms)

  if (preferFts && ftsMatchExpression) {
    clauses.push(
      `AND p.package_name IN (
        SELECT package_name
        FROM package_search_fts
        WHERE package_search_fts MATCH ?
      )`
    )
    args.push(ftsMatchExpression)
  }

  if (!preferFts || fallbackTerms.length > 0) {
    appendLegacyTextSearchClauses(
      clauses,
      args,
      preferFts ? fallbackTerms : queryTerms
    )
  }

  if (tags.length > 0) {
    clauses.push(
      `AND p.package_name IN (${buildTagFilterSubquery(tags.length)})`
    )
    args.push(...tags, ...tags, tags.length)
  }

  return {
    clauses: clauses.join("\n"),
    args,
    hasFilters: queryTerms.length > 0 || tags.length > 0,
  }
}

function buildCatalogSearchTerms(queryTerms: string[]) {
  const tokenizedTerms = queryTerms.map((term) => ({
    hasLiteralSyntax: /[^a-z0-9]/i.test(term),
    term,
    tokens: term.toLowerCase().match(/[a-z0-9]+/g) ?? [],
  }))
  const tokens = tokenizedTerms.flatMap(({ tokens }) => tokens)

  return {
    fallbackTerms: tokenizedTerms.flatMap(
      ({ hasLiteralSyntax, term, tokens }) =>
        tokens.length === 0 || hasLiteralSyntax ? [term] : []
    ),
    ftsMatchExpression:
      tokens.length === 0
        ? null
        : tokens.map((token) => `${token}*`).join(" AND "),
  }
}

function appendLegacyTextSearchClauses(
  clauses: string[],
  args: Array<string | number>,
  queryTerms: string[]
) {
  for (const term of queryTerms) {
    clauses.push(
      `AND (
        LOWER(p.package_name) LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.package_description, '')) LIKE '%' || ? || '%'
        OR LOWER(COALESCE(p.repository_url, '')) LIKE '%' || ? || '%'
        OR EXISTS (
          SELECT 1
          FROM package_tags pt
          WHERE pt.package_name = p.package_name
            AND pt.tag_id LIKE '%' || ? || '%'
        )
        OR EXISTS (
          SELECT 1
          FROM repository_tags rt
          WHERE rt.package_name = p.package_name
            AND rt.tag_id LIKE '%' || ? || '%'
        )
      )`
    )
    args.push(term, term, term, term, term)
  }
}

function isMissingPackageSearchFtsError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("no such table: package_search_fts")
  )
}

function getCatalogOrderByClause(
  sort: CatalogSortColumn,
  direction: CatalogSortDirection
) {
  const normalizedDirection = direction.toUpperCase()

  switch (sort) {
    case "stars":
      return `repository_stars ${normalizedDirection}, package_name COLLATE NOCASE ASC`
    case "downloads":
      return `package_downloads ${normalizedDirection}, package_name COLLATE NOCASE ASC`
    case "published":
      return `package_last_published_at ${normalizedDirection}, package_name COLLATE NOCASE ASC`
    case "name":
    default:
      return `package_name COLLATE NOCASE ${normalizedDirection}`
  }
}

async function fetchVisiblePackageNames(
  client: CatalogDatabaseClient,
  params: ParsedCatalogSearchParams,
  clauses: string,
  args: Array<string | number>,
  orderByClause: string
) {
  const listArgs = [...args, params.limit + 1, params.offset]
  const result = await client.execute({
    sql: `
      SELECT p.package_name
      FROM packages p
      ${clauses}
      ORDER BY ${orderByClause}
      LIMIT ? OFFSET ?
    `,
    args: listArgs,
  })

  return result.rows.map((row) => String(row.package_name))
}

async function fetchPackagesByName(
  client: CatalogDatabaseClient,
  packageNames: string[]
) {
  const packageMap = new Map<
    string,
    {
      repository_url: unknown
      package_url: unknown
      package_description: unknown
      homepage_url: unknown
      repository_stars: unknown
      package_downloads: unknown
      package_downloads_period: unknown
      package_last_published_at: unknown
    }
  >()

  if (packageNames.length === 0) {
    return packageMap
  }

  const placeholders = packageNames.map(() => "?").join(", ")
  const result = await client.execute({
    sql: `
      SELECT
        package_name,
        repository_url,
        package_url,
        package_description,
        homepage_url,
        repository_stars,
        package_downloads,
        package_downloads_period,
        package_last_published_at
      FROM packages
      WHERE package_name IN (${placeholders})
    `,
    args: packageNames,
  })

  for (const row of result.rows) {
    packageMap.set(String(row.package_name), {
      repository_url: row.repository_url,
      package_url: row.package_url,
      package_description: row.package_description,
      homepage_url: row.homepage_url,
      repository_stars: row.repository_stars,
      package_downloads: row.package_downloads,
      package_downloads_period: row.package_downloads_period,
      package_last_published_at: row.package_last_published_at,
    })
  }

  return packageMap
}

async function resolveTotalApproximation(
  client: CatalogDatabaseClient,
  params: ParsedCatalogSearchParams,
  hasFilters: boolean,
  visibleRowCount: number,
  hasMore: boolean
) {
  if (params.offset !== 0 || hasFilters) {
    return estimateTotalFromPage(params, visibleRowCount, hasMore)
  }

  try {
    const countResult = await client.execute({
      sql: `SELECT COUNT(*) AS total FROM packages p WHERE ${createVisiblePackageSql("p")}`,
    })

    return normalizeNumber(countResult.rows[0]?.total)
  } catch {
    return estimateTotalFromPage(params, visibleRowCount, hasMore)
  }
}

function estimateTotalFromPage(
  params: ParsedCatalogSearchParams,
  visibleRowCount: number,
  hasMore: boolean
) {
  const currentMaxIndex = params.offset + visibleRowCount

  if (!hasMore) {
    return currentMaxIndex
  }

  return currentMaxIndex + params.limit
}

function buildTagFilterSubquery(tagCount: number) {
  const placeholders = Array.from({ length: tagCount }, () => "?").join(", ")

  return `
    SELECT package_name
    FROM (
      SELECT package_name, tag_id
      FROM package_tags
      WHERE tag_id IN (${placeholders})
      UNION ALL
      SELECT package_name, tag_id
      FROM repository_tags
      WHERE tag_id IN (${placeholders})
    ) AS filtered_tags
    GROUP BY package_name
    HAVING COUNT(DISTINCT tag_id) = ?
  `
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
        ${MERGED_TAGS_SQL}
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

const MERGED_TAGS_SQL = `
  SELECT package_name, tag_id FROM package_tags
  UNION ALL
  SELECT package_name, tag_id FROM repository_tags
`

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
