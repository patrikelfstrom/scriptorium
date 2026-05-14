// @vitest-environment jsdom

import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(),
}))

import { useVirtualizer } from "@tanstack/react-virtual"

import { ResultsTable } from "../../src/features/catalog/components/ResultsTable"
import type { CatalogRow, SortState } from "../../src/features/catalog/types"

const mockedUseVirtualizer = vi.mocked(useVirtualizer)
const baseRow: CatalogRow = {
  packageName: "react",
  packageUrl: "https://www.npmjs.com/package/react",
  packageDownloads: 1_000_000,
  tags: ["react"],
}
const sortState: SortState = {
  column: "name",
  direction: "asc",
}

describe("ResultsTable", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("debounces loading the live virtualized range", async () => {
    mockedUseVirtualizer.mockReturnValue({
      getTotalSize: () => 10_000,
      getVirtualItems: () => [
        { index: 30, key: "30", start: 2_040 },
        { index: 40, key: "40", start: 2_720 },
      ],
      measureElement: vi.fn(),
    } as never)

    const loadRowsForRange = vi.fn()

    render(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows={false}
        isLoading={false}
        loadRowsForRange={loadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={100}
      />
    )

    expect(loadRowsForRange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(119)
    })
    expect(loadRowsForRange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(loadRowsForRange).toHaveBeenCalledWith(30, 52)
  })

  it("falls back to the first page when virtual rows are not ready yet", async () => {
    mockedUseVirtualizer.mockReturnValue({
      getTotalSize: () => 10_000,
      getVirtualItems: () => [],
      measureElement: vi.fn(),
    } as never)

    const loadRowsForRange = vi.fn()

    render(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows={false}
        isLoading={false}
        loadRowsForRange={loadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={100}
      />
    )

    expect(loadRowsForRange).toHaveBeenCalledWith(0, 12)
  })

  it("cancels an outdated virtual range when scrolling continues before the debounce settles", () => {
    let virtualItems = [
      { index: 30, key: "30", start: 2_040 },
      { index: 40, key: "40", start: 2_720 },
    ]

    mockedUseVirtualizer.mockImplementation(
      () =>
        ({
          getTotalSize: () => 10_000,
          getVirtualItems: () => virtualItems,
          measureElement: vi.fn(),
        }) as never
    )

    const loadRowsForRange = vi.fn()
    const { rerender } = render(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows={false}
        isLoading={false}
        loadRowsForRange={loadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={100}
      />
    )

    act(() => {
      vi.advanceTimersByTime(60)
    })

    virtualItems = [
      { index: 120, key: "120", start: 8_160 },
      { index: 130, key: "130", start: 8_840 },
    ]

    rerender(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows={false}
        isLoading={false}
        loadRowsForRange={loadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={200}
      />
    )

    act(() => {
      vi.advanceTimersByTime(119)
    })
    expect(loadRowsForRange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(loadRowsForRange).toHaveBeenCalledTimes(1)
    expect(loadRowsForRange).toHaveBeenCalledWith(120, 142)
  })

  it("does not restart the debounce timer when only the load callback identity changes", () => {
    const virtualItems = [
      { index: 30, key: "30", start: 2_040 },
      { index: 40, key: "40", start: 2_720 },
    ]

    mockedUseVirtualizer.mockImplementation(
      () =>
        ({
          getTotalSize: () => 10_000,
          getVirtualItems: () => virtualItems,
          measureElement: vi.fn(),
        }) as never
    )

    const firstLoadRowsForRange = vi.fn()
    const secondLoadRowsForRange = vi.fn()
    const { rerender } = render(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows={false}
        isLoading={false}
        loadRowsForRange={firstLoadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={100}
      />
    )

    act(() => {
      vi.advanceTimersByTime(60)
    })

    rerender(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode
        isFetchingRows
        isLoading={false}
        loadRowsForRange={secondLoadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={100}
      />
    )

    act(() => {
      vi.advanceTimersByTime(59)
    })
    expect(firstLoadRowsForRange).not.toHaveBeenCalled()
    expect(secondLoadRowsForRange).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(firstLoadRowsForRange).not.toHaveBeenCalled()
    expect(secondLoadRowsForRange).toHaveBeenCalledTimes(1)
    expect(secondLoadRowsForRange).toHaveBeenCalledWith(30, 52)
  })

  it("resets a query change to the top range instead of fetching a stale deep range", () => {
    const virtualItems = [
      { index: 120, key: "120", start: 8_160 },
      { index: 130, key: "130", start: 8_840 },
    ]

    mockedUseVirtualizer.mockImplementation(
      () =>
        ({
          getTotalSize: () => 20_000,
          getVirtualItems: () => virtualItems,
          measureElement: vi.fn(),
        }) as never
    )

    const loadRowsForRange = vi.fn()
    const { rerender } = render(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows={false}
        isLoading={false}
        loadRowsForRange={loadRowsForRange}
        queryStateKey="react||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={200}
      />
    )

    act(() => {
      vi.advanceTimersByTime(120)
    })

    expect(loadRowsForRange).toHaveBeenCalledWith(120, 142)
    loadRowsForRange.mockClear()

    rerender(
      <ResultsTable
        errorMessage={undefined}
        isDarkMode={false}
        isFetchingRows
        isLoading={false}
        loadRowsForRange={loadRowsForRange}
        queryStateKey="react-router||name|asc"
        rows={[baseRow]}
        rowsByIndex={new Map([[0, baseRow]])}
        selectedTagSet={new Set()}
        setSelectedTags={vi.fn()}
        setSortState={vi.fn()}
        sortState={sortState}
        totalRows={200}
      />
    )

    expect(loadRowsForRange).toHaveBeenCalledTimes(1)
    expect(loadRowsForRange).toHaveBeenCalledWith(0, 12)

    act(() => {
      vi.advanceTimersByTime(120)
    })

    expect(loadRowsForRange).toHaveBeenCalledTimes(1)
    expect(loadRowsForRange).not.toHaveBeenCalledWith(120, 142)
  })
})
