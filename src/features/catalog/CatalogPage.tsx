import { Moon, Sun } from "lucide-react"
import { useId, useState } from "react"

import { useTheme } from "@/components/theme-provider"
import { canonicalizeCatalogTags } from "../../../shared/catalog"

import {
  getActiveToken,
  getIsDarkMode,
  getTagSuggestions,
  normalizeValue,
} from "./helpers"
import { useCatalogData } from "./hooks/useCatalogData"
import { useCatalogState } from "./hooks/useCatalogState"
import { GitHubIcon } from "./components/GitHubIcon"
import { ResultsTable } from "./components/ResultsTable"
import { SearchFilter } from "./components/SearchFilter"

export function CatalogPage() {
  const { theme, setTheme } = useTheme()
  const inputId = useId()
  const [shouldLoadTags, setShouldLoadTags] = useState(false)
  const {
    debouncedSearchText,
    searchText,
    selectedTags,
    setSearchText,
    setSelectedTags,
    setSortState,
    sortState,
  } = useCatalogState()
  const {
    rows,
    rowsByIndex,
    availableTags,
    errorMessage,
    isFetchingRows,
    isLoading,
    loadRowsForRange,
    totalRows,
  } = useCatalogData({
    loadTags: shouldLoadTags || selectedTags.length > 0,
    query: debouncedSearchText,
    selectedTags,
    sortState,
  })
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1)

  const allTags = availableTags.length
    ? availableTags
    : Array.from(
        new Set(rows.flatMap((row) => row.tags.map(normalizeValue)))
      ).sort((left, right) => left.localeCompare(right))
  const selectedTagSet = new Set(selectedTags.map(normalizeValue))
  const { token: activeToken } = getActiveToken(searchText)
  const tagSuggestions = getTagSuggestions(activeToken, selectedTags, allTags)
  const activeSuggestion =
    activeSuggestionIndex >= 0 && activeSuggestionIndex < tagSuggestions.length
      ? tagSuggestions[activeSuggestionIndex]
      : undefined
  const isDarkMode = getIsDarkMode(theme)
  const canonicalSelectedTags = canonicalizeCatalogTags(selectedTags)
  const queryStateKey = [
    debouncedSearchText,
    canonicalSelectedTags.join(","),
    sortState.column,
    sortState.direction,
  ].join("|")

  return (
    <main className="h-svh">
      <section className="flex h-full flex-col overflow-hidden bg-background/90 backdrop-blur">
        <div className="relative z-30 border-b border-border/60 bg-muted/30 px-3 py-3 sm:px-6 sm:py-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-base font-semibold tracking-[0.18em] text-foreground uppercase sm:text-lg sm:tracking-[0.2em]">
                scriptorium
              </h1>
              <div className="ml-auto flex items-center gap-2">
                <a
                  href="https://github.com/patrikelfstrom/scriptorium"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-xl border border-border/70 bg-background/85 p-2.5 text-foreground shadow-sm transition-colors outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-primary/20"
                  aria-label="Open scriptorium on GitHub"
                >
                  <GitHubIcon className="size-4" />
                </a>
                <button
                  type="button"
                  onClick={() => setTheme(isDarkMode ? "light" : "dark")}
                  className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-background/85 px-3 py-2 text-xs tracking-[0.18em] text-foreground uppercase shadow-sm transition-colors outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-primary/20"
                  aria-label={`Switch to ${isDarkMode ? "light" : "dark"} mode`}
                >
                  {isDarkMode ? (
                    <Sun className="size-4" />
                  ) : (
                    <Moon className="size-4" />
                  )}
                  <span className="max-[420px]:hidden">
                    {isDarkMode ? "Light" : "Dark"}
                  </span>
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
              <SearchFilter
                activeSuggestion={activeSuggestion}
                activeSuggestionIndex={activeSuggestionIndex}
                inputId={inputId}
                isDarkMode={isDarkMode}
                onInputFocus={() => setShouldLoadTags(true)}
                searchText={searchText}
                selectedTags={selectedTags}
                setActiveSuggestionIndex={setActiveSuggestionIndex}
                setSearchText={setSearchText}
                setSelectedTags={setSelectedTags}
                tagSuggestions={tagSuggestions}
              />
              <div className="hidden shrink-0 flex-wrap gap-x-3 gap-y-1 text-[0.65rem] tracking-[0.16em] text-muted-foreground uppercase sm:ml-auto sm:flex sm:justify-end sm:tracking-[0.18em]">
                <span>{isLoading ? "Loading" : `${rows.length} shown`}</span>
                <span>{totalRows} total</span>
              </div>
            </div>
          </div>
        </div>
        <div className="relative z-0 flex min-h-0 flex-1 overflow-hidden">
          <ResultsTable
            errorMessage={errorMessage}
            isDarkMode={isDarkMode}
            isFetchingRows={isFetchingRows}
            isLoading={isLoading}
            loadRowsForRange={loadRowsForRange}
            queryStateKey={queryStateKey}
            rows={rows}
            rowsByIndex={rowsByIndex}
            selectedTagSet={selectedTagSet}
            setSelectedTags={setSelectedTags}
            setSortState={setSortState}
            sortState={sortState}
            totalRows={totalRows}
          />
        </div>
      </section>
    </main>
  )
}
