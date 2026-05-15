import { useEffect, useState, type SetStateAction } from "react"

import {
  canonicalizeCatalogTags,
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
  const [catalogState, setCatalogState] = useState(initialState)
  const [debouncedSearchText, setDebouncedSearchText] = useState(
    initialState.searchText
  )
  const { searchText, selectedTags, sortState } = catalogState

  function setSearchText(nextValue: SetStateAction<string>) {
    setCatalogState((currentState) => ({
      ...currentState,
      searchText:
        typeof nextValue === "function"
          ? nextValue(currentState.searchText)
          : nextValue,
    }))
  }

  function setSelectedTags(nextValue: SetStateAction<string[]>) {
    setCatalogState((currentState) => ({
      ...currentState,
      selectedTags:
        typeof nextValue === "function"
          ? nextValue(currentState.selectedTags)
          : nextValue,
    }))
  }

  function setSortState(nextValue: SetStateAction<SortState>) {
    setCatalogState((currentState) => ({
      ...currentState,
      sortState:
        typeof nextValue === "function"
          ? nextValue(currentState.sortState)
          : nextValue,
    }))
  }

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

      setCatalogState(nextState)
      setDebouncedSearchText(nextState.searchText)
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
  const canonicalTags = canonicalizeCatalogTags(state.selectedTags)

  if (state.searchText) {
    searchParams.set("q", state.searchText)
  }

  if (canonicalTags.length > 0) {
    searchParams.set("tags", canonicalTags.join(","))
  }

  searchParams.set("sort", state.sortState.column)
  searchParams.set("direction", state.sortState.direction)

  const search = formatCatalogLocationSearch(searchParams)

  return search
    ? `${window.location.pathname}?${search}`
    : window.location.pathname
}

function formatCatalogLocationSearch(searchParams: URLSearchParams) {
  return searchParams
    .toString()
    .replace(
      /(^|&)tags=([^&]*)/,
      (_match, prefix: string, value: string) =>
        `${prefix}tags=${value.replaceAll(/%2C/gi, ",")}`
    )
}

function getCurrentUrl() {
  return `${window.location.pathname}${window.location.search}`
}

function shouldPushHistoryEntry(
  currentState: ReturnType<typeof getInitialCatalogState>,
  nextState: ReturnType<typeof getInitialCatalogState>
) {
  const currentTags = canonicalizeCatalogTags(currentState.selectedTags)
  const nextTags = canonicalizeCatalogTags(nextState.selectedTags)

  return (
    currentState.searchText !== nextState.searchText ||
    currentTags.join(",") !== nextTags.join(",")
  )
}
