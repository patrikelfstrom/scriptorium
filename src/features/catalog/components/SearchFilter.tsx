import { Search, X } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"

import { Badge } from "@/components/ui/badge"

import {
  commitSuggestedTag,
  getTagColorStyle,
  handleFilterKeyDown,
  removeSelectedTag,
} from "../helpers"

export function SearchFilter({
  activeSuggestion,
  activeSuggestionIndex,
  inputId,
  isDarkMode,
  searchText,
  selectedTags,
  setActiveSuggestionIndex,
  setSearchText,
  setSelectedTags,
  tagSuggestions,
}: {
  activeSuggestion?: string
  activeSuggestionIndex: number
  inputId: string
  isDarkMode: boolean
  searchText: string
  selectedTags: string[]
  setActiveSuggestionIndex: Dispatch<SetStateAction<number>>
  setSearchText: Dispatch<SetStateAction<string>>
  setSelectedTags: Dispatch<SetStateAction<string[]>>
  tagSuggestions: string[]
}) {
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const normalizedSuggestionIndex =
    activeSuggestionIndex >= 0 && activeSuggestionIndex < tagSuggestions.length
      ? activeSuggestionIndex
      : -1

  useEffect(() => {
    if (!isSuggestionsOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (suggestionsRef.current?.contains(event.target as Node)) {
        return
      }

      setIsSuggestionsOpen(false)
      setActiveSuggestionIndex(-1)
    }

    document.addEventListener("pointerdown", handlePointerDown)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [isSuggestionsOpen, setActiveSuggestionIndex])

  return (
    <div className="max-w-2xl min-w-0 flex-1">
      <div className="relative">
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-background/85 px-3 py-2 shadow-sm transition-[border-color,box-shadow] focus-within:border-primary/50 focus-within:ring-4 focus-within:ring-primary/10">
          <Search className="size-4 text-muted-foreground" />
          {selectedTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => removeSelectedTag(tag, setSelectedTags)}
              className="inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
              aria-label={`Remove ${tag} filter`}
            >
              <Badge style={getTagColorStyle(tag, false, isDarkMode)}>
                {tag}
                <X className="size-3" />
              </Badge>
            </button>
          ))}
          <input
            id={inputId}
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value)
              setActiveSuggestionIndex(-1)
              setIsSuggestionsOpen(true)
            }}
            onKeyDown={(event) =>
              handleFilterKeyDown({
                event,
                isSuggestionsOpen,
                suggestions: tagSuggestions,
                activeSuggestion,
                setActiveSuggestionIndex,
                setIsSuggestionsOpen,
                setSearchText,
                setSelectedTags,
                selectedTags,
              })
            }
            className="min-w-36 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/80"
            placeholder="Type to search. Press Tab to browse tags, then Space to add one."
            aria-autocomplete="list"
            aria-controls={`${inputId}-suggestions`}
            aria-expanded={isSuggestionsOpen && tagSuggestions.length > 0}
            aria-label="Filter tooling by text and tag"
          />
        </div>
        {isSuggestionsOpen && tagSuggestions.length > 0 ? (
          <div
            id={`${inputId}-suggestions`}
            ref={suggestionsRef}
            role="listbox"
            className="absolute right-0 left-0 z-20 mt-2 overflow-hidden rounded-2xl border border-border/70 bg-background/95 shadow-[0_24px_60px_-42px_rgba(8,34,64,0.8)] backdrop-blur"
          >
            {tagSuggestions.map((tag, index) => {
              const isActive = index === normalizedSuggestionIndex

              return (
                <button
                  key={tag}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    commitSuggestedTag({
                      suggestion: tag,
                      setSearchText,
                      setSelectedTags,
                    })
                    setActiveSuggestionIndex(-1)
                    setIsSuggestionsOpen(false)
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Badge style={getTagColorStyle(tag, false, isDarkMode)}>
                      {tag}
                    </Badge>
                    <span>Tag suggestion</span>
                  </div>
                  <span className="text-[0.65rem] tracking-[0.18em] uppercase">
                    {index === 0 ? "Top match" : `Match ${index + 1}`}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
