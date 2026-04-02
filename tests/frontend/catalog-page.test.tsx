// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { ThemeProvider } from "@/components/theme-provider"
import { CatalogPage } from "@/features/catalog/CatalogPage"
import { createCatalogApiUrl } from "@/features/catalog/api"

function renderCatalogPage(url = "/") {
  window.history.replaceState({}, "", url)

  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ThemeProvider>
        <CatalogPage />
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe("CatalogPage", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(options?: ScrollToOptions) {
        this.scrollTop = options?.top ?? 0
      },
    })

    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value() {
        return {
          width: 1200,
          height: 420,
          top: 0,
          left: 0,
          bottom: 420,
          right: 1200,
          x: 0,
          y: 0,
          toJSON() {
            return {}
          },
        }
      },
    })

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 420
      },
    })

    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it("hydrates URL state and renders server-sorted rows", async () => {
    const fetchMock = vi.fn(createSuccessFetch)
    vi.stubGlobal("fetch", fetchMock)

    renderCatalogPage(
      "/?q=react&tags=ui&sort=stars&direction=desc"
    )

    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("react")

    await screen.findByText("React")

    const rows = screen.getAllByRole("row")
    expect(rows[1]?.textContent).toContain("React")
    expect(window.location.search).toContain("sort=stars")
    expect(fetchMock.mock.calls.some(([request]) =>
      String(request).includes("q=react")
    )).toBe(true)
  })

  it("keeps the virtualized table inside a constrained viewport shell", async () => {
    vi.stubGlobal("fetch", vi.fn(createSuccessFetch))

    renderCatalogPage()
    await screen.findByText("React")

    expect(screen.getByRole("main").className).toContain("h-svh")

    const tableContainer = document.querySelector('[data-slot="table-container"]')
    expect(tableContainer).not.toBeNull()
    expect((tableContainer as HTMLElement).className).toContain("flex-1")
    expect((tableContainer as HTMLElement).className).toContain("overflow-auto")
  })

  it("reserves scroll height for unloaded rows without prefetching all pages", async () => {
    const fetchMock = vi.fn(createSuccessFetch)
    vi.stubGlobal("fetch", fetchMock)

    renderCatalogPage()
    await screen.findByText("React")

    const tableBody = document.querySelector('[data-slot="table-body"]')
    expect(tableBody).not.toBeNull()
    expect(Number.parseInt((tableBody as HTMLElement).style.height, 10)).toBeGreaterThan(
      30 * 92
    )
    expect(
      fetchMock.mock.calls.some(([request]) =>
        String(request).includes("cursor=page-30")
      )
    ).toBe(false)
  })

  it("debounces search updates into the URL and refetches", async () => {
    const fetchMock = vi.fn(createSuccessFetch)
    vi.stubGlobal("fetch", fetchMock)

    renderCatalogPage()
    await screen.findByText("React")

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "something-that-will-not-match" },
    })

    expect(window.location.search).toBe("?sort=name&direction=asc")

    await waitFor(() => {
      expect(window.location.search).toContain("q=something-that-will-not-match")
    })
    expect(
      await screen.findByText("No tooling matches this filter. Try removing a term or tag.")
    ).toBeTruthy()
    expect(
      fetchMock.mock.calls.filter(([request]) =>
        String(request).includes("q=something-that-will-not-match")
      ).length
    ).toBeGreaterThan(0)
  })

  it("updates URL-backed tags and sort from table interactions", async () => {
    vi.stubGlobal("fetch", vi.fn(createSuccessFetch))

    renderCatalogPage()
    await screen.findByText("React")

    fireEvent.click(screen.getByRole("button", { name: "Stars" }))

    await waitFor(() => {
      expect(window.location.search).toContain("sort=stars")
      expect(window.location.search).toContain("direction=asc")
    })

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "framework" },
    })

    const suggestionLabel = await screen.findByText("Tag suggestion")
    fireEvent.click(suggestionLabel.closest("button")!)

    await waitFor(() => {
      expect(window.location.search).toContain("tags=framework")
    })
  })

  it("shows an error state when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("boom", {
          status: 500,
        })
      )
    )

    renderCatalogPage()

    expect(await screen.findByText("Search request failed with 500.")).toBeTruthy()
  })

  it("loads the next page when scrolling near the end of the virtualized list", async () => {
    const fetchMock = vi.fn(createSuccessFetch)
    vi.stubGlobal("fetch", fetchMock)

    renderCatalogPage()
    await screen.findByText("React")

    const container = document.querySelector('[data-slot="table-container"]')
    expect(container).toBeTruthy()

    Object.defineProperty(container!, "scrollTop", {
      configurable: true,
      writable: true,
      value: 18_000,
    })

    fireEvent.scroll(container!)

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([request]) =>
          String(request).includes("cursor=page-30")
        )
      ).toBe(true)
    })
  })

  it("uses the configured API base URL", () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/")

    expect(createCatalogApiUrl("/api/search", new URLSearchParams({ limit: "5" }))).toBe(
      "https://api.example.com/api/search?limit=5"
    )
  })
})

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
}

