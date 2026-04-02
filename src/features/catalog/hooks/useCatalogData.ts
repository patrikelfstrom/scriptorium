import {
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"

import {
  fetchCatalogSearchPage,
  fetchCatalogTags,
} from "../api"
import { mapCatalogItemsToRows } from "../mappers"
import { normalizeValue } from "../helpers"
import type { SortState } from "../types"

export function useCatalogData(input: {
  query: string
  selectedTags: string[]
  sortState: SortState
}) {
  const searchQuery = useInfiniteQuery({
    queryKey: [
      "catalog-search",
      input.query,
      input.selectedTags,
      input.sortState.column,
      input.sortState.direction,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchCatalogSearchPage(
        {
          cursor: pageParam,
          query: input.query,
          tags: input.selectedTags,
          sort: input.sortState.column,
          direction: input.sortState.direction,
        },
        signal
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const tagsQuery = useQuery({
    queryKey: ["catalog-tags"],
    queryFn: ({ signal }) => fetchCatalogTags(signal),
  })

  const rows = (searchQuery.data?.pages ?? []).flatMap((page) =>
    mapCatalogItemsToRows(page.items ?? [])
  )
  const availableTags = (tagsQuery.data?.items ?? [])
    .map((item) => normalizeValue(item.id || item.label))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
  const totalRows = searchQuery.data?.pages[0]?.totalApprox ?? rows.length
  const isLoading = searchQuery.isLoading || tagsQuery.isLoading
  const errorMessage = getErrorMessage(searchQuery.error, tagsQuery.error)

  return {
    rows,
    availableTags,
    errorMessage,
    fetchNextPage: searchQuery.fetchNextPage,
    hasNextPage: searchQuery.hasNextPage,
    isFetchingNextPage: searchQuery.isFetchingNextPage,
    isLoading,
    totalRows,
  }
}

function getErrorMessage(...errors: Array<unknown>) {
  for (const error of errors) {
    if (error instanceof Error) {
      return error.message
    }
  }

  return undefined
}
