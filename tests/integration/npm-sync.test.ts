import { syncNpmCatalog } from "../../server/catalog/admin-service"
import { ensureCatalogSchema } from "../../server/catalog/schema"
import { createTestCatalogDatabase } from "../helpers/catalog-test-db"

describe("npm catalog sync", () => {
  it("syncs npm metadata and GitHub enrichment", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        return createJsonResponse({
          "dist-tags": { latest: "19.0.0" },
          time: {
            "19.0.0": "2026-01-01T00:00:00.000Z",
          },
          versions: {
            "19.0.0": {
              description: "UI library",
              homepage: "https://react.dev",
              repository: {
                url: "git+https://github.com/facebook/react.git",
              },
              keywords: ["react", "ui"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        return createJsonResponse({
          data: {
            repo_0: {
              stargazerCount: 200_000,
              repositoryTopics: {
                nodes: [{ topic: { name: "frontend" } }],
              },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const result = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
        ],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            package_name,
            repository_url,
            package_url,
            package_description,
            homepage_url,
            repository_stars,
            package_downloads,
            package_downloads_period,
            package_last_published_at
          FROM packages
        `,
      })
      const packageTags = await database.client.execute({
        sql: `SELECT tag_id FROM package_tags ORDER BY tag_id ASC`,
      })
      const repositoryTags = await database.client.execute({
        sql: `SELECT tag_id FROM repository_tags ORDER BY tag_id ASC`,
      })

      expect(result).toEqual({ syncedCount: 1 })
      expect(packageRows.rows[0]).toMatchObject({
        package_name: "react",
        repository_url: "https://github.com/facebook/react",
        package_url: "https://www.npmjs.com/package/react",
        package_description: "UI library",
        homepage_url: "https://react.dev",
        repository_stars: 200_000,
        package_downloads: 1000,
        package_downloads_period: "last-month",
        package_last_published_at: "2026-01-01T00:00:00.000Z",
      })
      expect(packageTags.rows.map((row) => row.tag_id)).toEqual([
        "component-library",
        "react",
      ])
      expect(repositoryTags.rows.map((row) => row.tag_id)).toEqual([
        "front-end",
      ])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("resolves v-prefixed latest dist-tags when extracting published dates", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/cson-safe") {
        return createJsonResponse({
          "dist-tags": { latest: "v1.0.5" },
          time: {
            "1.0.5": "2015-01-29T18:28:45.762Z",
          },
          versions: {
            "1.0.5": {
              description: "Safe parsing of CSON files",
              homepage: "https://github.com/groupon/cson-safe",
              repository: {
                url: "https://github.com/groupon/cson-safe.git",
              },
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        return createJsonResponse({
          data: {
            repo_0: {
              stargazerCount: 1234,
              repositoryTopics: {
                nodes: [],
              },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "cson-safe", packageDownloads: 1000 },
        ],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT repository_url, package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["cson-safe"],
      })

      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://github.com/groupon/cson-safe",
        package_last_published_at: "2015-01-29T18:28:45.762Z",
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("keeps existing packages when later sync snapshots do not include them", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        return createJsonResponse({
          "dist-tags": { latest: "19.0.0" },
          time: {
            "19.0.0": "2026-01-01T00:00:00.000Z",
          },
          versions: {
            "19.0.0": {
              description: "React",
              repository: {
                url: "https://github.com/facebook/react",
              },
              keywords: ["react"],
            },
          },
        })
      }

      if (url === "https://registry.npmjs.org/vue") {
        return createJsonResponse({
          "dist-tags": { latest: "3.0.0" },
          time: {
            "3.0.0": "2026-02-01T00:00:00.000Z",
          },
          versions: {
            "3.0.0": {
              description: "Vue",
              repository: {
                url: "https://github.com/vuejs/core",
              },
              keywords: ["vue"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        return createJsonResponse({
          data: {
            repo_0: {
              stargazerCount: 200_000,
              repositoryTopics: {
                nodes: [{ topic: { name: "frontend" } }],
              },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
          { packageName: "vue", packageDownloads: 800 },
        ],
      })

      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1200 },
        ],
      })

      const rows = await database.client.execute({
        sql: `
          SELECT package_name, package_downloads
          FROM packages
          ORDER BY package_name ASC
        `,
      })

      expect(rows.rows).toEqual([
        { package_name: "react", package_downloads: 1200 },
        { package_name: "vue", package_downloads: 800 },
      ])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("stores non-GitHub repositories without GitHub enrichment", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/svelte") {
        return createJsonResponse({
          "dist-tags": { latest: "5.0.0" },
          time: {
            "5.0.0": "2026-03-01T00:00:00.000Z",
          },
          versions: {
            "5.0.0": {
              description: "Svelte",
              repository: {
                url: "https://gitlab.com/example/svelte-like",
              },
              keywords: ["compiler"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        throw new Error("GitHub should not be queried for non-GitHub repos.")
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "svelte", packageDownloads: 700 },
        ],
      })

      const rows = await database.client.execute({
        sql: `
          SELECT repository_url, repository_stars
          FROM packages
          WHERE package_name = ?
        `,
        args: ["svelte"],
      })

      expect(rows.rows[0]).toMatchObject({
        repository_url: "https://gitlab.com/example/svelte-like",
        repository_stars: null,
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("preserves last known optional metadata and repository tags on partial misses", async () => {
    const database = await createTestCatalogDatabase()
    let syncRound = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        syncRound += 1

        if (syncRound === 1) {
          return createJsonResponse({
            "dist-tags": { latest: "19.0.0" },
            time: {
              "19.0.0": "2026-01-01T00:00:00.000Z",
            },
            versions: {
              "19.0.0": {
                description: "UI library",
                homepage: "https://react.dev",
                repository: {
                  url: "git+https://github.com/facebook/react.git",
                },
                keywords: ["react", "ui"],
              },
            },
          })
        }

        return createJsonResponse({
          "dist-tags": { latest: "19.0.1" },
          time: {
            "19.0.1": "2026-01-02T00:00:00.000Z",
          },
          versions: {
            "19.0.1": {
              keywords: ["react"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        if (syncRound === 1) {
          return createJsonResponse({
            data: {
              repo_0: {
                stargazerCount: 200_000,
                repositoryTopics: {
                  nodes: [{ topic: { name: "frontend" } }],
                },
              },
            },
          })
        }

        throw new Error(
          "GitHub should not be queried after repository metadata disappears."
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
        ],
      })

      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1100 },
        ],
        npmViewRunner() {
          return Promise.resolve(true)
        },
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            homepage_url,
            repository_stars,
            package_downloads,
            package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["react"],
      })
      const repositoryTags = await database.client.execute({
        sql: `
          SELECT tag_id
          FROM repository_tags
          WHERE package_name = ?
          ORDER BY tag_id ASC
        `,
        args: ["react"],
      })

      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://github.com/facebook/react",
        package_description: "UI library",
        homepage_url: "https://react.dev",
        repository_stars: 200_000,
        package_downloads: 1100,
        package_last_published_at: "2026-01-02T00:00:00.000Z",
      })
      expect(repositoryTags.rows.map((row) => row.tag_id)).toEqual([
        "front-end",
      ])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("marks previously healthy packages as unresolvable when later npm view validation fails", async () => {
    const database = await createTestCatalogDatabase()
    let syncRound = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        syncRound += 1

        if (syncRound === 1) {
          return createJsonResponse({
            "dist-tags": { latest: "19.0.0" },
            time: {
              "19.0.0": "2026-01-01T00:00:00.000Z",
            },
            versions: {
              "19.0.0": {
                description: "UI library",
                homepage: "https://react.dev",
                repository: {
                  url: "git+https://github.com/facebook/react.git",
                },
                keywords: ["react", "ui"],
              },
            },
          })
        }

        return createJsonResponse({
          "dist-tags": { latest: "19.0.1" },
          time: {
            "19.0.1": "2026-01-02T00:00:00.000Z",
          },
          versions: {
            "19.0.1": {
              keywords: ["react"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        return createJsonResponse({
          data: {
            repo_0: {
              stargazerCount: 200_000,
              repositoryTopics: {
                nodes: [{ topic: { name: "frontend" } }],
              },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
        ],
      })

      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1100 },
        ],
        npmViewRunner() {
          return Promise.resolve(false)
        },
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT repository_url, package_description, package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["react"],
      })

      expect(packageRows.rows[0]).toMatchObject({
        repository_url:
          "https://registry.npmjs.org/-/unresolvable-via-npm-view",
        package_description: "Unresolvable package",
        package_last_published_at: null,
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("preserves previously healthy packages when npm view validation is inconclusive", async () => {
    const database = await createTestCatalogDatabase()
    let syncRound = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        syncRound += 1

        if (syncRound === 1) {
          return createJsonResponse({
            "dist-tags": { latest: "19.0.0" },
            time: {
              "19.0.0": "2026-01-01T00:00:00.000Z",
            },
            versions: {
              "19.0.0": {
                description: "UI library",
                homepage: "https://react.dev",
                repository: {
                  url: "git+https://github.com/facebook/react.git",
                },
                keywords: ["react", "ui"],
              },
            },
          })
        }

        return createJsonResponse({
          "dist-tags": { latest: "19.0.1" },
          time: {
            "19.0.1": "2026-01-02T00:00:00.000Z",
          },
          versions: {
            "19.0.1": {
              keywords: ["react"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        return createJsonResponse({
          data: {
            repo_0: {
              stargazerCount: 200_000,
              repositoryTopics: {
                nodes: [{ topic: { name: "frontend" } }],
              },
            },
          },
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
        ],
      })

      const secondResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1100 },
        ],
        npmViewRunner() {
          return Promise.resolve(null)
        },
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            homepage_url,
            repository_stars,
            package_downloads,
            package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["react"],
      })

      expect(secondResult).toEqual({ syncedCount: 0 })
      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://github.com/facebook/react",
        package_description: "UI library",
        homepage_url: "https://react.dev",
        repository_stars: 200_000,
        package_downloads: 1000,
        package_last_published_at: "2026-01-01T00:00:00.000Z",
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("continues syncing when GitHub returns partial data with per-repository errors", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        return createJsonResponse({
          "dist-tags": { latest: "19.0.0" },
          time: {
            "19.0.0": "2026-01-01T00:00:00.000Z",
          },
          versions: {
            "19.0.0": {
              description: "React",
              repository: {
                url: "https://github.com/facebook/react",
              },
              keywords: ["react"],
            },
          },
        })
      }

      if (url === "https://registry.npmjs.org/bad-repo") {
        return createJsonResponse({
          "dist-tags": { latest: "1.0.0" },
          time: {
            "1.0.0": "2026-01-01T00:00:00.000Z",
          },
          versions: {
            "1.0.0": {
              description: "Broken repo ref",
              repository: {
                url: "https://github.com/example/deleted-repo",
              },
              keywords: ["broken"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        return createJsonResponse({
          data: {
            repo_0: {
              stargazerCount: 200_000,
              repositoryTopics: {
                nodes: [{ topic: { name: "frontend" } }],
              },
            },
            repo_1: null,
          },
          errors: [{ message: "Could not resolve to a Repository" }],
        })
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const result = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
          { packageName: "bad-repo", packageDownloads: 900 },
        ],
      })

      const rows = await database.client.execute({
        sql: `
          SELECT package_name, repository_url, repository_stars
          FROM packages
          ORDER BY package_name ASC
        `,
      })

      expect(result).toEqual({ syncedCount: 2 })
      expect(rows.rows).toEqual([
        {
          package_name: "bad-repo",
          repository_url: "https://github.com/example/deleted-repo",
          repository_stars: null,
        },
        {
          package_name: "react",
          repository_url: "https://github.com/facebook/react",
          repository_stars: 200_000,
        },
      ])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("continues syncing when GitHub repository enrichment is forbidden", async () => {
    const database = await createTestCatalogDatabase()
    let syncRound = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/react") {
        syncRound += 1

        if (syncRound === 1) {
          return createJsonResponse({
            "dist-tags": { latest: "19.0.0" },
            time: {
              "19.0.0": "2026-01-01T00:00:00.000Z",
            },
            versions: {
              "19.0.0": {
                description: "UI library",
                homepage: "https://react.dev",
                repository: {
                  url: "git+https://github.com/facebook/react.git",
                },
                keywords: ["react", "ui"],
              },
            },
          })
        }

        return createJsonResponse({
          "dist-tags": { latest: "19.0.1" },
          time: {
            "19.0.1": "2026-01-02T00:00:00.000Z",
          },
          versions: {
            "19.0.1": {
              description: "UI library updated",
              homepage: "https://react.dev/reference/react",
              repository: {
                url: "https://github.com/facebook/react",
              },
              keywords: ["react", "compiler"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        if (syncRound === 1) {
          return createJsonResponse({
            data: {
              repo_0: {
                stargazerCount: 200_000,
                repositoryTopics: {
                  nodes: [{ topic: { name: "frontend" } }],
                },
              },
            },
          })
        }

        return new Response(
          JSON.stringify({
            message: "You have exceeded a secondary rate limit.",
          }),
          {
            status: 403,
            statusText: "Forbidden",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
            },
          }
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const firstResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1000 },
        ],
      })
      const secondResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          { packageName: "react", packageDownloads: 1100 },
        ],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            homepage_url,
            repository_stars,
            package_downloads,
            package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["react"],
      })
      const packageTags = await database.client.execute({
        sql: `
          SELECT tag_id
          FROM package_tags
          WHERE package_name = ?
          ORDER BY tag_id ASC
        `,
        args: ["react"],
      })
      const repositoryTags = await database.client.execute({
        sql: `
          SELECT tag_id
          FROM repository_tags
          WHERE package_name = ?
          ORDER BY tag_id ASC
        `,
        args: ["react"],
      })

      expect(firstResult).toEqual({ syncedCount: 1 })
      expect(secondResult).toEqual({ syncedCount: 1 })
      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://github.com/facebook/react",
        package_description: "UI library updated",
        homepage_url: "https://react.dev/reference/react",
        repository_stars: 200_000,
        package_downloads: 1100,
        package_last_published_at: "2026-01-02T00:00:00.000Z",
      })
      expect(packageTags.rows.map((row) => row.tag_id)).toEqual([
        "compiler",
        "react",
      ])
      expect(repositoryTags.rows.map((row) => row.tag_id)).toEqual([
        "front-end",
      ])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("clears stale GitHub metadata when repository enrichment is forbidden after a repo change", async () => {
    const database = await createTestCatalogDatabase()
    let syncRound = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/pkg") {
        syncRound += 1

        if (syncRound === 1) {
          return createJsonResponse({
            "dist-tags": { latest: "1.0.0" },
            time: {
              "1.0.0": "2026-01-01T00:00:00.000Z",
            },
            versions: {
              "1.0.0": {
                description: "Original package",
                repository: {
                  url: "https://github.com/example/old-repo",
                },
                keywords: ["one"],
              },
            },
          })
        }

        return createJsonResponse({
          "dist-tags": { latest: "1.0.1" },
          time: {
            "1.0.1": "2026-01-02T00:00:00.000Z",
          },
          versions: {
            "1.0.1": {
              description: "Moved package",
              repository: {
                url: "https://github.com/example/new-repo",
              },
              keywords: ["two"],
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        if (syncRound === 1) {
          return createJsonResponse({
            data: {
              repo_0: {
                stargazerCount: 111,
                repositoryTopics: {
                  nodes: [{ topic: { name: "alpha" } }],
                },
              },
            },
          })
        }

        return new Response(
          JSON.stringify({
            message: "You have exceeded a secondary rate limit.",
          }),
          {
            status: 403,
            statusText: "Forbidden",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
            },
          }
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [{ packageName: "pkg", packageDownloads: 1000 }],
      })
      await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [{ packageName: "pkg", packageDownloads: 1100 }],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            repository_stars,
            package_downloads
          FROM packages
          WHERE package_name = ?
        `,
        args: ["pkg"],
      })
      const repositoryTags = await database.client.execute({
        sql: `
          SELECT tag_id
          FROM repository_tags
          WHERE package_name = ?
          ORDER BY tag_id ASC
        `,
        args: ["pkg"],
      })

      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://github.com/example/new-repo",
        package_description: "Moved package",
        repository_stars: null,
        package_downloads: 1100,
      })
      expect(repositoryTags.rows).toEqual([])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("resets a legacy catalog schema to the new package layout", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await database.client.execute("DROP TABLE IF EXISTS package_tags")
      await database.client.execute("DROP TABLE IF EXISTS repository_tags")
      await database.client.execute("DROP TABLE IF EXISTS tag_aliases")
      await database.client.execute("DROP TABLE IF EXISTS tags")
      await database.client.execute("DROP TABLE IF EXISTS packages")
      await database.client.execute(`
        CREATE TABLE packages (
          package_key TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          source_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          search_name TEXT NOT NULL,
          description TEXT,
          homepage_url TEXT,
          primary_url TEXT NOT NULL,
          repository_name TEXT,
          npm_package_name TEXT,
          last_published_at TEXT,
          stars INTEGER,
          downloads INTEGER NOT NULL,
          downloads_period TEXT,
          dependent_packages_count INTEGER NOT NULL,
          raw_ecosystems_fetched_at TEXT NOT NULL,
          npm_synced_at TEXT,
          github_synced_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 1
        )
      `)
      await database.client.execute(`
        CREATE TABLE package_tags (
          package_key TEXT NOT NULL,
          tag_id TEXT NOT NULL,
          source TEXT NOT NULL,
          raw_value TEXT NOT NULL,
          PRIMARY KEY (package_key, tag_id, source, raw_value)
        )
      `)

      await ensureCatalogSchema(database.client)

      const packageColumns = await database.client.execute(
        "PRAGMA table_info(packages)"
      )
      const packageTagColumns = await database.client.execute(
        "PRAGMA table_info(package_tags)"
      )

      expect(packageColumns.rows.map((row) => row.name)).toEqual([
        "package_name",
        "repository_url",
        "package_url",
        "package_description",
        "homepage_url",
        "repository_stars",
        "package_downloads",
        "package_downloads_period",
        "package_last_published_at",
        "last_synced_at",
      ])
      expect(packageTagColumns.rows.map((row) => row.name)).toEqual([
        "package_name",
        "tag_id",
        "raw_value",
      ])
    } finally {
      await database.cleanup()
    }
  })

  it("fails fast when the GitHub token is missing", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await expect(
        syncNpmCatalog(database.client, {
          githubToken: "",
          topPackageLimit: 10_000,
          downloadCountsEntries: [
            { packageName: "react", packageDownloads: 1000 },
          ],
        })
      ).rejects.toThrow("GITHUB_TOKEN is required for npm catalog sync.")
    } finally {
      await database.cleanup()
    }
  })

  it("marks npm security holding packages as removed and skips future resyncs", async () => {
    const database = await createTestCatalogDatabase()
    let npmRequestCount = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (
        url ===
        "https://registry.npmjs.org/%40patrtorg%2Fsit-voluptate-quibusdam"
      ) {
        npmRequestCount += 1

        return createJsonResponse({
          "dist-tags": { latest: "0.0.1-security.1" },
          time: {
            "0.0.1-security.1": "2026-04-01T00:00:00.000Z",
          },
          versions: {
            "0.0.1-security.1": {
              description: "Security holding package",
              homepage: "https://github.com/npm/security-holder#readme",
              repository: {
                url: "https://github.com/npm/security-holder",
              },
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        throw new Error(
          "GitHub should not be queried for npm security holding packages."
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const firstResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          {
            packageName: "@patrtorg/sit-voluptate-quibusdam",
            packageDownloads: 1000,
          },
        ],
      })
      const secondResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          {
            packageName: "@patrtorg/sit-voluptate-quibusdam",
            packageDownloads: 1000,
          },
        ],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            package_downloads,
            package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["@patrtorg/sit-voluptate-quibusdam"],
      })
      const packageTags = await database.client.execute({
        sql: `SELECT tag_id FROM package_tags WHERE package_name = ?`,
        args: ["@patrtorg/sit-voluptate-quibusdam"],
      })
      const repositoryTags = await database.client.execute({
        sql: `SELECT tag_id FROM repository_tags WHERE package_name = ?`,
        args: ["@patrtorg/sit-voluptate-quibusdam"],
      })

      expect(firstResult).toEqual({ syncedCount: 1 })
      expect(secondResult).toEqual({ syncedCount: 0 })
      expect(npmRequestCount).toBe(1)
      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://github.com/npm/security-holder",
        package_description: "Security holding package",
        package_downloads: 1000,
        package_last_published_at: "2026-04-01T00:00:00.000Z",
      })
      expect(packageTags.rows).toEqual([])
      expect(repositoryTags.rows).toEqual([])
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("marks npm 404 packages as unpublished and skips future resyncs", async () => {
    const database = await createTestCatalogDatabase()
    let npmRequestCount = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (
        url ===
        "https://registry.npmjs.org/%40patrtorg%2Fsit-voluptate-quibusdam"
      ) {
        npmRequestCount += 1

        return new Response("Unpublished", {
          status: 404,
          statusText: "Not Found",
        })
      }

      if (url === "https://api.github.com/graphql") {
        throw new Error(
          "GitHub should not be queried for unpublished packages."
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const firstResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          {
            packageName: "@patrtorg/sit-voluptate-quibusdam",
            packageDownloads: 1000,
          },
        ],
      })
      const secondResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          {
            packageName: "@patrtorg/sit-voluptate-quibusdam",
            packageDownloads: 1000,
          },
        ],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            package_downloads,
            package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["@patrtorg/sit-voluptate-quibusdam"],
      })

      expect(firstResult).toEqual({ syncedCount: 1 })
      expect(secondResult).toEqual({ syncedCount: 0 })
      expect(npmRequestCount).toBe(1)
      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://registry.npmjs.org/-/unpublished",
        package_description: "Unpublished package",
        package_downloads: 1000,
        package_last_published_at: null,
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("marks npm unpublished registry documents as removed and skips future resyncs", async () => {
    const database = await createTestCatalogDatabase()
    let npmRequestCount = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (
        url === "https://registry.npmjs.org/%40diotoborg%2Fomnis-necessitatibus"
      ) {
        npmRequestCount += 1

        return createJsonResponse({
          name: "@diotoborg/omnis-necessitatibus",
          time: {
            created: "2024-06-08T09:10:14.393Z",
            modified: "2024-09-23T03:36:21.563Z",
            unpublished: {
              time: "2024-09-23T03:36:21.563Z",
              versions: ["1.0.0"],
            },
          },
          versions: {
            "1.0.0": {
              description: "Old package payload",
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        throw new Error(
          "GitHub should not be queried for unpublished packages."
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const firstResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          {
            packageName: "@diotoborg/omnis-necessitatibus",
            packageDownloads: 1000,
          },
        ],
      })
      const secondResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [
          {
            packageName: "@diotoborg/omnis-necessitatibus",
            packageDownloads: 1000,
          },
        ],
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            repository_url,
            package_description,
            package_downloads,
            package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["@diotoborg/omnis-necessitatibus"],
      })

      expect(firstResult).toEqual({ syncedCount: 1 })
      expect(secondResult).toEqual({ syncedCount: 0 })
      expect(npmRequestCount).toBe(1)
      expect(packageRows.rows[0]).toMatchObject({
        repository_url: "https://registry.npmjs.org/-/unpublished",
        package_description: "Unpublished package",
        package_downloads: 1000,
        package_last_published_at: null,
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("marks npm-view-unresolvable packages as removed when the registry payload is incomplete", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/-") {
        return createJsonResponse({
          name: "-",
          "dist-tags": { latest: "0.0.1" },
          time: {
            "0.0.1": "2020-04-02T11:48:52.339Z",
          },
          versions: {
            "0.0.1": {
              description:
                "> Created using https://github.com/parzh/create-package-typescript",
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        throw new Error(
          "GitHub should not be queried for npm-view-unresolvable packages."
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const result = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [{ packageName: "-", packageDownloads: 1000 }],
        npmViewRunner() {
          return Promise.resolve(false)
        },
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT repository_url, package_description, package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["-"],
      })

      expect(result).toEqual({ syncedCount: 1 })
      expect(packageRows.rows[0]).toMatchObject({
        repository_url:
          "https://registry.npmjs.org/-/unresolvable-via-npm-view",
        package_description: "Unresolvable package",
        package_last_published_at: null,
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })

  it("keeps npm-view-unresolvable packages hidden on later syncs with the same incomplete payload", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url === "https://registry.npmjs.org/-") {
        return createJsonResponse({
          name: "-",
          description: "Package named dash",
          "dist-tags": { latest: "0.0.1" },
          time: {
            "0.0.1": "2020-04-02T11:48:52.339Z",
          },
          versions: {
            "0.0.1": {
              description:
                "> Created using https://github.com/parzh/create-package-typescript",
            },
          },
        })
      }

      if (url === "https://api.github.com/graphql") {
        throw new Error(
          "GitHub should not be queried for npm-view-unresolvable packages."
        )
      }

      throw new Error(`Unexpected request: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const firstResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [{ packageName: "-", packageDownloads: 1000 }],
        npmViewRunner() {
          return Promise.resolve(false)
        },
      })
      const secondResult = await syncNpmCatalog(database.client, {
        githubToken: "test-token",
        topPackageLimit: 10_000,
        downloadCountsEntries: [{ packageName: "-", packageDownloads: 1000 }],
        npmViewRunner() {
          return Promise.resolve(false)
        },
      })

      const packageRows = await database.client.execute({
        sql: `
          SELECT repository_url, package_description, package_last_published_at
          FROM packages
          WHERE package_name = ?
        `,
        args: ["-"],
      })

      expect(firstResult).toEqual({ syncedCount: 1 })
      expect(secondResult).toEqual({ syncedCount: 0 })
      expect(packageRows.rows[0]).toMatchObject({
        repository_url:
          "https://registry.npmjs.org/-/unresolvable-via-npm-view",
        package_description: "Unresolvable package",
        package_last_published_at: null,
      })
    } finally {
      vi.unstubAllGlobals()
      await database.cleanup()
    }
  })
})

function createJsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}