function createSuccessFetch(request: RequestInfo | URL) {
  const url = new URL(String(request), "https://example.com")

  if (url.pathname === "/api/search") {
    const response = buildSearchResponse(url.searchParams)

    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    )
  }

  return Promise.resolve(
    new Response(
      JSON.stringify({
        items: [
          { id: "framework", label: "framework", packageCount: 208 },
          { id: "react", label: "react", packageCount: 1 },
          { id: "ssg", label: "ssg", packageCount: 1 },
          { id: "ui", label: "ui", packageCount: 2 },
          { id: "vue", label: "vue", packageCount: 1 },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    )
  )
}

function buildSearchResponse(searchParams: URLSearchParams) {
  const query = (searchParams.get("q") ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const selectedTags = (searchParams.get("tags") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const sort = searchParams.get("sort") ?? "name"
  const direction = searchParams.get("direction") ?? "asc"
  const limit = Number(searchParams.get("limit") ?? 200)
  const offset = Number((searchParams.get("cursor") ?? "page-0").replace("page-", ""))

  let items = buildCatalogItems().filter((item) => {
    const searchableText = [
      item.name,
      item.description,
      item.repositoryName,
      item.npmPackageName,
      item.tags.join(" "),
    ]
      .join(" ")
      .toLowerCase()

    return (
      query.every((term) => searchableText.includes(term))
      && selectedTags.every((tag) => item.tags.includes(tag))
    )
  })

  items = items.sort((left, right) => {
    const multiplier = direction === "desc" ? -1 : 1

    if (sort === "stars") {
      const starDelta = (left.stars ?? 0) - (right.stars ?? 0)
      if (starDelta !== 0) {
        return starDelta * multiplier
      }
    } else if (sort === "tags") {
      const tagDelta = left.tags.join(" ").localeCompare(right.tags.join(" "))
      if (tagDelta !== 0) {
        return tagDelta * multiplier
      }
    } else {
      const nameDelta = left.name.localeCompare(right.name)
      if (nameDelta !== 0) {
        return nameDelta * multiplier
      }
    }

    return left.name.localeCompare(right.name)
  })

  const pageItems = items.slice(offset, offset + limit)
  const nextCursor = offset + limit < items.length ? `page-${offset + limit}` : null

  return {
    items: pageItems,
    nextCursor,
    totalApprox: items.length,
  }
}

function buildCatalogItems() {
  const featured = [
    {
      packageKey: "npm:react",
      sourceType: "npm",
      sourceName: "react",
      name: "React",
      description: "UI library",
      url: "https://react.dev",
      repositoryName: "facebook/react",
      npmPackageName: "react",
      stars: 200_000,
      downloads: 1000,
      downloadsPeriod: "last-month",
      dependentPackagesCount: 500,
      tags: ["react", "ui"],
    },
    {
      packageKey: "npm:vue",
      sourceType: "npm",
      sourceName: "vue",
      name: "Vue",
      description: "Progressive framework",
      url: "https://vuejs.org",
      repositoryName: "vuejs/core",
      npmPackageName: "vue",
      stars: 150_000,
      downloads: 800,
      downloadsPeriod: "last-month",
      dependentPackagesCount: 400,
      tags: ["ui", "vue"],
    },
    {
      packageKey: "npm:astro",
      sourceType: "npm",
      sourceName: "astro",
      name: "Astro",
      description: "Static site framework",
      url: "https://astro.build",
      repositoryName: "withastro/astro",
      npmPackageName: "astro",
      stars: 45_000,
      downloads: 700,
      downloadsPeriod: "last-month",
      dependentPackagesCount: 250,
      tags: ["framework", "ssg"],
    },
  ]

  const generated = Array.from({ length: 207 }, (_, index) => ({
    packageKey: `npm:tool-${index}`,
    sourceType: "npm",
    sourceName: `tool-${index}`,
    name: `Tool ${String(index).padStart(3, "0")}`,
    description: `Generated library ${index}`,
    url: `https://example.com/tool-${index}`,
    repositoryName: `example/tool-${index}`,
    npmPackageName: `tool-${index}`,
    stars: 1_000 - index,
    downloads: 100,
    downloadsPeriod: "last-month",
    dependentPackagesCount: 10,
    tags: ["framework"],
  }))

  return [...featured, ...generated]
}
