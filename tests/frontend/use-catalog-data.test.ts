import { getIsCatalogSearchLoading } from "../../src/features/catalog/hooks/useCatalogData"

describe("getIsCatalogSearchLoading", () => {
  it("returns false once the search query settles with no results", () => {
    expect(getIsCatalogSearchLoading([{ isLoading: false }])).toBe(false)
  })

  it("returns true while the initial search query is still loading", () => {
    expect(getIsCatalogSearchLoading([{ isLoading: true }])).toBe(true)
  })

  it("defaults to loading before the first search query exists", () => {
    expect(getIsCatalogSearchLoading([])).toBe(true)
  })
})
