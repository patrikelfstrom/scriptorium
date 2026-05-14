import worker from "../../worker"
import {
  createTestCatalogDatabase,
  seedCatalogPackage,
} from "../helpers/catalog-test-db"

describe("worker routes", () => {
  it("returns search and tags responses", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        packageName: "react",
        repositoryUrl: "https://github.com/facebook/react",
        repositoryStars: 200_000,
        packageTags: ["react", "ui"],
      })

      const env = {
        TURSO_DATABASE_URL: database.url,
        TURSO_AUTH_TOKEN: undefined,
      }

      const searchResponse = await worker.fetch(
        new Request(
          "https://example.com/api/search?q=react%20facebook&sort=stars&direction=desc&limit=5"
        ),
        env
      )
      const tagsResponse = await worker.fetch(
        new Request("https://example.com/api/tags"),
        env
      )

      expect(searchResponse.status).toBe(200)
      expect(tagsResponse.status).toBe(200)
      expect(searchResponse.headers.get("Cache-Control")).toBe(
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400"
      )
      expect(tagsResponse.headers.get("Cache-Control")).toBe(
        "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400"
      )

      const searchPayload = await searchResponse.json()
      const tagsPayload = await tagsResponse.json()

      expect(searchPayload.items[0]?.packageName).toBe("react")
      expect(searchPayload.totalApprox).toBe(1)
      expect(tagsPayload.items.map((tag: { id: string }) => tag.id)).toEqual(
        expect.arrayContaining(["react", "component-library"])
      )
    } finally {
      await database.cleanup()
    }
  })
})
