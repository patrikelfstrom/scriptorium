import { parseCatalogSearchParams } from "../../shared/catalog"
import {
  listCatalogTags,
  searchCatalog,
} from "../../server/catalog/read-service"
import {
  createTestCatalogDatabase,
  seedCatalogPackage,
} from "../helpers/catalog-test-db"

describe("catalog services", () => {
  it("searches catalog rows with filters, term tokenization, and cursors", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "react",
        displayName: "React",
        description: "UI library",
        npmPackageName: "react",
        repositoryName: "facebook/react",
        stars: 200_000,
        downloads: 1000,
        dependentPackagesCount: 500,
        tags: ["react", "ui"],
      })
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "vue",
        displayName: "Vue",
        description: "Progressive framework",
        npmPackageName: "vue",
        repositoryName: "vuejs/core",
        stars: 150_000,
        downloads: 800,
        dependentPackagesCount: 400,
        tags: ["vue", "ui"],
      })

      const result = await searchCatalog(
        database.client,
        parseCatalogSearchParams(
          new URLSearchParams({
            q: "ui facebook",
            tags: "ui",
            source: "npm",
            limit: "1",
          })
        )
      )

      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.name).toBe("React")
      expect(result.nextCursor).toBeNull()
      expect(result.totalApprox).toBe(1)
    } finally {
      await database.cleanup()
    }
  })

  it("sorts catalog rows by stars and tags", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "react",
        displayName: "React",
        stars: 200_000,
        tags: ["react", "ui"],
      })
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "astro",
        displayName: "Astro",
        stars: 45_000,
        tags: ["framework", "ssg"],
      })
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "vue",
        displayName: "Vue",
        stars: 150_000,
        tags: ["ui", "vue"],
      })

      const starsResult = await searchCatalog(
        database.client,
        parseCatalogSearchParams(
          new URLSearchParams({
            sort: "stars",
            direction: "desc",
          })
        )
      )
      const tagsResult = await searchCatalog(
        database.client,
        parseCatalogSearchParams(
          new URLSearchParams({
            sort: "tags",
            direction: "asc",
          })
        )
      )

      expect(starsResult.items.map((item) => item.name)).toEqual([
        "React",
        "Vue",
        "Astro",
      ])
      expect(tagsResult.items.map((item) => item.name)).toEqual([
        "React",
        "Vue",
        "Astro",
      ])
    } finally {
      await database.cleanup()
    }
  })

  it("lists tags with optional source filtering", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "react",
        tags: ["react", "ui"],
      })
      await seedCatalogPackage(database.client, {
        sourceType: "gh",
        sourceName: "facebook/react",
        tags: ["react", "opensource"],
      })

      const allTags = await listCatalogTags(database.client, {})
      const npmTags = await listCatalogTags(database.client, { source: "npm" })

      expect(allTags.items.map((tag) => tag.id)).toEqual(
        expect.arrayContaining(["react", "component-library", "opensource"])
      )
      expect(npmTags.items.map((tag) => tag.id)).toEqual(
        expect.arrayContaining(["react", "component-library"])
      )
      expect(npmTags.items.map((tag) => tag.id)).not.toContain("opensource")
    } finally {
      await database.cleanup()
    }
  })
})
