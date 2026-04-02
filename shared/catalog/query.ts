import {
  CATALOG_SORT_COLUMNS,
  CATALOG_SORT_DIRECTIONS,
  DEFAULT_CATALOG_SEARCH_LIMIT,
  MAX_CATALOG_SEARCH_LIMIT,
  type CatalogSortColumn,
  type CatalogSortDirection,
  type CatalogTagListParams,
  type ParsedCatalogSearchParams,
} from "./contracts"
import { decodeCatalogCursor } from "./cursor"

export function normalizeCatalogText(value?: string | null) {
  if (typeof value !== "string") {
    return ""
  }

  return value.trim().toLowerCase()
}

export function normalizeCatalogQuery(value?: string | null) {
  if (typeof value !== "string") {
    return ""
  }

  return value.trim()
}

export function normalizeCatalogSource(value?: string | null) {
  const normalized = normalizeCatalogText(value)
  return normalized.length > 0 ? normalized : undefined
}

export function normalizeCatalogTags(rawTags?: string | null) {
  if (!rawTags) {
    return []
  }

  return Array.from(
    new Set(
      rawTags
        .split(",")
        .map((value) => normalizeCatalogText(value))
        .filter(Boolean)
    )
  )
}

export function clampCatalogLimit(value?: string | null) {
  const parsedValue = Number.parseInt(value ?? "", 10)
  const resolved = Number.isInteger(parsedValue)
    ? parsedValue
    : DEFAULT_CATALOG_SEARCH_LIMIT

  return Math.min(Math.max(resolved, 1), MAX_CATALOG_SEARCH_LIMIT)
}

export function normalizeCatalogSort(
  value?: string | null
): CatalogSortColumn {
  return CATALOG_SORT_COLUMNS.includes(value as CatalogSortColumn)
    ? (value as CatalogSortColumn)
    : "name"
}

export function normalizeCatalogSortDirection(
  value?: string | null
): CatalogSortDirection {
  return CATALOG_SORT_DIRECTIONS.includes(value as CatalogSortDirection)
    ? (value as CatalogSortDirection)
    : "asc"
}

export function tokenizeCatalogQuery(query: string) {
  return query
    .split(/\s+/)
    .map((term) => normalizeCatalogText(term))
    .filter(Boolean)
}

export function parseCatalogSearchParams(
  searchParams: URLSearchParams
): ParsedCatalogSearchParams {
  const cursor = searchParams.get("cursor")

  return {
    query: normalizeCatalogQuery(searchParams.get("q")),
    tags: normalizeCatalogTags(searchParams.get("tags")),
    source: normalizeCatalogSource(searchParams.get("source")),
    limit: clampCatalogLimit(searchParams.get("limit")),
    cursor,
    sort: normalizeCatalogSort(searchParams.get("sort")),
    direction: normalizeCatalogSortDirection(searchParams.get("direction")),
    offset: decodeCatalogCursor(cursor),
  }
}

export function parseCatalogTagListParams(
  searchParams: URLSearchParams
): CatalogTagListParams {
  return {
    source: normalizeCatalogSource(searchParams.get("source")),
  }
}
