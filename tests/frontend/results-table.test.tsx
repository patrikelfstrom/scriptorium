// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

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
  })

  it("loads the live virtualized range without waiting for a scroll estimate", async () => {
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

    await waitFor(() => {
      expect(loadRowsForRange).toHaveBeenCalledWith(30, 52)
    })
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

    await waitFor(() => {
      expect(loadRowsForRange).toHaveBeenCalledWith(0, 12)
    })
  })
})
