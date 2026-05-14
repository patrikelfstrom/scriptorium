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
  const [debouncedSearchText, setDebouncedSearchText] = useState(
    initialState.searchText
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearchText(searchText)
    }, 300)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [searchText])

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    const currentLocationState = getInitialCatalogState()
    const nextState = {
      searchText: debouncedSearchText,
      selectedTags,
      sortState,
    }
    const nextUrl = buildCatalogUrl(nextState)

    if (nextUrl === getCurrentUrl()) {
      return
    }

    if (shouldPushHistoryEntry(currentLocationState, nextState)) {
      window.history.pushState(window.history.state, "", nextUrl)
      return
    }

    window.history.replaceState(window.history.state, "", nextUrl)
  }, [debouncedSearchText, selectedTags, sortState])

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    function handlePopState() {
      const nextState = getInitialCatalogState()

      setSearchText(nextState.searchText)
      setDebouncedSearchText(nextState.searchText)
      setSelectedTags(nextState.selectedTags)
      setSortState(nextState.sortState)
    }

    window.addEventListener("popstate", handlePopState)

    return () => {
      window.removeEventListener("popstate", handlePopState)
    }
  }, [])

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

function buildCatalogUrl(state: {
  searchText: string
  selectedTags: string[]
  sortState: SortState
}) {
  const searchParams = new URLSearchParams()

  if (state.searchText) {
    searchParams.set("q", state.searchText)
  }

  if (state.selectedTags.length > 0) {
    searchParams.set("tags", state.selectedTags.join(","))
  }

  searchParams.set("sort", state.sortState.column)
  searchParams.set("direction", state.sortState.direction)

  const search = searchParams.toString()

  return search ? `${window.location.pathname}?${search}` : window.location.pathname
}

function getCurrentUrl() {
  return `${window.location.pathname}${window.location.search}`
}

function shouldPushHistoryEntry(
  currentState: ReturnType<typeof getInitialCatalogState>,
  nextState: ReturnType<typeof getInitialCatalogState>
) {
  return (
    currentState.searchText !== nextState.searchText ||
    currentState.selectedTags.join(",") !== nextState.selectedTags.join(",")
  )
}
