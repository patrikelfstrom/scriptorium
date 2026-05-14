export const DEFAULT_CATALOG_SEARCH_LIMIT = 30
export const MAX_CATALOG_SEARCH_LIMIT = 1000
export const CATALOG_SORT_COLUMNS = [
  "name",
  "stars",
  "downloads",
  "published",
] as const
export const CATALOG_SORT_DIRECTIONS = ["asc", "desc"] as const

export type CatalogSortColumn = (typeof CATALOG_SORT_COLUMNS)[number]
export type CatalogSortDirection = (typeof CATALOG_SORT_DIRECTIONS)[number]

export type CatalogItem = {
  packageName: string
  repositoryUrl: string | null
  packageUrl: string
  packageDescription: string | null
  homepageUrl: string | null
  repositoryStars: number | null
  packageDownloads: number
  packageDownloadsPeriod: string | null
  packageLastPublishedAt: string | null
  tags: string[]
}

export type CatalogTag = {
  id: string
  label: string
  packageCount: number
}

export type CatalogSearchResponse = {
  items: CatalogItem[]
  nextCursor: string | null
  totalApprox: number
}

export type CatalogTagListResponse = {
  items: CatalogTag[]
}

export type CatalogSearchParams = {
  query: string
  tags: string[]
  limit: number
  cursor?: string | null
  sort: CatalogSortColumn
  direction: CatalogSortDirection
}

export type ParsedCatalogSearchParams = CatalogSearchParams & {
  offset: number
}

export type CatalogTagListParams = Record<string, never>
