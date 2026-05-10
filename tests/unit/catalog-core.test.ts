import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseCatalogSearchParams,
  tokenizeCatalogQuery,
} from "../../shared/catalog"
import {
  getCatalogPageCursorForOffset,
  getCatalogPageOffsetForIndex,
  getCatalogPageOffsetsForRange,
} from "../../src/features/catalog/paging"
import {
  createPackageUrl,
  encodePackageNameForPage,
} from "../../server/catalog/package-store"
import {
  parseGitHubRepositoryRef,
  selectTopDownloadCountEntries,
} from "../../server/catalog/npm-sync-service"
import {
  createTagLabel,
  normalizeTagValue,
} from "../../server/catalog/tag-normalization"

describe("catalog core helpers", () => {
  it("encodes and decodes cursors", () => {
    expect(decodeCatalogCursor(encodeCatalogCursor(123))).toBe(123)
    expect(decodeCatalogCursor("not-a-cursor")).toBe(0)
  })

  it("maps row ranges to page offsets without walking intermediate pages", () => {
    expect(getCatalogPageOffsetForIndex(9_999)).toBe(9_990)
    expect(getCatalogPageCursorForOffset(9_990)).toBe(
      encodeCatalogCursor(9_990)
    )
    expect(getCatalogPageOffsetsForRange(9_999, 10_002)).toEqual([9_990])
    expect(getCatalogPageOffsetsForRange(55, 91)).toEqual([30, 60, 90])
  })

  it("parses search params", () => {
    const params = parseCatalogSearchParams(
      new URLSearchParams({
        q: "  React Query  ",
        tags: "UI, frontend, ui",
        limit: "9999",
        cursor: encodeCatalogCursor(40),
        sort: "tags",
      })
    )

    expect(params).toEqual({
      query: "React Query",
      tags: ["ui", "frontend"],
      limit: 1000,
      cursor: encodeCatalogCursor(40),
      sort: "name",
      direction: "asc",
      offset: 40,
    })
  })

  it("tokenizes search queries with lowercase AND terms", () => {
    expect(tokenizeCatalogQuery("  React   Query ui ")).toEqual([
      "react",
      "query",
      "ui",
    ])
  })

  it("normalizes tags and labels", () => {
    expect(normalizeTagValue("Front End")).toBe("front-end")
    expect(normalizeTagValue("cms")).toBe("content-management-system")
    expect(createTagLabel("static-site-generator")).toBe(
      "static site generator"
    )
  })

  it("builds package URLs", () => {
    expect(createPackageUrl("@scope/pkg")).toBe(
      "https://www.npmjs.com/package/%40scope/pkg"
    )
    expect(encodePackageNameForPage("@scope/pkg")).toBe("%40scope/pkg")
  })

  it("selects top download count entries", () => {
    expect(
      selectTopDownloadCountEntries(
        [
          { packageName: "b", packageDownloads: 2 },
          { packageName: "a", packageDownloads: 2 },
          { packageName: "c", packageDownloads: 1 },
        ],
        2
      )
    ).toEqual([
      { packageName: "a", packageDownloads: 2 },
      { packageName: "b", packageDownloads: 2 },
    ])
  })

  it("selects a stable shard from the top download count entries", () => {
    const entries = [
      { packageName: "alpha", packageDownloads: 5 },
      { packageName: "beta", packageDownloads: 4 },
      { packageName: "gamma", packageDownloads: 3 },
      { packageName: "delta", packageDownloads: 2 },
      { packageName: "epsilon", packageDownloads: 1 },
    ]

    const shardZero = selectTopDownloadCountEntries(entries, {
      topPackageLimit: 5,
      shardCount: 2,
      shardIndex: 0,
    })
    const shardOne = selectTopDownloadCountEntries(entries, {
      topPackageLimit: 5,
      shardCount: 2,
      shardIndex: 1,
    })

    expect(
      [...shardZero, ...shardOne].map((entry) => entry.packageName).sort()
    ).toEqual(entries.map((entry) => entry.packageName).sort())
    expect(shardZero.every((entry) => !shardOne.includes(entry))).toBe(true)
  })

  it("parses GitHub repository refs from normalized repository URLs", () => {
    expect(
      parseGitHubRepositoryRef("https://github.com/facebook/react")
    ).toEqual({
      owner: "facebook",
      name: "react",
    })
    expect(parseGitHubRepositoryRef("facebook/react")).toEqual({
      owner: "facebook",
      name: "react",
    })
    expect(
      parseGitHubRepositoryRef("git+ssh://git@github.com/facebook/react.git")
    ).toEqual({
      owner: "facebook",
      name: "react",
    })
    expect(
      parseGitHubRepositoryRef(
        "git+https://github.com/facebook/react.git#readme"
      )
    ).toEqual({
      owner: "facebook",
      name: "react",
    })
    expect(
      parseGitHubRepositoryRef("https://gitlab.com/example/project")
    ).toBeUndefined()
  })
})
