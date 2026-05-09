import {
  backfillLastPublishedAtFromRawEcosystems,
  pruneEcosystemsPackages,
  syncEcosystemsPopular,
} from "../../server/catalog/admin-service"
import { resetCatalogSchema } from "../../server/catalog/schema"
import {
  createTestCatalogDatabase,
  seedCatalogPackage,
} from "../helpers/catalog-test-db"

describe("ecosyste.ms popular sync", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("paginates downloads-ranked packages and sends the required headers", async () => {
    const database = await createTestCatalogDatabase()
    const pageOnePackages = Array.from({ length: 400 }, (_, index) =>
      createEcosystemsFixture({
        name: `pkg-${index + 1}`,
        downloads: 100_000 - index,
        dependentPackagesCount: 1_000 - index,
      })
    )
    const pageTwoPackage = createEcosystemsFixture({
      name: "semver",
      description: "The semantic version parser used by npm.",
      homepage: "https://github.com/npm/node-semver#readme",
      registryUrl: "https://www.npmjs.com/package/semver",
      repositoryUrl: "https://github.com/npm/node-semver",
      keywords: ["semver"],
      downloads: 99_000,
      dependentPackagesCount: 4_321,
      repoMetadata: {
        full_name: "npm/node-semver",
        stargazers_count: 5_410,
        topics: ["npm-cli"],
      },
    })
    const requestCalls: Array<{ url: URL; headers: Headers }> = []
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)

        if (url.includes("/registries/npmjs.org/packages")) {
          const requestUrl = new URL(url)
          requestCalls.push({
            url: requestUrl,
            headers: new Headers(init?.headers),
          })

          if (requestUrl.searchParams.get("page") === "1") {
            return jsonResponse(pageOnePackages)
          }

          if (requestUrl.searchParams.get("page") === "2") {
            return jsonResponse([pageTwoPackage])
          }
        }

        throw new Error(`Unexpected fetch URL: ${url}`)
      }
    )

    vi.stubGlobal("fetch", fetchMock)

    try {
      const result = await syncEcosystemsPopular(database.client, {
        ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
        fromAddress: "info@scriptorium.dev",
        syncLimit: 401,
        updatedAfter: "2025-01-01T00:00:00.000Z",
        userAgent: "scriptorium-test/0.1.1",
      })

      expect(result).toEqual({ syncedCount: 401 })

      expect(
        requestCalls.map(({ url }) => ({
          page: url.searchParams.get("page"),
          perPage: url.searchParams.get("per_page"),
          sort: url.searchParams.get("sort"),
          order: url.searchParams.get("order"),
          updatedAfter: url.searchParams.get("updated_after"),
        }))
      ).toEqual([
        {
          page: "1",
          perPage: "50",
          sort: "downloads",
          order: "desc",
          updatedAfter: "2025-01-01T00:00:00.000Z",
        },
        {
          page: "2",
          perPage: "50",
          sort: "downloads",
          order: "desc",
          updatedAfter: "2025-01-01T00:00:00.000Z",
        },
      ])
      expect(requestCalls[0]?.headers.get("Accept")).toBe("application/json")
      expect(requestCalls[0]?.headers.get("User-Agent")).toBe(
        "scriptorium-test/0.1.1"
      )
      expect(requestCalls[0]?.headers.get("From")).toBe("info@scriptorium.dev")

      const packageRows = await database.client.execute({
        sql: `
          SELECT
            package_key,
            repository_name,
            description,
            homepage_url,
            primary_url,
            last_published_at,
            stars,
            downloads,
            downloads_period,
            dependent_packages_count
          FROM packages
          WHERE package_key = ?
        `,
        args: ["npm:semver"],
      })
      const tagRows = await database.client.execute({
        sql: `
          SELECT source, raw_value
          FROM package_tags
          WHERE package_key = ?
          ORDER BY source ASC, raw_value ASC
        `,
        args: ["npm:semver"],
      })

      expect(packageRows.rows).toHaveLength(1)
      expect(packageRows.rows[0]).toMatchObject({
        package_key: "npm:semver",
        repository_name: "npm/node-semver",
        description: "The semantic version parser used by npm.",
        homepage_url: "https://github.com/npm/node-semver#readme",
        primary_url: "https://github.com/npm/node-semver#readme",
        last_published_at: "2026-01-01T00:00:00.000Z",
        stars: 5410,
        downloads: 99000,
        downloads_period: "last-month",
        dependent_packages_count: 4321,
      })
      expect(tagRows.rows).toEqual([
        expect.objectContaining({ source: "github", raw_value: "npm-cli" }),
        expect.objectContaining({ source: "npm", raw_value: "semver" }),
      ])
    } finally {
      await database.cleanup()
    }
  })

  it("falls back to repository_url and registry_url when repo metadata is missing", async () => {
    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url.includes("/registries/npmjs.org/packages")) {
        return jsonResponse([
          createEcosystemsFixture({
            name: "debug",
            description: "small debugging utility",
            homepage: null,
            registryUrl: "https://www.npmjs.com/package/debug",
            repositoryUrl: "https://github.com/debug-js/debug",
            keywords: ["debug", "logger"],
            downloads: 123456,
            dependentPackagesCount: 789,
            repoMetadata: null,
          }),
        ])
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const result = await syncEcosystemsPopular(database.client, {
        ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
        fromAddress: "info@scriptorium.dev",
        syncLimit: 1,
        updatedAfter: "2025-01-01T00:00:00.000Z",
        userAgent: "scriptorium-test/0.1.1",
      })

      expect(result).toEqual({ syncedCount: 1 })

      const packageRows = await database.client.execute({
        sql: `
          SELECT repository_name, homepage_url, primary_url, last_published_at, stars, downloads, dependent_packages_count
          FROM packages
          WHERE package_key = ?
        `,
        args: ["npm:debug"],
      })
      const githubTags = await database.client.execute({
        sql: `
          SELECT COUNT(*) AS total
          FROM package_tags
          WHERE package_key = ? AND source = 'github'
        `,
        args: ["npm:debug"],
      })

      expect(packageRows.rows).toHaveLength(1)
      expect(packageRows.rows[0]).toMatchObject({
        repository_name: "debug-js/debug",
        homepage_url: null,
        primary_url: "https://www.npmjs.com/package/debug",
        last_published_at: "2026-01-01T00:00:00.000Z",
        stars: null,
        downloads: 123456,
        dependent_packages_count: 789,
      })
      expect(Number(githubTags.rows[0]?.total ?? 0)).toBe(0)
    } finally {
      await database.cleanup()
    }
  })

  it("skips packages whose latest release is older than one year", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-03T00:00:00.000Z"))

    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url.includes("/registries/npmjs.org/packages")) {
        return jsonResponse([
          createEcosystemsFixture({
            name: "fresh-package",
            downloads: 1000,
            dependentPackagesCount: 501,
            latestReleasePublishedAt: "2025-09-01T00:00:00.000Z",
          }),
          createEcosystemsFixture({
            name: "stale-package",
            downloads: 2000,
            dependentPackagesCount: 700,
            latestReleasePublishedAt: "2024-03-31T00:00:00.000Z",
          }),
          createEcosystemsFixture({
            name: "low-impact-package",
            downloads: 3000,
            dependentPackagesCount: 500,
            latestReleasePublishedAt: "2026-02-01T00:00:00.000Z",
          }),
        ])
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const result = await syncEcosystemsPopular(database.client, {
        ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
        fromAddress: "info@scriptorium.dev",
        syncLimit: 10,
        updatedAfter: "2025-01-01T00:00:00.000Z",
        userAgent: "scriptorium-test/0.1.1",
      })

      expect(result).toEqual({ syncedCount: 1 })

      const packageRows = await database.client.execute({
        sql: `
          SELECT package_key
          FROM packages
          ORDER BY package_key ASC
        `,
      })

      expect(packageRows.rows.map((row) => String(row.package_key))).toEqual([
        "npm:fresh-package",
      ])
    } finally {
      await database.cleanup()
    }
  })

  it("backfills last_published_at from raw ecosyste.ms blobs", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "react",
        displayName: "React",
        publishedAt: null,
      })
      await database.client.execute({
        sql: `
          INSERT INTO raw_ecosystems_packages (
            package_key,
            source_type,
            source_name,
            downloads,
            downloads_period,
            dependent_packages_count,
            raw_json,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "npm:react",
          "npm",
          "react",
          1000,
          "last-month",
          500,
          JSON.stringify({
            name: "react",
            latest_release_published_at: "2026-02-14T12:00:00.000Z",
          }),
          "2026-04-03T00:00:00.000Z",
        ],
      })

      const result = await backfillLastPublishedAtFromRawEcosystems(
        database.client
      )
      const packageRow = await database.client.execute({
        sql: `
          SELECT last_published_at
          FROM packages
          WHERE package_key = ?
        `,
        args: ["npm:react"],
      })

      expect(result).toEqual({ packageCount: 1, updatedCount: 1 })
      expect(packageRow.rows[0]?.last_published_at).toBe(
        "2026-02-14T12:00:00.000Z"
      )
    } finally {
      await database.cleanup()
    }
  })

  it("includes the failing ecosyste.ms request URL in fetch errors", async () => {
    vi.useFakeTimers()

    const database = await createTestCatalogDatabase()
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":"internal server error"}', {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        })
    )

    vi.stubGlobal("fetch", fetchMock)

    try {
      const resultExpectation = expect(
        syncEcosystemsPopular(database.client, {
          ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
          fromAddress: "info@scriptorium.dev",
          syncLimit: 1,
          updatedAfter: "2025-01-01T00:00:00.000Z",
          userAgent: "scriptorium-test/0.1.1",
        })
      ).rejects.toThrow(
        "Failed to fetch ecosyste.ms packages from https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages?page=1&per_page=50&updated_after=2025-01-01T00%3A00%3A00.000Z&mailto=info%40scriptorium.dev&sort=downloads&order=desc: 500 Internal Server Error"
      )

      await vi.advanceTimersByTimeAsync(30_000)

      await resultExpectation
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      await database.cleanup()
    }
  })

  it("stores successful pages before a later deferred page fails", async () => {
    vi.useFakeTimers()

    const database = await createTestCatalogDatabase()
    const pageOnePackages = Array.from({ length: 50 }, (_, index) =>
      createEcosystemsFixture({
        name: `pkg-${index + 1}`,
        downloads: 100_000 - index,
        dependentPackagesCount: 1_000 - index,
      })
    )
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)

      if (url.includes("page=1")) {
        return jsonResponse(pageOnePackages)
      }

      if (url.includes("page=2")) {
        return new Response('{"error":"internal server error"}', {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        })
      }

      if (url.includes("page=3")) {
        return jsonResponse([])
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    vi.stubGlobal("fetch", fetchMock)

    try {
      const resultExpectation = expect(
        syncEcosystemsPopular(database.client, {
          ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
          fromAddress: "info@scriptorium.dev",
          syncLimit: 60,
          updatedAfter: "2025-01-01T00:00:00.000Z",
          userAgent: "scriptorium-test/0.1.1",
        })
      ).rejects.toThrow(
        "Failed to fetch ecosyste.ms packages from https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages?page=2&per_page=50&updated_after=2025-01-01T00%3A00%3A00.000Z&mailto=info%40scriptorium.dev&sort=downloads&order=desc: 500 Internal Server Error"
      )

      await vi.advanceTimersByTimeAsync(30_000)

      await resultExpectation

      const packageRows = await database.client.execute({
        sql: `
          SELECT COUNT(*) AS total
          FROM packages
          WHERE source_type = 'npm'
        `,
      })

      expect(Number(packageRows.rows[0]?.total ?? 0)).toBe(50)
      expect(fetchMock).toHaveBeenCalledTimes(6)
    } finally {
      await database.cleanup()
    }
  })

  it("retries transient ecosyste.ms failures before succeeding", async () => {
    vi.useFakeTimers()

    const database = await createTestCatalogDatabase()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"internal server error"}', {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              name: "react",
              description: "UI library",
              homepage: "https://react.dev",
              registry_url: "https://www.npmjs.com/package/react",
              repository_url: "https://github.com/facebook/react",
              latest_release_published_at: "2026-02-14T12:00:00.000Z",
              downloads: 1000,
              downloads_period: "last-month",
              dependent_packages_count: 501,
              keywords_array: ["react", "ui"],
              repo_metadata: {
                full_name: "facebook/react",
                stargazers_count: 200000,
                topics: ["react", "ui"],
              },
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )

    vi.stubGlobal("fetch", fetchMock)

    try {
      const resultPromise = syncEcosystemsPopular(database.client, {
        ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
        fromAddress: "info@scriptorium.dev",
        syncLimit: 1,
        updatedAfter: "2025-01-01T00:00:00.000Z",
        userAgent: "scriptorium-test/0.1.1",
      })

      await vi.advanceTimersByTimeAsync(10_000)
      const result = await resultPromise

      expect(result).toEqual({ syncedCount: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await database.cleanup()
    }
  })

  it("honors Retry-After when retrying rate-limited ecosyste.ms pages", async () => {
    vi.useFakeTimers()

    const database = await createTestCatalogDatabase()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"too many requests"}', {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "3",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createEcosystemsFixture({
              name: "react",
              downloads: 1000,
              dependentPackagesCount: 501,
            }),
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )

    vi.stubGlobal("fetch", fetchMock)

    try {
      const resultPromise = syncEcosystemsPopular(database.client, {
        ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
        fromAddress: "info@scriptorium.dev",
        syncLimit: 1,
        updatedAfter: "2025-01-01T00:00:00.000Z",
        userAgent: "scriptorium-test/0.1.1",
      })

      await vi.advanceTimersByTimeAsync(2_999)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise

      expect(result).toEqual({ syncedCount: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await database.cleanup()
    }
  })

  it("retries transient network failures before succeeding", async () => {
    vi.useFakeTimers()

    const database = await createTestCatalogDatabase()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createEcosystemsFixture({
              name: "react",
              downloads: 1000,
              dependentPackagesCount: 501,
            }),
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )

    vi.stubGlobal("fetch", fetchMock)

    try {
      const resultPromise = syncEcosystemsPopular(database.client, {
        ecosystemsBaseUrl: "https://packages.ecosyste.ms/api/v1",
        fromAddress: "info@scriptorium.dev",
        syncLimit: 1,
        updatedAfter: "2025-01-01T00:00:00.000Z",
        userAgent: "scriptorium-test/0.1.1",
      })

      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise

      expect(result).toEqual({ syncedCount: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await database.cleanup()
    }
  })

  it("destructively resets the catalog schema", async () => {
    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        sourceType: "npm",
        sourceName: "react",
        downloads: 1000,
        dependentPackagesCount: 500,
      })
      await database.client.execute(`
        CREATE TABLE raw_jsdelivr_packages (
          package_key TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          source_name TEXT NOT NULL,
          hits INTEGER NOT NULL,
          bandwidth INTEGER NOT NULL,
          prev_hits INTEGER,
          prev_bandwidth INTEGER,
          raw_json TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        )
      `)
      await database.client.execute({
        sql: `
          INSERT INTO raw_jsdelivr_packages (
            package_key,
            source_type,
            source_name,
            hits,
            bandwidth,
            prev_hits,
            prev_bandwidth,
            raw_json,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "npm:react",
          "npm",
          "react",
          1000,
          500,
          null,
          null,
          "{}",
          "2026-01-01T00:00:00.000Z",
        ],
      })

      await resetCatalogSchema(database.client)

      const tables = await database.client.execute(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name ASC
      `)
      const packageCount = await database.client.execute(
        "SELECT COUNT(*) AS total FROM packages"
      )

      expect(tables.rows.map((row) => String(row.name))).toEqual(
        expect.arrayContaining([
          "package_tags",
          "packages",
          "raw_ecosystems_packages",
          "tag_aliases",
          "tags",
        ])
      )
      expect(tables.rows.map((row) => String(row.name))).not.toContain(
        "raw_jsdelivr_packages"
      )
      expect(Number(packageCount.rows[0]?.total ?? 0)).toBe(0)
    } finally {
      await database.cleanup()
    }
  })

  it("deletes npm packages that fail the ecosyste.ms retention criteria", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-03T00:00:00.000Z"))

    const database = await createTestCatalogDatabase()

    try {
      await seedCatalogPackage(database.client, {
        packageKey: "npm:keep-me",
        sourceType: "npm",
        sourceName: "keep-me",
        tags: ["keep-tag"],
      })
      await seedCatalogPackage(database.client, {
        packageKey: "npm:stale-package",
        sourceType: "npm",
        sourceName: "stale-package",
        tags: ["stale-tag"],
      })
      await seedCatalogPackage(database.client, {
        packageKey: "npm:low-impact-package",
        sourceType: "npm",
        sourceName: "low-impact-package",
        tags: ["low-tag"],
      })
      await seedCatalogPackage(database.client, {
        packageKey: "npm:no-raw-package",
        sourceType: "npm",
        sourceName: "no-raw-package",
        tags: ["missing-raw-tag"],
      })
      await seedCatalogPackage(database.client, {
        packageKey: "github:keep-repo",
        sourceType: "github",
        sourceName: "keep-repo",
        tags: ["github-tag"],
      })

      await database.client.execute({
        sql: `
          INSERT INTO raw_ecosystems_packages (
            package_key,
            source_type,
            source_name,
            downloads,
            downloads_period,
            dependent_packages_count,
            raw_json,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "npm:keep-me",
          "npm",
          "keep-me",
          1000,
          "last-month",
          501,
          JSON.stringify(
            createEcosystemsFixture({
              name: "keep-me",
              downloads: 1000,
              dependentPackagesCount: 501,
              latestReleasePublishedAt: "2025-12-01T00:00:00.000Z",
            })
          ),
          "2026-04-03T00:00:00.000Z",
        ],
      })
      await database.client.execute({
        sql: `
          INSERT INTO raw_ecosystems_packages (
            package_key,
            source_type,
            source_name,
            downloads,
            downloads_period,
            dependent_packages_count,
            raw_json,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "npm:stale-package",
          "npm",
          "stale-package",
          1000,
          "last-month",
          900,
          JSON.stringify(
            createEcosystemsFixture({
              name: "stale-package",
              downloads: 1000,
              dependentPackagesCount: 900,
              latestReleasePublishedAt: "2024-04-01T00:00:00.000Z",
            })
          ),
          "2026-04-03T00:00:00.000Z",
        ],
      })
      await database.client.execute({
        sql: `
          INSERT INTO raw_ecosystems_packages (
            package_key,
            source_type,
            source_name,
            downloads,
            downloads_period,
            dependent_packages_count,
            raw_json,
            fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "npm:low-impact-package",
          "npm",
          "low-impact-package",
          1000,
          "last-month",
          500,
          JSON.stringify(
            createEcosystemsFixture({
              name: "low-impact-package",
              downloads: 1000,
              dependentPackagesCount: 500,
              latestReleasePublishedAt: "2026-02-01T00:00:00.000Z",
            })
          ),
          "2026-04-03T00:00:00.000Z",
        ],
      })

      const result = await pruneEcosystemsPackages(database.client, {
        now: new Date("2026-04-03T00:00:00.000Z"),
      })

      expect(result).toEqual({ deletedCount: 2 })

      const packageRows = await database.client.execute({
        sql: `SELECT package_key FROM packages ORDER BY package_key ASC`,
      })
      const tagRows = await database.client.execute({
        sql: `SELECT tag_id FROM tags ORDER BY tag_id ASC`,
      })

      expect(packageRows.rows.map((row) => String(row.package_key))).toEqual([
        "github:keep-repo",
        "npm:keep-me",
        "npm:no-raw-package",
      ])
      expect(tagRows.rows.map((row) => String(row.tag_id))).toEqual([
        "github-tag",
        "keep-tag",
        "missing-raw-tag",
      ])
    } finally {
      await database.cleanup()
    }
  })
})

