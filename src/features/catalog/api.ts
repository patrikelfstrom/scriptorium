import {
  DEFAULT_CATALOG_SEARCH_LIMIT,
  type CatalogSearchResponse,
  type CatalogSortColumn,
  type CatalogSortDirection,
  type CatalogTagListResponse,
} from "../../../shared/catalog"

export function createCatalogApiUrl(
  pathname: string,
  searchParams?: URLSearchParams
) {
  const baseUrl = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL)
  const query = searchParams?.toString()
  const suffix = query ? `?${query}` : ""

  if (!baseUrl) {
    return `${pathname}${suffix}`
  }

  return `${baseUrl}${pathname}${suffix}`
}

function normalizeBaseUrl(value?: string) {
  if (!value) {
    return ""
  }

  return value.trim().replace(/\/+$/, "")
}

export async function fetchCatalogSearchPage(
  input: {
    cursor?: string | null
    direction: CatalogSortDirection
    query: string
    sort: CatalogSortColumn
    tags: string[]
  },
  signal?: AbortSignal
) {
  const searchParams = new URLSearchParams({
    limit: String(DEFAULT_CATALOG_SEARCH_LIMIT),
    sort: input.sort,
    direction: input.direction,
  })

  if (input.query) {
    searchParams.set("q", input.query)
  }

  if (input.tags.length > 0) {
    searchParams.set("tags", input.tags.join(","))
  }

  if (input.cursor) {
    searchParams.set("cursor", input.cursor)
  }

  const response = await fetch(createCatalogApiUrl("/api/search", searchParams), {
    signal,
  })

  return parseCatalogResponse<CatalogSearchResponse>(
    response,
    "Search request failed"
  )
}

export async function fetchCatalogTags(signal?: AbortSignal) {
  const response = await fetch(createCatalogApiUrl("/api/tags"), { signal })

  return parseCatalogResponse<CatalogTagListResponse>(
    response,
    "Tags request failed"
  )
}

async function parseCatalogResponse<T>(response: Response, message: string) {
  if (!response.ok) {
    throw new Error(`${message} with ${response.status}.`)
  }

  return (await response.json()) as T
}
