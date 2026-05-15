import { useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"

import {
  DEFAULT_CATALOG_SEARCH_LIMIT,
  canonicalizeCatalogTags,
  type CatalogSearchResponse,
} from "../../../../shared/catalog"

import { fetchCatalogSearchPage, fetchCatalogTags } from "../api"
import { mapCatalogItemsToRows } from "../mappers"
import { normalizeValue } from "../helpers"
import {
  getCatalogPageCursorForOffset,
  getCatalogPageOffsetsForRange,
} from "../paging"
import type { SortState } from "../types"

export function useCatalogData(input: {
  query: string
  selectedTags: string[]
  sortState: SortState
}) {
  const normalizedSelectedTags = canonicalizeCatalogTags(input.selectedTags)
  const searchKey = [
    input.query,
    normalizedSelectedTags.join(","),
    input.sortState.column,
    input.sortState.direction,
  ].join("|")
  const [pageState, setPageState] = useState(() => ({
    searchKey,
    requestedOffsets: [0],
  }))
  const requestedOffsets =
    pageState.searchKey === searchKey ? pageState.requestedOffsets : [0]

  const searchQueries = useQueries({
    queries: requestedOffsets.map((offset) => ({
      queryKey: [
        "catalog-search",
        input.query,
        normalizedSelectedTags,
        input.sortState.column,
        input.sortState.direction,
        offset,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchCatalogSearchPage(
          {
            cursor: getCatalogPageCursorForOffset(offset),
            query: input.query,
            tags: normalizedSelectedTags,
            sort: input.sortState.column,
            direction: input.sortState.direction,
          },
          signal
        ),
      placeholderData: (previousData: CatalogSearchResponse | undefined) =>
        previousData,
      staleTime: 60 * 60_000,
    })),
  })
  const tagsQuery = useQuery({
    queryKey: ["catalog-tags"],
    queryFn: ({ signal }) => fetchCatalogTags(signal),
    staleTime: 12 * 60 * 60_000,
  })
  const rowsByIndex = new Map<
    number,
    ReturnType<typeof mapCatalogItemsToRows>[number]
  >()
  const rows = requestedOffsets.flatMap((offset, index) => {
    const page = searchQueries[index]?.data

    if (!page) {
      return []
    }

    const mappedRows = mapCatalogItemsToRows(page.items ?? [])

    mappedRows.forEach((row, rowIndex) => {
      rowsByIndex.set(offset + rowIndex, row)
    })

    return mappedRows
  })
  const totalRows = Math.max(
    rows.length,
    ...searchQueries.map((query) => query.data?.totalApprox ?? 0)
  )
  const availableTags = (tagsQuery.data?.items ?? [])
    .flatMap((item) => {
      const normalizedTag = normalizeValue(item.id || item.label)
      return normalizedTag ? [normalizedTag] : []
    })
    .sort((left, right) => left.localeCompare(right))
  const isLoading = getIsCatalogSearchLoading(searchQueries)
  const isFetchingRows = searchQueries.some((query) => query.isFetching)
  const errorMessage = getErrorMessage(
    ...searchQueries.map((query) => query.error)
  )

  function loadRowsForRange(startIndex: number, endIndex: number) {
    const maxRowIndex = Math.max(0, totalRows - 1)
    const offsetsToRequest = getCatalogPageOffsetsForRange(
      startIndex,
      Math.min(endIndex, maxRowIndex),
      DEFAULT_CATALOG_SEARCH_LIMIT
    )

    if (offsetsToRequest.length === 0) {
      return
    }

    setPageState((currentState) => {
      const activeState =
        currentState.searchKey === searchKey
          ? currentState
          : {
              searchKey,
              requestedOffsets: [0],
            }
      const nextOffsets = new Set(activeState.requestedOffsets)

      for (const offset of offsetsToRequest) {
        if (offset < totalRows) {
          nextOffsets.add(offset)
        }
      }

      if (nextOffsets.size === activeState.requestedOffsets.length) {
        return activeState
      }

      return {
        searchKey,
        requestedOffsets: Array.from(nextOffsets).sort(
          (left, right) => left - right
        ),
      }
    })
  }

  return {
    rows,
    rowsByIndex,
    availableTags,
    errorMessage,
    isFetchingRows,
    isLoading,
    loadRowsForRange,
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

export function getIsCatalogSearchLoading(
  searchQueries: Array<{ isLoading?: boolean }>
) {
  return searchQueries[0]?.isLoading ?? true
}
