import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowUpRight } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"
import {
  useEffect,
  useRef,
} from "react"

import { Badge } from "@/components/ui/badge"

import {
  formatStarCount,
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
  fetchNextPage,
  hasNextPage,
  isDarkMode,
  isFetchingNextPage,
  isLoading,
  queryStateKey,
  rows,
  selectedTagSet,
  setSelectedTags,
  setSortState,
  sortState,
  totalRows,
}: {
  errorMessage?: string
  fetchNextPage: () => Promise<unknown>
  hasNextPage?: boolean
  isDarkMode: boolean
  isFetchingNextPage: boolean
  isLoading: boolean
  queryStateKey: string
  rows: CatalogRow[]
  selectedTagSet: Set<string>
  setSelectedTags: Dispatch<SetStateAction<string[]>>
  setSortState: Dispatch<SetStateAction<SortState>>
  sortState: SortState
  totalRows: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridTemplateColumns = "minmax(0,0.9fr) 7rem minmax(22rem,1.1fr)"
  const totalRowCount = Math.max(totalRows, rows.length)
  const columns = [
    {
      id: "name",
      accessorKey: "name",
      header: () => (
        <SortButton
          active={sortState.column === "name"}
          direction={sortState.direction}
          label="Name"
          onClick={() => toggleSortColumn("name", setSortState)}
        />
      ),
      cell: ({ row }: { row: { original: CatalogRow } }) => {
        const tool = row.original

        return (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              {tool.url ? (
                <a
                  className="inline-flex max-w-full min-w-0 items-center gap-2 transition-colors hover:text-primary"
                  href={tool.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="block min-w-0 truncate">{tool.name}</span>
                  <ArrowUpRight className="size-3.5 shrink-0" />
                </a>
              ) : (
                <span className="block min-w-0 truncate">{tool.name}</span>
              )}
              {tool.npmPackageName || tool.description ? (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
                  {tool.npmPackageUrl && tool.npmPackageName ? (
                    <a
                      href={tool.npmPackageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-mono transition-colors hover:text-foreground"
                    >
                      {tool.npmPackageName}
                    </a>
                  ) : null}
                  {tool.description ? (
                    <span className="block min-w-0 flex-1 truncate">
                      {tool.description}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {tool.github ? (
              <a
                className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/20"
                href={tool.github}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${tool.name} on GitHub`}
              >
                <GitHubIcon className="size-4" />
              </a>
            ) : null}
          </div>
        )
      },
    },
    {
      id: "stars",
      accessorFn: (row: CatalogRow) => row.stars ?? 0,
      header: () => (
        <SortButton
          active={sortState.column === "stars"}
          direction={sortState.direction}
          label="Stars"
          onClick={() => toggleSortColumn("stars", setSortState)}
        />
      ),
      cell: ({ row }: { row: { original: CatalogRow } }) =>
        formatStarCount(row.original.stars),
    },
    {
      id: "tags",
      accessorFn: (row: CatalogRow) => row.tags.join(" "),
      header: () => (
        <SortButton
          active={sortState.column === "tags"}
          direction={sortState.direction}
          label="Tags"
          onClick={() => toggleSortColumn("tags", setSortState)}
        />
      ),
      cell: ({ row }: { row: { original: CatalogRow } }) => (
        <div className="flex flex-wrap gap-2">
          {row.original.tags.map((tag) => {
            const isSelected = selectedTagSet.has(normalizeValue(tag))

            return (
              <button
                key={`${row.original.id}-${tag}`}
                type="button"
                onClick={() => toggleSelectedTag(tag, setSelectedTags)}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? "Remove" : "Add"} ${tag} filter`}
                className="rounded-full transition-transform outline-none hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-primary/20"
              >
                <Badge
                  className={isSelected ? "shadow-sm ring-2 ring-current/20" : undefined}
                  style={getTagColorStyle(tag, isSelected, isDarkMode)}
                >
                  {tag}
                </Badge>
              </button>
            )
          })}
        </div>
      ),
    },
  ]
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    state: {
      sorting: [
        {
          id: sortState.column,
          desc: sortState.direction === "desc",
        },
      ],
    },
  })
  const tableRows = table.getRowModel().rows
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

    if (!scrollElement || !hasNextPage || isFetchingNextPage || totalRowCount === 0) {
      return
    }

    const maybeLoadMore = () => {
      const visibleEndIndex =
        Math.ceil(
          (scrollElement.scrollTop + scrollElement.clientHeight) / ESTIMATED_ROW_HEIGHT
        ) + LOAD_AHEAD_ROWS

      if (visibleEndIndex >= rows.length && rows.length < totalRowCount) {
        void fetchNextPage()
      }
    }

    maybeLoadMore()
    scrollElement.addEventListener("scroll", maybeLoadMore)

    return () => {
      scrollElement.removeEventListener("scroll", maybeLoadMore)
    }
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    rows.length,
    totalRowCount,
    queryStateKey,
  ])

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
      <table
        data-slot="table"
        className="grid w-full caption-bottom text-sm"
      >
        <thead
          data-slot="table-header"
          className="sticky top-0 z-20 grid bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 [&_tr]:border-b [&_tr]:border-border/60"
        >
          {table.getHeaderGroups().map((headerGroup) => (
            <tr
              key={headerGroup.id}
              data-slot="table-row"
              className="grid border-b border-border/60 transition-colors hover:bg-transparent"
              style={{ gridTemplateColumns }}
            >
              {headerGroup.headers.map((header) => {
                const alignRight = header.id === "stars"

                return (
                  <th
                    key={header.id}
                    data-slot="table-head"
                    aria-sort={getAriaSort(header.id as SortState["column"], sortState)}
                    className={`flex h-11 items-center px-4 text-left text-[0.7rem] font-semibold tracking-[0.24em] text-muted-foreground uppercase ${
                      alignRight ? "justify-end text-right" : "justify-start"
                    }`}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody
          data-slot="table-body"
          className="relative grid [&_tr:last-child]:border-0"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {renderedRows.map(({ key, index, start }) => {
            const loadedRow = tableRows[index]

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
                {loadedRow
                  ? loadedRow.getVisibleCells().map((cell) => {
                      const alignRight = cell.column.id === "stars"

                      return (
                        <td
                          key={cell.id}
                          data-slot="table-cell"
                          className={`px-4 py-4 align-middle ${
                            cell.column.id === "name"
                              ? "min-w-0 font-medium text-foreground"
                              : ""
                          } ${alignRight ? "text-right text-muted-foreground tabular-nums" : ""}`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      )
                    })
                  : (
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
      {isFetchingNextPage ? (
        <div className="border-t border-border/60 bg-background/90 px-4 py-3 text-sm text-muted-foreground">
          Loading more tooling...
        </div>
      ) : null}
    </div>
  )
}

const LOAD_AHEAD_ROWS = 12
const ESTIMATED_ROW_HEIGHT = 68

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
              colSpan={3}
              className={`px-4 py-10 text-center text-sm ${
                tone === "destructive" ? "text-destructive" : "text-muted-foreground"
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
          <div className="h-3 w-72 rounded bg-muted/40" />
        </div>
      </td>
      <td
        data-slot="table-cell"
        className="px-4 py-4 text-right align-middle text-muted-foreground tabular-nums"
      >
        <div className="ml-auto h-4 w-12 rounded bg-muted/50" aria-hidden="true" />
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
