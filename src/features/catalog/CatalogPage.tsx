import {
  Moon,
  Sun,
} from "lucide-react"
import {
  useId,
  useState,
} from "react"

import { useTheme } from "@/components/theme-provider"

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
    availableTags,
    errorMessage,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    totalRows,
  } = useCatalogData({
    query: debouncedSearchText,
    selectedTags,
    sortState,
  })
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1)

  const allTags = availableTags.length
    ? availableTags
    : Array.from(new Set(rows.flatMap((row) => row.tags.map(normalizeValue)))).sort(
        (left, right) => left.localeCompare(right)
      )
  const selectedTagSet = new Set(selectedTags.map(normalizeValue))
  const { token: activeToken } = getActiveToken(searchText)
  const tagSuggestions = getTagSuggestions(activeToken, selectedTags, allTags)
  const activeSuggestion =
    activeSuggestionIndex >= 0 && activeSuggestionIndex < tagSuggestions.length
      ? tagSuggestions[activeSuggestionIndex]
      : undefined
  const isDarkMode = getIsDarkMode(theme)
  const queryStateKey = [
    debouncedSearchText,
    selectedTags.join(","),
    sortState.column,
    sortState.direction,
  ].join("|")

  return (
    <main className="h-svh">
      <section className="flex h-full flex-col overflow-hidden bg-background/90 backdrop-blur">
        <div className="border-b border-border/60 bg-muted/30 px-4 py-4 sm:px-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-lg font-semibold tracking-[0.2em] text-foreground uppercase">
                scriptorium
              </h1>
              <div className="ml-auto flex items-center gap-2">
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
                  <span>{isDarkMode ? "Light" : "Dark"}</span>
                </button>
                <a
                  href="https://github.com/patrikelfstrom/scriptorium"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-xl border border-border/70 bg-background/85 p-2.5 text-foreground shadow-sm transition-colors outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-primary/20"
                  aria-label="Open scriptorium on GitHub"
                >
                  <GitHubIcon className="size-4" />
                </a>
              </div>
            </div>
            <div className="flex items-end gap-4">
              <SearchFilter
                activeSuggestion={activeSuggestion}
                activeSuggestionIndex={activeSuggestionIndex}
                inputId={inputId}
                isDarkMode={isDarkMode}
                searchText={searchText}
                selectedTags={selectedTags}
                setActiveSuggestionIndex={setActiveSuggestionIndex}
                setSearchText={setSearchText}
                setSelectedTags={setSelectedTags}
                tagSuggestions={tagSuggestions}
              />
              <div className="ml-auto flex shrink-0 gap-2 text-[0.65rem] tracking-[0.18em] text-muted-foreground uppercase">
                <span>{isLoading ? "Loading" : `${rows.length} shown`}</span>
                <span>{totalRows} total</span>
              </div>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex flex-1 overflow-hidden">
          <ResultsTable
            errorMessage={errorMessage}
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isDarkMode={isDarkMode}
            isFetchingNextPage={isFetchingNextPage}
            isLoading={isLoading}
            queryStateKey={queryStateKey}
            rows={rows}
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
