import { useEffect, useState } from "react"

import {
  normalizeCatalogSort,
  normalizeCatalogSortDirection,
  normalizeCatalogTags,
} from "../../../../shared/catalog"

import type { SortState } from "../types"

const DEFAULT_SORT_STATE: SortState = {
  column: "name",
  direction: "asc",
}

export function useCatalogState() {
  const initialState = getInitialCatalogState()
  const [searchText, setSearchText] = useState(initialState.searchText)
  const [selectedTags, setSelectedTags] = useState(initialState.selectedTags)
  const [sortState, setSortState] = useState(initialState.sortState)
  const debouncedSearchText = useDebouncedValue(searchText, 300)

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    const searchParams = new URLSearchParams()

    if (debouncedSearchText) {
      searchParams.set("q", debouncedSearchText)
    }

    if (selectedTags.length > 0) {
      searchParams.set("tags", selectedTags.join(","))
    }

    searchParams.set("sort", sortState.column)
    searchParams.set("direction", sortState.direction)

    const search = searchParams.toString()
    const nextUrl = search
      ? `${window.location.pathname}?${search}`
      : window.location.pathname

    window.history.replaceState(window.history.state, "", nextUrl)
  }, [debouncedSearchText, selectedTags, sortState.column, sortState.direction])

  return {
    debouncedSearchText,
    searchText,
    selectedTags,
    setSearchText,
    setSelectedTags,
    setSortState,
    sortState,
  }
}

function getInitialCatalogState() {
  if (typeof window === "undefined") {
    return {
      searchText: "",
      selectedTags: [],
      sortState: DEFAULT_SORT_STATE,
    }
  }

  const searchParams = new URLSearchParams(window.location.search)

  return {
    searchText: searchParams.get("q") ?? "",
    selectedTags: normalizeCatalogTags(searchParams.get("tags")),
    sortState: {
      column: normalizeCatalogSort(searchParams.get("sort")),
      direction: normalizeCatalogSortDirection(searchParams.get("direction")),
    },
  }
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedValue(value)
    }, delayMs)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [delayMs, value])

  return debouncedValue
}
