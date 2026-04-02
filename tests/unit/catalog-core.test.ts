import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  parseCatalogSearchParams,
  tokenizeCatalogQuery,
} from "../../shared/catalog"
import {
  createPackageKey,
  createPrimaryUrl,
  encodePackageNameForPage,
} from "../../server/catalog/package-store"
import {
  createTagLabel,
  normalizeTagValue,
} from "../../server/catalog/tag-normalization"

describe("catalog core helpers", () => {
  it("encodes and decodes cursors", () => {
    expect(decodeCatalogCursor(encodeCatalogCursor(123))).toBe(123)
    expect(decodeCatalogCursor("not-a-cursor")).toBe(0)
  })

  it("parses search params", () => {
    const params = parseCatalogSearchParams(
      new URLSearchParams({
        q: "  React Query  ",
        tags: "UI, frontend, ui",
        source: " NPM ",
        limit: "9999",
        cursor: encodeCatalogCursor(40),
      })
    )

    expect(params).toEqual({
      query: "React Query",
      tags: ["ui", "frontend"],
      source: "npm",
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
    expect(createTagLabel("static-site-generator")).toBe("static site generator")
  })

  it("builds package keys and URLs", () => {
    expect(createPackageKey("npm", "react")).toBe("npm:react")
    expect(createPrimaryUrl("gh", "facebook/react")).toBe("https://github.com/facebook/react")
    expect(createPrimaryUrl("npm", "@scope/pkg")).toBe(
      "https://www.npmjs.com/package/%40scope/pkg"
    )
    expect(encodePackageNameForPage("@scope/pkg")).toBe("%40scope/pkg")
  })
})
