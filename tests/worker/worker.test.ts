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

  it("serves cached search responses from Workers KV after the database is gone", async () => {
    const database = await createTestCatalogDatabase()
    const cache = createMockKvNamespace()

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
        CATALOG_CACHE: cache,
      }

      const request = new Request(
        "https://example.com/api/search?q=react%20facebook&sort=stars&direction=desc&limit=5"
      )
      const firstResponse = await worker.fetch(request, env)

      expect(firstResponse.status).toBe(200)
      expect(cache.putCalls).toHaveLength(1)

      await database.cleanup()

      const secondResponse = await worker.fetch(new Request(request.url), env)

      expect(secondResponse.status).toBe(200)
      expect(cache.getCalls).toHaveLength(2)

      const secondPayload = await secondResponse.json()

      expect(secondPayload.items[0]?.packageName).toBe("react")
      expect(secondPayload.totalApprox).toBe(1)
    } catch (error) {
      await database.cleanup()
      throw error
    }
  })

  it("serves cached tags responses from Workers KV without hitting the database", async () => {
    const cache = createMockKvNamespace()
    const databaseIdentity = "file:/tmp/scriptorium-missing.db"
    const requestUrl = "https://example.com/api/tags"

    await cache.put(
      await createCatalogCacheKey("tags", databaseIdentity, requestUrl),
      JSON.stringify({
        items: [{ id: "react", label: "React", packageCount: 12 }],
      })
    )

    const response = await worker.fetch(new Request(requestUrl), {
      TURSO_DATABASE_URL: databaseIdentity,
      TURSO_AUTH_TOKEN: undefined,
      CATALOG_CACHE: cache,
    })

    expect(response.status).toBe(200)
    expect(cache.getCalls).toHaveLength(1)
    expect(cache.putCalls).toHaveLength(1)
    expect(await response.json()).toEqual({
      items: [{ id: "react", label: "React", packageCount: 12 }],
    })
  })

  it("reuses the same KV entry for equivalent search URLs", async () => {
    const database = await createTestCatalogDatabase()
    const cache = createMockKvNamespace()

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
        CATALOG_CACHE: cache,
      }

      const firstResponse = await worker.fetch(
        new Request(
          "https://example.com/api/search?q=React%20%20facebook&tags=UI,react&sort=stars&direction=desc&limit=5"
        ),
        env
      )
      const secondResponse = await worker.fetch(
        new Request(
          "https://example.com/api/search?limit=5&direction=desc&sort=stars&tags=react,ui&q=react%20facebook"
        ),
        env
      )

      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      expect(cache.putCalls).toHaveLength(1)
      expect(cache.getCalls).toHaveLength(2)
      expect(cache.getCalls[0]).toBe(cache.getCalls[1])
      expect(cache.putCalls[0]?.key).toBe(cache.getCalls[0])
      expect(await firstResponse.json()).toEqual(await secondResponse.json())
    } finally {
      await database.cleanup()
    }
  })
})

async function createCatalogCacheKey(
  scope: "search" | "tags",
  databaseIdentity: string,
  requestUrl: string
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      ["v1", scope, databaseIdentity, requestUrl].join("\n")
    )
  )

  return `v1:${scope}:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`
}

function createMockKvNamespace() {
  const entries = new Map<string, string>()

  return {
    getCalls: [] as string[],
    putCalls: [] as Array<{
      key: string
      value: string
      expirationTtl?: number
    }>,
    async get(key: string, type: "json") {
      const rawValue = entries.get(key)

      this.getCalls.push(key)

      if (!rawValue) {
        return null
      }

      if (type === "json") {
        return JSON.parse(rawValue)
      }

      return rawValue
    },
    async put(
      key: string,
      value: string,
      options?: {
        expirationTtl?: number
      }
    ) {
      entries.set(key, value)
      this.putCalls.push({
        key,
        value,
        expirationTtl: options?.expirationTtl,
      })
    },
  }
}