function createEcosystemsFixture(input: {
  name: string
  description?: string | null
  homepage?: string | null
  registryUrl?: string | null
  repositoryUrl?: string | null
  keywords?: string[]
  downloads: number
  dependentPackagesCount: number
  latestReleasePublishedAt?: string
  repoMetadata?: Record<string, unknown> | null
}) {
  return {
    id: Math.floor(Math.random() * 100000),
    name: input.name,
    ecosystem: "npm",
    description: input.description ?? `${input.name} description`,
    homepage:
      input.homepage === undefined
        ? `https://example.com/${input.name}`
        : input.homepage,
    licenses: "MIT",
    normalized_licenses: ["MIT"],
    repository_url:
      input.repositoryUrl ?? `https://github.com/example/${input.name}`,
    keywords_array: input.keywords ?? [input.name],
    namespace: null,
    versions_count: 10,
    first_release_published_at: "2020-01-01T00:00:00.000Z",
    latest_release_published_at:
      input.latestReleasePublishedAt ?? "2026-01-01T00:00:00.000Z",
    latest_release_number: "1.0.0",
    last_synced_at: "2026-04-02T00:00:00.000Z",
    created_at: "2022-01-01T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    registry_url:
      input.registryUrl ??
      `https://www.npmjs.com/package/${encodeURIComponent(input.name)}`,
    install_command: `npm install ${input.name}`,
    documentation_url: null,
    metadata: {},
    repo_metadata:
      input.repoMetadata === undefined
        ? {
            full_name: `example/${input.name}`,
            stargazers_count: 100,
            topics: [input.name],
          }
        : input.repoMetadata,
    repo_metadata_updated_at: "2026-04-02T00:00:00.000Z",
    dependent_packages_count: input.dependentPackagesCount,
    downloads: input.downloads,
    downloads_period: "last-month",
    dependent_repos_count: 100,
    rankings: {},
    purl: `pkg:npm/${input.name}`,
    advisories: [],
    versions_url: `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeURIComponent(
      input.name
    )}/versions`,
    version_numbers_url: `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeURIComponent(
      input.name
    )}/version_numbers`,
    dependent_packages_url: `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeURIComponent(
      input.name
    )}/dependent_packages`,
    related_packages_url: `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeURIComponent(
      input.name
    )}/related_packages`,
    codemeta_url: `https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/${encodeURIComponent(
      input.name
    )}/codemeta`,
    docker_usage_url: `https://docker.ecosyste.ms/usage/npm/${encodeURIComponent(input.name)}`,
    docker_dependents_count: 0,
    docker_downloads_count: 0,
    usage_url: `https://repos.ecosyste.ms/usage/npm/${encodeURIComponent(input.name)}`,
    dependent_repositories_url: `https://repos.ecosyste.ms/api/v1/usage/npm/${encodeURIComponent(
      input.name
    )}/dependencies`,
    status: null,
    funding_links: [],
    critical: false,
    issue_metadata: {},
    maintainers: [],
  }
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  })
}
