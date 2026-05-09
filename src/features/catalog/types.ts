import type {
  CatalogSortColumn,
  CatalogSortDirection,
} from "../../../shared/catalog"

export type CatalogRow = {
  packageName: string
  packageDescription?: string
  homepageUrl?: string
  repositoryUrl?: string
  repositoryLabel?: string
  packageUrl: string
  packageLastPublishedAt?: string
  repositoryStars?: number
  packageDownloads: number
  packageDownloadsPeriod?: string
  tags: string[]
}

export type SortState = {
  column: CatalogSortColumn
  direction: CatalogSortDirection
}
