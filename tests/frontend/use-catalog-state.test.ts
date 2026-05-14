// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useCatalogState } from "../../src/features/catalog/hooks/useCatalogState"

describe("useCatalogState", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    window.history.replaceState(null, "", "/")
  })

  it("pushes a new history entry when the search query changes", () => {
    window.history.replaceState(null, "", "/?sort=name&direction=asc")

    const pushStateSpy = vi.spyOn(window.history, "pushState")
    const replaceStateSpy = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useCatalogState())

    act(() => {
      result.current.setSearchText("react")
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(pushStateSpy).toHaveBeenCalledTimes(1)
    expect(replaceStateSpy).toHaveBeenCalledTimes(0)
    expect(window.location.search).toBe("?q=react&sort=name&direction=asc")
  })

  it("replaces the current history entry when only sorting changes", () => {
    window.history.replaceState(null, "", "/?q=react&sort=name&direction=asc")

    const pushStateSpy = vi.spyOn(window.history, "pushState")
    const replaceStateSpy = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useCatalogState())

    act(() => {
      result.current.setSortState({
        column: "stars",
        direction: "asc",
      })
    })

    expect(pushStateSpy).toHaveBeenCalledTimes(0)
    expect(replaceStateSpy).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe("?q=react&sort=stars&direction=asc")
  })

  it("keeps commas readable in the tags location param", () => {
    window.history.replaceState(null, "", "/?sort=name&direction=asc")

    const pushStateSpy = vi.spyOn(window.history, "pushState")
    const replaceStateSpy = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useCatalogState())

    act(() => {
      result.current.setSelectedTags([
        "dropdown",
        "Chacktoberfest",
        "positioning-engine",
      ])
    })

    expect(pushStateSpy).toHaveBeenCalledTimes(1)
    expect(replaceStateSpy).toHaveBeenCalledTimes(0)
    expect(window.location.search).toBe(
      "?tags=chacktoberfest,dropdown,positioning-engine&sort=name&direction=asc"
    )
  })

  it("does not rewrite history for equivalent tag filters with different order", () => {
    window.history.replaceState(
      null,
      "",
      "/?tags=react,zod&sort=name&direction=asc"
    )

    const pushStateSpy = vi.spyOn(window.history, "pushState")
    const replaceStateSpy = vi.spyOn(window.history, "replaceState")
    const { result } = renderHook(() => useCatalogState())

    act(() => {
      result.current.setSelectedTags(["zod", "react"])
    })

    expect(pushStateSpy).toHaveBeenCalledTimes(0)
    expect(replaceStateSpy).toHaveBeenCalledTimes(0)
    expect(window.location.search).toBe(
      "?tags=react,zod&sort=name&direction=asc"
    )
  })

  it("rehydrates state from the browser location on popstate", () => {
    window.history.replaceState(
      null,
      "",
      "/?q=react&tags=react-router,typescript&sort=downloads&direction=desc"
    )

    const { result } = renderHook(() => useCatalogState())

    act(() => {
      window.history.pushState(
        null,
        "",
        "/?q=svelte&tags=react,router&sort=stars&direction=asc"
      )
      window.dispatchEvent(new PopStateEvent("popstate"))
    })

    expect(result.current.searchText).toBe("svelte")
    expect(result.current.debouncedSearchText).toBe("svelte")
    expect(result.current.selectedTags).toEqual(["react", "router"])
    expect(result.current.sortState).toEqual({
      column: "stars",
      direction: "asc",
    })
  })
})
