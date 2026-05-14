import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  SetStateAction,
} from "react"

import type { SortState } from "./types"

export function toggleSortColumn(
  column: SortState["column"],
  setSortState: Dispatch<SetStateAction<SortState>>
) {
  setSortState((currentState) =>
    currentState.column === column
      ? {
          column,
          direction: currentState.direction === "asc" ? "desc" : "asc",
        }
      : { column, direction: "asc" }
  )
}

export function getAriaSort(column: SortState["column"], sortState: SortState) {
  if (sortState.column !== column) {
    return "none"
  }

  return sortState.direction === "asc" ? "ascending" : "descending"
}

export function getIsDarkMode(theme: "dark" | "light" | "system") {
  if (theme === "dark") {
    return true
  }

  if (theme === "light") {
    return false
  }

  if (typeof window === "undefined") {
    return false
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function normalizeValue(value: string) {
  return value.trim().toLowerCase()
}

export function getActiveToken(value: string) {
  const match = value.match(/^(.*?)(\S*)$/)

  return {
    prefix: match?.[1] ?? "",
    token: normalizeValue(match?.[2] ?? ""),
  }
}

export function getTagSuggestions(
  activeToken: string,
  selectedTags: string[],
  allTags: string[]
) {
  if (!activeToken) {
    return []
  }

  const selected = new Set(selectedTags.map(normalizeValue))

  return allTags
    .filter((tag) => !selected.has(tag))
    .map((tag) => ({
      tag,
      score: scoreSuggestion(tag, activeToken),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.tag.localeCompare(right.tag)
    )
    .slice(0, 5)
    .map((entry) => entry.tag)
}

export function handleFilterKeyDown({
  event,
  isSuggestionsOpen,
  suggestions,
  activeSuggestion,
  setActiveSuggestionIndex,
  setIsSuggestionsOpen,
  setSearchText,
  setSelectedTags,
  selectedTags,
}: {
  event: KeyboardEvent<HTMLInputElement>
  isSuggestionsOpen: boolean
  suggestions: string[]
  activeSuggestion?: string
  setActiveSuggestionIndex: Dispatch<SetStateAction<number>>
  setIsSuggestionsOpen: Dispatch<SetStateAction<boolean>>
  setSearchText: Dispatch<SetStateAction<string>>
  setSelectedTags: Dispatch<SetStateAction<string[]>>
  selectedTags: string[]
}) {
  if (event.key === "Tab" && isSuggestionsOpen && suggestions.length > 0) {
    event.preventDefault()
    setActiveSuggestionIndex((currentIndex) =>
      currentIndex < 0
        ? event.shiftKey
          ? suggestions.length - 1
          : 0
        : event.shiftKey
          ? (currentIndex - 1 + suggestions.length) % suggestions.length
          : (currentIndex + 1) % suggestions.length
    )
    return
  }

  if (event.key === "Enter" && isSuggestionsOpen) {
    event.preventDefault()
    setActiveSuggestionIndex(-1)
    setIsSuggestionsOpen(false)
    return
  }

  if (event.key === " " && activeSuggestion) {
    event.preventDefault()
    commitSuggestedTag({
      suggestion: activeSuggestion,
      setSearchText,
      setSelectedTags,
    })
    setActiveSuggestionIndex(-1)
    setIsSuggestionsOpen(false)
    return
  }

  if (
    event.key === "Backspace" &&
    event.currentTarget.value.length === 0 &&
    selectedTags.length > 0
  ) {
    event.preventDefault()
    removeSelectedTag(selectedTags[selectedTags.length - 1], setSelectedTags)
    return
  }

  if (event.key === "Escape") {
    setActiveSuggestionIndex(-1)
    setIsSuggestionsOpen(false)
  }
}

export function commitSuggestedTag({
  suggestion,
  setSearchText,
  setSelectedTags,
}: {
  suggestion: string
  setSearchText: Dispatch<SetStateAction<string>>
  setSelectedTags: Dispatch<SetStateAction<string[]>>
}) {
  setSelectedTags((currentTags) =>
    currentTags.includes(suggestion)
      ? currentTags
      : [...currentTags, suggestion]
  )
  setSearchText((currentText) =>
    `${getActiveToken(currentText).prefix}`.trimStart()
  )
}

export function toggleSelectedTag(
  tag: string,
  setSelectedTags: Dispatch<SetStateAction<string[]>>
) {
  const normalizedTag = normalizeValue(tag)

  setSelectedTags((currentTags) =>
    currentTags.includes(normalizedTag)
      ? currentTags.filter((currentTag) => currentTag !== normalizedTag)
      : [...currentTags, normalizedTag]
  )
}

export function removeSelectedTag(
  tagToRemove: string,
  setSelectedTags: Dispatch<SetStateAction<string[]>>
) {
  setSelectedTags((currentTags) =>
    currentTags.filter((tag) => tag !== tagToRemove)
  )
}

export function getTagColorStyle(
  tag: string,
  isSelected: boolean,
  isDarkMode: boolean
): CSSProperties {
  const hash = hashString(tag)
  const hue = Math.abs(hash) % 360
  const saturation = isSelected ? 72 : 62

  if (isDarkMode) {
    return {
      backgroundColor: `hsl(${hue} ${saturation}% ${isSelected ? 28 : 20}% / ${isSelected ? 0.95 : 0.85})`,
      borderColor: `hsl(${hue} ${Math.min(saturation + 6, 88)}% ${isSelected ? 60 : 52}% / 0.42)`,
      color: `hsl(${hue} ${Math.min(saturation + 8, 90)}% 82%)`,
    }
  }

  return {
    backgroundColor: `hsl(${hue} ${saturation}% ${isSelected ? 88 : 94}% / ${isSelected ? 0.95 : 0.9})`,
    borderColor: `hsl(${hue} ${Math.min(saturation + 6, 88)}% ${isSelected ? 52 : 58}% / 0.35)`,
    color: `hsl(${hue} ${Math.min(saturation + 8, 90)}% 30%)`,
  }
}

export function formatStarCount(stars?: number) {
  if (stars == null) {
    return ""
  }

  if (stars < 1_000) {
    return new Intl.NumberFormat(undefined).format(stars)
  }

  if (stars < 1_000_000) {
    return `${Math.round(stars / 1_000)}k`
  }

  return `${Math.round(stars / 1_000_000)}m`
}

export function formatDownloadCount(downloads?: number) {
  if (downloads == null) {
    return ""
  }

  if (downloads < 1_000) {
    return new Intl.NumberFormat(undefined).format(downloads)
  }

  if (downloads < 1_000_000) {
    return `${Math.round(downloads / 1_000)}k`
  }

  return `${Math.round(downloads / 1_000_000)}m`
}

export function formatDownloadCountTooltip(
  downloads?: number,
  period?: string
) {
  if (downloads == null) {
    return ""
  }

  const formattedDownloads = new Intl.NumberFormat(undefined).format(downloads)

  switch (period) {
    case "last-month":
      return `${formattedDownloads} npm downloads in the last 30 days`
    case "last-week":
      return `${formattedDownloads} npm downloads in the last 7 days`
    default:
      return `${formattedDownloads} npm downloads`
  }
}

export function formatPublishedDate(value?: string) {
  if (!value) {
    return ""
  }

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    return ""
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(parsed)
}

function scoreSuggestion(tag: string, token: string) {
  if (tag === token) {
    return 4
  }

  if (tag.startsWith(token)) {
    return 3
  }

  if (tag.includes(token)) {
    return 2
  }

  return 0
}

function hashString(value: string) {
  let hash = 0

  for (const character of value) {
    hash = (hash << 5) - hash + character.charCodeAt(0)
    hash |= 0
  }

  return hash
}
