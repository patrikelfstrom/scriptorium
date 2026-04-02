import type {
  CatalogSortColumn,
  CatalogSortDirection,
} from "../../../shared/catalog"

export type CatalogRow = {
  id: string
  name: string
  description?: string
  url?: string
  repositoryName?: string
  github?: string
  npmPackageName?: string
  npmPackageUrl?: string
  stars?: number
  tags: string[]
}

export type SortState = {
  column: CatalogSortColumn
  direction: CatalogSortDirection
}
