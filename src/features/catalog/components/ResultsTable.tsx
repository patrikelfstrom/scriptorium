import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowDownToLine,
  CalendarDays,
  Link as LinkIcon,
  Star,
} from "lucide-react"
import type { Dispatch, ReactNode, SetStateAction } from "react"
import { useEffect, useRef } from "react"

import { Badge } from "@/components/ui/badge"

import {
  formatDownloadCount,
  formatDownloadCountTooltip,
  formatStarCount,
  formatPublishedDate,
  formatPublishedMonthYear,
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
  const loadRowsForRangeRef = useRef(loadRowsForRange)
  const hasMountedRef = useRef(false)
  const pendingQueryResetRef = useRef(false)
  const gridTemplateColumnsClass =
    "grid-cols-[minmax(16rem,1.15fr)_4rem_5rem_5.75rem_minmax(11rem,0.85fr)] sm:grid-cols-[minmax(14rem,0.9fr)_6rem_7.5rem_8rem_minmax(15rem,1fr)]"
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
  const loadRange = getLoadRangeForVirtualRows(virtualRows, totalRowCount)
  const loadRangeStartIndex = loadRange?.startIndex ?? null
  const loadRangeEndIndex = loadRange?.endIndex ?? null
  const hasRows = totalRowCount > 0
  const topLoadEndIndex = getTopLoadEndIndex(totalRowCount)

  useEffect(() => {
    loadRowsForRangeRef.current = loadRowsForRange
  }, [loadRowsForRange])

  useEffect(() => {
    if (hasMountedRef.current) {
      pendingQueryResetRef.current = true
    } else {
      hasMountedRef.current = true
    }

    scrollRef.current?.scrollTo({ top: 0 })
  }, [queryStateKey])

  useEffect(() => {
    if (!hasRows) {
      return
    }

    if (pendingQueryResetRef.current) {
      pendingQueryResetRef.current = false
      loadRowsForRangeRef.current(0, topLoadEndIndex)
      return
    }

    if (loadRangeStartIndex === null || loadRangeEndIndex === null) {
      loadRowsForRangeRef.current(0, topLoadEndIndex)
      return
    }

    const timeoutId = window.setTimeout(() => {
      loadRowsForRangeRef.current(loadRangeStartIndex, loadRangeEndIndex)
    }, RANGE_LOAD_DEBOUNCE_MS)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [
    hasRows,
    loadRangeEndIndex,
    loadRangeStartIndex,
    queryStateKey,
    topLoadEndIndex,
  ])

  if (isLoading && rows.length === 0) {
    return <TableMessage message="Loading packages…" />
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
    return <TableMessage message="Loading packages…" />
  }

  return (
    <div
      ref={scrollRef}
      data-slot="table-container"
      className="relative min-h-0 flex-1 overflow-auto overscroll-x-contain"
    >
      <table
        data-slot="table"
        className="grid w-full min-w-[43rem] caption-bottom text-sm sm:min-w-[54rem]"
      >
        <thead
          data-slot="table-header"
          className="sticky top-0 z-10 grid bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 [&_tr]:border-b [&_tr]:border-border/60"
        >
          <tr
            data-slot="table-row"
            className={`${gridTemplateColumnsClass} grid border-b border-border/60 transition-colors hover:bg-transparent`}
          >
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("name", sortState)}
              className="flex h-11 items-center justify-start px-3 text-left text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase sm:px-4 sm:text-[0.7rem] sm:tracking-[0.24em]"
            >
              <SortButton
                active={sortState.column === "name"}
                ariaLabel="Sort by name"
                direction={sortState.direction}
                label="Name"
                onClick={() => toggleSortColumn("name", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("stars", sortState)}
              className="flex h-11 items-center justify-end px-3 text-right text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase sm:px-4 sm:text-[0.7rem] sm:tracking-[0.24em]"
            >
              <SortButton
                active={sortState.column === "stars"}
                ariaLabel="Sort by stars"
                direction={sortState.direction}
                label={
                  <>
                    <Star className="size-3.5 sm:hidden" aria-hidden="true" />
                    <span className="hidden sm:inline">Stars</span>
                  </>
                }
                onClick={() => toggleSortColumn("stars", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("downloads", sortState)}
              className="flex h-11 items-center justify-end px-3 text-right text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase sm:px-4 sm:text-[0.7rem] sm:tracking-[0.24em]"
            >
              <SortButton
                active={sortState.column === "downloads"}
                ariaLabel="Sort by downloads"
                direction={sortState.direction}
                label={
                  <>
                    <ArrowDownToLine
                      className="size-3.5 sm:hidden"
                      aria-hidden="true"
                    />
                    <span className="hidden sm:inline">Downloads</span>
                  </>
                }
                onClick={() => toggleSortColumn("downloads", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              aria-sort={getAriaSort("published", sortState)}
              className="flex h-11 items-center justify-start px-3 text-left text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase sm:px-4 sm:text-[0.7rem] sm:tracking-[0.24em]"
            >
              <SortButton
                active={sortState.column === "published"}
                ariaLabel="Sort by published date"
                direction={sortState.direction}
                label={
                  <>
                    <CalendarDays
                      className="size-3.5 sm:hidden"
                      aria-hidden="true"
                    />
                    <span className="hidden sm:inline">Published</span>
                  </>
                }
                onClick={() => toggleSortColumn("published", setSortState)}
              />
            </th>
            <th
              data-slot="table-head"
              className="flex h-11 items-center justify-start px-3 text-left text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase sm:px-4 sm:text-[0.7rem] sm:tracking-[0.24em]"
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
                className={`${gridTemplateColumnsClass} absolute grid w-full border-b border-border/60 bg-background/65 transition-colors odd:bg-muted/20 hover:bg-muted/30`}
                style={{
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
          Loading tooling…
        </div>
      ) : null}
    </div>
  )
}

const LOAD_AHEAD_ROWS = 12
const ESTIMATED_ROW_HEIGHT = 92
const GITHUB_REPOSITORY_LABEL_MAX_LENGTH = 48
const RANGE_LOAD_DEBOUNCE_MS = 120

function getLoadRangeForVirtualRows(
  virtualRows: Array<{ index: number }>,
  totalRowCount: number
) {
  if (totalRowCount === 0 || virtualRows.length === 0) {
    return null
  }

  const startIndex = Math.max(0, virtualRows[0]?.index ?? 0)
  const endIndex = Math.min(
    totalRowCount - 1,
    (virtualRows[virtualRows.length - 1]?.index ?? startIndex) + LOAD_AHEAD_ROWS
  )

  return {
    endIndex,
    startIndex,
  }
}

function getTopLoadEndIndex(totalRowCount: number) {
  return Math.max(0, Math.min(totalRowCount - 1, LOAD_AHEAD_ROWS))
}

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
              colSpan={5}
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
      <td data-slot="table-cell" className="w-0 p-3 align-middle sm:p-4">
        <div className="space-y-2" aria-hidden="true">
          <div className="h-4 w-48 rounded bg-muted/60" />
          <div className="h-3 w-32 rounded bg-muted/40" />
        </div>
      </td>
      <td
        data-slot="table-cell"
        className="p-3 text-right align-middle text-muted-foreground tabular-nums sm:p-4"
      >
        <div
          className="ml-auto h-4 w-12 rounded bg-muted/50"
          aria-hidden="true"
        />
      </td>
      <td
        data-slot="table-cell"
        className="p-3 text-right align-middle text-muted-foreground tabular-nums sm:p-4"
      >
        <div
          className="ml-auto h-4 w-16 rounded bg-muted/40"
          aria-hidden="true"
        />
      </td>
      <td data-slot="table-cell" className="p-3 align-middle sm:p-4">
        <div className="h-4 w-24 rounded bg-muted/40" aria-hidden="true" />
      </td>
      <td data-slot="table-cell" className="p-3 align-middle sm:p-4">
        <div className="flex flex-wrap gap-1.5 sm:gap-2" aria-hidden="true">
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
  const downloadsTooltip = formatDownloadCountTooltip(
    row.packageDownloads,
    row.packageDownloadsPeriod
  )
  const publishedDate = formatPublishedDate(row.packageLastPublishedAt)
  const publishedMonthYear = formatPublishedMonthYear(
    row.packageLastPublishedAt
  )

  return (
    <>
      <td
        data-slot="table-cell"
        className="min-w-0 p-3 align-middle font-medium text-foreground sm:p-4"
      >
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <div className="min-w-0 flex-1">
            {nameHref ? (
              <a
                className="block min-w-0 leading-tight break-words whitespace-normal transition-colors hover:text-primary sm:truncate"
                href={nameHref}
                target="_blank"
                rel="noreferrer"
              >
                {row.packageName}
              </a>
            ) : (
              <span className="block min-w-0 leading-tight break-words whitespace-normal sm:truncate">
                {row.packageName}
              </span>
            )}
          </div>
          {row.repositoryUrl || row.packageUrl || row.homepageUrl ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.7rem] text-muted-foreground min-[1200px]:max-w-[45%] min-[1200px]:min-w-0 min-[1200px]:shrink sm:ml-auto sm:shrink-0 sm:flex-nowrap sm:gap-4 sm:text-xs">
              {row.repositoryUrl ? (
                <MetadataLink
                  href={row.repositoryUrl}
                  label={truncateLabel(
                    row.repositoryLabel ?? "repository",
                    GITHUB_REPOSITORY_LABEL_MAX_LENGTH
                  )}
                  labelClassName="hidden min-[1200px]:block min-w-0 truncate"
                  title={row.repositoryLabel ?? "repository"}
                  ariaLabel={row.repositoryLabel ?? "repository"}
                  className="min-w-0 min-[1200px]:min-w-0 min-[1200px]:flex-1 min-[1200px]:basis-0 sm:shrink-0"
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
                  className="shrink-0"
                  label="npm"
                  labelClassName="hidden whitespace-nowrap min-[2000px]:inline"
                  icon={<NpmIcon className="size-3.5" />}
                  truncateLabel={false}
                />
              ) : null}
              {row.homepageUrl ? (
                <MetadataLink
                  href={row.homepageUrl}
                  className="shrink-0"
                  label="homepage"
                  labelClassName="hidden whitespace-nowrap min-[2000px]:inline"
                  icon={<LinkIcon className="size-3.5" />}
                  truncateLabel={false}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </td>
      <td
        data-slot="table-cell"
        className="p-3 text-right align-middle text-muted-foreground tabular-nums sm:p-4"
      >
        {formatStarCount(row.repositoryStars)}
      </td>
      <td
        data-slot="table-cell"
        className="p-3 text-right align-middle text-muted-foreground tabular-nums sm:p-4"
      >
        <span aria-label={downloadsTooltip} title={downloadsTooltip}>
          {formatDownloadCount(row.packageDownloads)}
        </span>
      </td>
      <td
        data-slot="table-cell"
        className="p-3 align-middle text-muted-foreground tabular-nums sm:p-4"
      >
        {publishedDate || publishedMonthYear ? (
          <>
            <span className="whitespace-nowrap sm:hidden">
              {publishedMonthYear}
            </span>
            <span className="hidden whitespace-nowrap sm:inline">
              {publishedDate}
            </span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td data-slot="table-cell" className="p-3 align-middle sm:p-4">
        <div className="flex flex-wrap gap-1.5 sm:gap-2">
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
  className,
  href,
  icon,
  label,
  labelClassName,
  monospace = false,
  title,
  truncateLabel = true,
}: {
  ariaLabel?: string
  className?: string
  href: string
  icon?: ReactNode
  label: string
  labelClassName?: string
  monospace?: boolean
  title?: string
  truncateLabel?: boolean
}) {
  return (
    <a
      aria-label={ariaLabel}
      className={`inline-flex min-w-0 items-center gap-1 underline decoration-border/80 underline-offset-4 transition-colors hover:text-foreground sm:gap-1.5 ${
        monospace ? "font-mono" : ""
      } ${className ?? ""}`}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span
        className={
          labelClassName ??
          `hidden min-w-0 min-[1200px]:block ${
            truncateLabel ? "truncate" : "whitespace-nowrap"
          }`
        }
      >
        {label}
      </span>
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
