import type { CatalogItem } from "../../../shared/catalog"
import type { CatalogRow } from "./types"

export function mapCatalogItemsToRows(items: CatalogItem[]): CatalogRow[] {
  return items.map((item) => ({
    packageName: item.packageName,
    packageDescription: normalizeOptionalString(item.packageDescription),
    homepageUrl: normalizeOptionalString(item.homepageUrl),
    repositoryUrl: normalizeOptionalString(item.repositoryUrl),
    repositoryLabel: deriveRepositoryLabel(item.repositoryUrl),
    packageUrl: item.packageUrl,
    packageLastPublishedAt: normalizeOptionalString(
      item.packageLastPublishedAt
    ),
    repositoryStars:
      typeof item.repositoryStars === "number"
        ? item.repositoryStars
        : undefined,
    packageDownloads: item.packageDownloads,
    packageDownloadsPeriod: normalizeOptionalString(
      item.packageDownloadsPeriod
    ),
    tags: uniqueValues(
      item.tags
        .map(normalizeOptionalString)
        .filter((tag): tag is string => Boolean(tag))
        .sort((left, right) => left.localeCompare(right))
    ),
  }))
}

function normalizeOptionalString(value?: string | null) {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function deriveRepositoryLabel(repositoryUrl?: string | null) {
  if (typeof repositoryUrl !== "string" || repositoryUrl.trim().length === 0) {
    return undefined
  }

  try {
    const url = new URL(repositoryUrl)
    const pathname = url.pathname.replace(/^\/+|\/+$/g, "")

    if (pathname.length > 0) {
      return pathname
    }

    return url.hostname
  } catch {
    return repositoryUrl
  }
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values))
}
