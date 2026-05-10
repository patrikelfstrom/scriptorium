import { useVirtualizer } from "@tanstack/react-virtual"
import { Link as LinkIcon } from "lucide-react"
import type { Dispatch, ReactNode, SetStateAction } from "react"
import { useEffect, useRef } from "react"

import { Badge } from "@/components/ui/badge"

import {
  formatStarCount,
  formatPublishedDate,
  getAriaSort,
  getTagColorStyle,
  normalizeValue,
  toggleSelectedTag,
  toggleSortColumn,
} from "../helpers"
import type { CatalogRow, SortState } from "../types"
import { GitHubIcon } from "./GitHubIcon"
import { SortButton } from "./SortButton"

export function ResultsTable({
  errorMessage,
  isDarkMode,
  isFetchingRows,
  isLoading,
  loadRowsForRange,
  queryStateKey,
  rows,
  rowsByIndex,
  selectedTagSet,
  setSelectedTags,
  setSortState,
  sortState,
  totalRows,
}: {
  errorMessage?: string
  isDarkMode: boolean
  isFetchingRows: boolean
  isLoading: boolean
  loadRowsForRange: (startIndex: number, endIndex: number) => void
  queryStateKey: string
  rows: CatalogRow[]
  rowsByIndex: Map<number, CatalogRow>
  selectedTagSet: Set<string>
  setSelectedTags: Dispatch<SetStateAction<string[]>>
  setSortState: Dispatch<SetStateAction<SortState>>
  sortState: SortState
  totalRows: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridTemplateColumns = "minmax(0,0.85fr) 7rem 8.5rem minmax(18rem,1fr)"
  const totalRowCount = Math.max(totalRows, rows.length)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's useVirtualizer API is required here.
  const rowVirtualizer = useVirtualizer({
    count: totalRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    measureElement: (element) =>
      element?.getBoundingClientRect().height ?? ESTIMATED_ROW_HEIGHT,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const fallbackRowIndices = Array.from(
    { length: Math.min(totalRowCount, 20) },
    (_, index) => index
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [queryStateKey])

  useEffect(() => {
    const scrollElement = scrollRef.current

    if (!scrollElement || totalRowCount === 0) {
      return
    }

    const maybeLoadVisibleRange = () => {
      const visibleStartIndex = Math.floor(
        scrollElement.scrollTop / ESTIMATED_ROW_HEIGHT
      )
      const visibleEndIndex =
        Math.ceil(
          (scrollElement.scrollTop + scrollElement.clientHeight) /
            ESTIMATED_ROW_HEIGHT
        ) + LOAD_AHEAD_ROWS

      loadRowsForRange(visibleStartIndex, visibleEndIndex)
    }
    let scrollIdleTimeoutId: number | undefined

    const debouncedLoadVisibleRange = () => {
      if (scrollIdleTimeoutId) {
        clearTimeout(scrollIdleTimeoutId)
      }

      scrollIdleTimeoutId = window.setTimeout(
        maybeLoadVisibleRange,
        SCROLL_LOAD_DEBOUNCE_MS
      )
    }

    maybeLoadVisibleRange()
    scrollElement.addEventListener("scroll", debouncedLoadVisibleRange, {
      passive: true,
    })

    return () => {
      if (scrollIdleTimeoutId) {
        clearTimeout(scrollIdleTimeoutId)
      }

      scrollElement.removeEventListener("scroll", debouncedLoadVisibleRange)
    }
  }, [loadRowsForRange, totalRowCount, queryStateKey])

  if (isLoading && rows.length === 0) {
    return <TableMessage message="Loading tooling catalog..." />
  }

  if (errorMessage && rows.length === 0) {
    return <TableMessage message={errorMessage} tone="destructive" />
  }

  if (!errorMessage && rows.length === 0) {
    return (
      <TableMessage message="No tooling matches this filter. Try removing a term or tag." />
    )
  }

  const renderedRows =
    virtualRows.length > 0
      ? virtualRows.map((virtualRow) => ({
          key: virtualRow.key,
          index: virtualRow.index,
          start: virtualRow.start,
        }))
      : fallbackRowIndices.map((index) => ({
          key: index,
          index,
          start: index * ESTIMATED_ROW_HEIGHT,
        }))

  if (renderedRows.length === 0) {
    return <TableMessage message="Loading tooling catalog..." />
  }

  return (
    <div
      ref={scrollRef}
      data-slot="table-container"
      className="relative min-h-0 flex-1 overflow-auto"
    >
      <table data-slot="table" className="grid w-full caption-bottom text-sm">
        <thead
          data-slot="table-header"
          className="sticky top-0 z-10 grid bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 [&_tr]:border-b [&_tr]:border-border/60"
        >
          <tr
            data-slot="table-row"
            className="grid border-b border-border/60 transition-colors hover:bg-transparent"
            style={{ gridTemplateColumns }}
          >
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("name", sortState)}
              className="flex h-11 items-center justify-start px-4 text-left text-[0.7rem] font-semibold tracking-[0.24em] text-muted-foreground uppercase"
            >
              <SortButton
                active={sortState.column === "name"}
                direction={sortState.direction}
                label="Name"
                onClick={() => toggleSortColumn("name", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("stars", sortState)}
              className="flex h-11 items-center justify-end px-4 text-right text-[0.7rem] font-semibold tracking-[0.24em] text-muted-foreground uppercase"
            >
              <SortButton
                active={sortState.column === "stars"}
                direction={sortState.direction}
                label="Stars"
                onClick={() => toggleSortColumn("stars", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("published", sortState)}
              className="flex h-11 items-center justify-start px-4 text-left text-[0.7rem] font-semibold tracking-[0.24em] text-muted-foreground uppercase"
            >
              <SortButton
                active={sortState.column === "published"}
                direction={sortState.direction}
                label="Published"
                onClick={() => toggleSortColumn("published", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              className="flex h-11 items-center justify-start px-4 text-left text-[0.7rem] font-semibold tracking-[0.24em] text-muted-foreground uppercase"
            >
              <span>Tags</span>
            </th>
          </tr>
        </thead>
        <tbody
          data-slot="table-body"
          className="relative grid [&_tr:last-child]:border-0"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {renderedRows.map(({ key, index, start }) => {
            const loadedRow = rowsByIndex.get(index)

            return (
              <tr
                key={key}
                data-slot="table-row"
                data-index={index}
                ref={loadedRow ? rowVirtualizer.measureElement : undefined}
                className="absolute grid w-full border-b border-border/60 bg-background/65 transition-colors odd:bg-muted/20 hover:bg-muted/30"
                style={{
                  gridTemplateColumns,
                  transform: `translateY(${start}px)`,
                }}
              >
                {loadedRow ? (
                  <LoadedRowCells
                    isDarkMode={isDarkMode}
                    row={loadedRow}
                    selectedTagSet={selectedTagSet}
                    setSelectedTags={setSelectedTags}
                  />
                ) : (
                  <LoadingRowCells />
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {errorMessage && rows.length > 0 ? (
        <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}
      {isFetchingRows ? (
        <div className="border-t border-border/60 bg-background/90 px-4 py-3 text-sm text-muted-foreground">
          Loading tooling...
        </div>
      ) : null}
    </div>
  )
}

const LOAD_AHEAD_ROWS = 12
const ESTIMATED_ROW_HEIGHT = 68
const GITHUB_REPOSITORY_LABEL_MAX_LENGTH = 200
const SCROLL_LOAD_DEBOUNCE_MS = 120

function TableMessage({
  message,
  tone = "muted",
}: {
  message: string
  tone?: "destructive" | "muted"
}) {
  return (
    <div className="relative size-full overflow-auto">
      <table className="w-full caption-bottom text-sm">
        <tbody>
          <tr className="border-b border-border/60 bg-background/65 transition-colors">
            <td
              colSpan={4}
              className={`px-4 py-10 text-center text-sm ${
                tone === "destructive"
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {message}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function LoadingRowCells() {
  return (
    <>
      <td data-slot="table-cell" className="w-0 px-4 py-4 align-middle">
        <div className="space-y-2" aria-hidden="true">
          <div className="h-4 w-48 rounded bg-muted/60" />
          <div className="h-3 w-32 rounded bg-muted/40" />
        </div>
      </td>
      <td
        data-slot="table-cell"
        className="px-4 py-4 text-right align-middle text-muted-foreground tabular-nums"
      >
        <div
          className="ml-auto h-4 w-12 rounded bg-muted/50"
          aria-hidden="true"
        />
      </td>
      <td data-slot="table-cell" className="px-4 py-4 align-middle">
        <div className="h-4 w-24 rounded bg-muted/40" aria-hidden="true" />
      </td>
      <td data-slot="table-cell" className="px-4 py-4 align-middle">
        <div className="flex flex-wrap gap-2" aria-hidden="true">
          <div className="h-6 w-16 rounded-full bg-muted/50" />
          <div className="h-6 w-20 rounded-full bg-muted/40" />
          <div className="h-6 w-14 rounded-full bg-muted/30" />
        </div>
      </td>
    </>
  )
}

function LoadedRowCells({
  isDarkMode,
  row,
  selectedTagSet,
  setSelectedTags,
}: {
  isDarkMode: boolean
  row: CatalogRow
  selectedTagSet: Set<string>
  setSelectedTags: Dispatch<SetStateAction<string[]>>
}) {
  const nameHref = row.packageUrl

  return (
    <>
      <td
        data-slot="table-cell"
        className="min-w-0 px-4 py-4 align-middle font-medium text-foreground"
      >
        <div className="flex min-w-0 items-center gap-4">
          <div className="min-w-0 flex-1">
            {nameHref ? (
              <a
                className="block min-w-0 truncate transition-colors hover:text-primary"
                href={nameHref}
                target="_blank"
                rel="noreferrer"
              >
                {row.packageName}
              </a>
            ) : (
              <span className="block min-w-0 truncate">{row.packageName}</span>
            )}
          </div>
          {row.repositoryUrl || row.packageUrl || row.homepageUrl ? (
            <div className="ml-auto flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
              {row.repositoryUrl ? (
                <MetadataLink
                  href={row.repositoryUrl}
                  label={truncateLabel(
                    row.repositoryLabel ?? "repository",
                    GITHUB_REPOSITORY_LABEL_MAX_LENGTH
                  )}
                  title={row.repositoryLabel ?? "repository"}
                  ariaLabel={row.repositoryLabel ?? "repository"}
                  icon={
                    isGitHubRepositoryUrl(row.repositoryUrl) ? (
                      <GitHubIcon className="size-3.5" />
                    ) : (
                      <LinkIcon className="size-3.5" />
                    )
                  }
                  monospace
                />
              ) : null}
              {row.packageUrl ? (
                <MetadataLink
                  href={row.packageUrl}
                  label="npm"
                  icon={<NpmIcon className="size-3.5" />}
                />
              ) : null}
              {row.homepageUrl ? (
                <MetadataLink
                  href={row.homepageUrl}
                  label="homepage"
                  icon={<LinkIcon className="size-3.5" />}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </td>
      <td
        data-slot="table-cell"
        className="px-4 py-4 text-right align-middle text-muted-foreground tabular-nums"
      >
        {formatStarCount(row.repositoryStars)}
      </td>
      <td
        data-slot="table-cell"
        className="px-4 py-4 align-middle text-muted-foreground tabular-nums"
      >
        {formatPublishedDate(row.packageLastPublishedAt) || "—"}
      </td>
      <td data-slot="table-cell" className="px-4 py-4 align-middle">
        <div className="flex flex-wrap gap-2">
          {row.tags.map((tag) => {
            const isSelected = selectedTagSet.has(normalizeValue(tag))

            return (
              <button
                key={`${row.packageName}-${tag}`}
                type="button"
                onClick={() => toggleSelectedTag(tag, setSelectedTags)}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? "Remove" : "Add"} ${tag} filter`}
                className="rounded-full transition-transform outline-none hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-primary/20"
              >
                <Badge
                  className={
                    isSelected ? "shadow-sm ring-2 ring-current/20" : undefined
                  }
                  style={getTagColorStyle(tag, isSelected, isDarkMode)}
                >
                  {tag}
                </Badge>
              </button>
            )
          })}
        </div>
      </td>
    </>
  )
}

function isGitHubRepositoryUrl(repositoryUrl?: string) {
  if (!repositoryUrl) {
    return false
  }

  try {
    return new URL(repositoryUrl).hostname === "github.com"
  } catch {
    return false
  }
}

function MetadataLink({
  ariaLabel,
  href,
  icon,
  label,
  monospace = false,
  title,
}: {
  ariaLabel?: string
  href: string
  icon?: ReactNode
  label: string
  monospace?: boolean
  title?: string
}) {
  return (
    <a
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1.5 underline decoration-border/80 underline-offset-4 transition-colors hover:text-foreground ${
        monospace ? "font-mono" : ""
      }`}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      {icon}
      <span>{label}</span>
    </a>
  )
}

function truncateLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function NpmIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M2.5 3.5h19v17h-19v-17Zm3 3v8h4v-5h2v5h2v-5h2v5h3v-8h-13Z" />
    </svg>
  )
}
