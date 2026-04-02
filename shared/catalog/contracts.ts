export const DEFAULT_CATALOG_SEARCH_LIMIT = 30
export const MAX_CATALOG_SEARCH_LIMIT = 1000
export const CATALOG_SORT_COLUMNS = ["name", "stars", "tags"] as const
export const CATALOG_SORT_DIRECTIONS = ["asc", "desc"] as const

export type CatalogSortColumn = (typeof CATALOG_SORT_COLUMNS)[number]
export type CatalogSortDirection = (typeof CATALOG_SORT_DIRECTIONS)[number]

export type CatalogItem = {
  packageKey: string
  sourceType: string
  sourceName: string
  name: string
  description: string | null
  url: string | null
  repositoryName: string | null
  npmPackageName: string | null
  stars: number | null
  downloads: number
  downloadsPeriod: string | null
  dependentPackagesCount: number
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
  source?: string
  limit: number
  cursor?: string | null
  sort: CatalogSortColumn
  direction: CatalogSortDirection
}

export type ParsedCatalogSearchParams = CatalogSearchParams & {
  offset: number
}

export type CatalogTagListParams = {
  source?: string
}
