import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { promisify } from "node:util"

import PQueue from "p-queue"
import pRetry, { AbortError } from "p-retry"

import type { CatalogDatabaseClient } from "./database"
import {
  resolveLatestPublishedAt,
  resolveLatestVersionEntry,
} from "./npm-registry"
import {
  createReplaceTagStatements,
  createPackageUrl,
  createRebuildPackageSearchStatements,
  createRebuildTagStatsStatements,
  createRefreshPackageSearchStatementsForPackages,
  createRefreshTagStatsStatements,
  createUpsertPackageStatement,
  type CatalogPackageRecord,
} from "./package-store"
import {
  createNpmViewUnresolvablePackageMarker,
  createUnpublishedPackageMarker,
  createRemovedPackageSql,
  hasUnpublishedRegistryMarker,
  isSecurityHoldingPackage,
} from "./package-removal"
import { normalizeTagValue } from "./tag-normalization"

const DEFAULT_DOWNLOADS_PERIOD = "last-month"
const DEFAULT_GITHUB_BATCH_SIZE = 50
const DEFAULT_NPM_FETCH_CONCURRENCY = 12
const DEFAULT_WRITE_BATCH_SIZE = 25
const DEFAULT_SYNC_USER_AGENT = "scriptorium/0.1.1"
const PROGRESS_INTERVAL_MS = 60_000
const NPM_VIEW_TIMEOUT_MS = 1_000
const HTTP_TOO_MANY_REQUESTS = 429
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

type DownloadCountsModule = Record<string, number>

type DownloadCountEntry = {
  packageName: string
  packageDownloads: number
}

type NpmPackageMetadata = {
  isRemoved: boolean
  packageName: string
  packageUrl: string
  packageDescription: string | null
  homepageUrl: string | null
  repositoryUrl: string | null
  packageDownloads: number
  packageDownloadsPeriod: string
  packageLastPublishedAt: string | null
  packageTags: string[]
}

type GitHubRepositoryRef = {
  owner: string
  name: string
}

type GitHubRepositoryMetadata = {
  repositoryStars: number | null
  repositoryTags: string[]
}

type RepositoryEnrichmentOutcome =
  | {
      kind: "preserve"
    }
  | {
      kind: "replace"
      repositoryStars: number | null
      repositoryTags: string[]
    }

type GitHubRepositoryMetadataMap = Map<string, GitHubRepositoryMetadata>
type GitHubRepositoryBatchResponse = Record<
  string,
  | {
      stargazerCount?: unknown
      repositoryTopics?: {
        nodes?: Array<{
          topic?: {
            name?: unknown
          }
        }>
      }
    }
  | null
  | undefined
>

class GitHubMetadataFetchError extends Error {
  status: number
  statusText: string
  responseBody: string | null

  constructor(
    status: number,
    statusText: string,
    responseBody: string | null = null
  ) {
    const responseSuffix = responseBody
      ? ` (${truncateSingleLine(responseBody, 200)})`
      : ""

    super(
      `Failed to fetch GitHub repository metadata: ${status} ${statusText}${responseSuffix}`
    )
    this.name = "GitHubMetadataFetchError"
    this.status = status
    this.statusText = statusText
    this.responseBody = responseBody
  }
}

type SyncNpmCatalogOptions = {
  githubToken: string
  onProgress?: (message: string) => void
  topPackageLimit: number
  npmRegistryBaseUrl?: string
  githubGraphqlUrl?: string
  downloadCountsEntries?: DownloadCountEntry[]
  npmFetchConcurrency?: number
  githubBatchSize?: number
  shardCount?: number
  shardIndex?: number
  npmViewRunner?: (packageName: string) => Promise<boolean | null>
}

export async function syncNpmCatalog(
  client: CatalogDatabaseClient,
  options: SyncNpmCatalogOptions
) {
  const syncedAt = new Date().toISOString()
  const githubToken = normalizeOptionalString(options.githubToken)

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required for npm catalog sync.")
  }

  const topPackages = await loadTopDownloadCountEntries(client, options)
  options.onProgress?.(createSelectionProgressMessage(topPackages, options))
  options.onProgress?.(
    `Fetching npm registry metadata for ${topPackages.length} packages.`
  )

  const packageMetadata = await fetchNpmPackageMetadataBatch(
    topPackages,
    options
  )
  options.onProgress?.(
    `Fetched npm registry metadata for ${packageMetadata.length} packages.`
  )
  const existingRepositoryUrlsByPackage = await loadExistingRepositoryUrls(
    client,
    packageMetadata.map((item) => item.packageName)
  )

  const githubRepositories = new Map<string, GitHubRepositoryRef>()

  for (const item of packageMetadata) {
    if (item.isRemoved) {
      continue
    }

    const repositoryRef = parseGitHubRepositoryRef(item.repositoryUrl)

    if (repositoryRef) {
      githubRepositories.set(
        `${repositoryRef.owner}/${repositoryRef.name}`,
        repositoryRef
      )
    }
  }

  options.onProgress?.(
    `Enriching ${githubRepositories.size} GitHub repositories.`
  )

  const githubMetadataByRepository = await fetchGitHubRepositoryMetadataBatch(
    Array.from(githubRepositories.values()),
    {
      githubBatchSize: options.githubBatchSize,
      githubGraphqlUrl: options.githubGraphqlUrl,
      githubToken,
      onProgress: options.onProgress,
    }
  )

  options.onProgress?.(
    `Writing ${packageMetadata.length} npm packages to the catalog.`
  )
  let storedCount = 0
  let lastWriteProgressAt = Date.now()
  const writeQueue = new PQueue({ concurrency: 1 })
  const writeTasks: Array<Promise<void>> = []

  for (
    let index = 0;
    index < packageMetadata.length;
    index += DEFAULT_WRITE_BATCH_SIZE
  ) {
    const batch = packageMetadata.slice(index, index + DEFAULT_WRITE_BATCH_SIZE)
    writeTasks.push(
      writeQueue.add(async () => {
        const batchPackageNames = batch.map((item) => item.packageName)
        const affectedTagIds = new Set(
          await loadExistingTagIdsForPackages(client, batchPackageNames)
        )
        const statements = batch.flatMap((item) => {
          const repositoryRef = parseGitHubRepositoryRef(item.repositoryUrl)
          const enrichmentOutcome = item.isRemoved
            ? {
                kind: "replace" as const,
                repositoryStars: null,
                repositoryTags: [],
              }
            : getRepositoryEnrichmentOutcome(
                item.packageName,
                item.repositoryUrl,
                repositoryRef,
                existingRepositoryUrlsByPackage,
                githubMetadataByRepository
              )

          const packageRecord: CatalogPackageRecord = {
            packageName: item.packageName,
            repositoryUrl: item.repositoryUrl,
            packageUrl: item.packageUrl,
            packageDescription: item.packageDescription,
            homepageUrl: item.homepageUrl,
            repositoryStars:
              enrichmentOutcome.kind === "replace"
                ? enrichmentOutcome.repositoryStars
                : null,
            packageDownloads: item.packageDownloads,
            packageDownloadsPeriod: item.packageDownloadsPeriod,
            packageLastPublishedAt: item.packageLastPublishedAt,
            lastSyncedAt: syncedAt,
            preserveRepositoryUrlOnNull: item.repositoryUrl == null,
            preservePackageDescriptionOnNull: item.packageDescription == null,
            preserveHomepageUrlOnNull: item.homepageUrl == null,
            preserveRepositoryStarsOnNull:
              enrichmentOutcome.kind === "preserve",
          }

          const statements = [
            createUpsertPackageStatement(packageRecord),
            ...createReplaceTagStatements(
              "package_tags",
              item.packageName,
              item.packageTags
            ),
          ]
          collectNormalizedTagIds(item.packageTags).forEach((tagId) => {
            affectedTagIds.add(tagId)
          })

          if (enrichmentOutcome.kind === "replace") {
            statements.push(
              ...createReplaceTagStatements(
                "repository_tags",
                item.packageName,
                enrichmentOutcome.repositoryTags
              )
            )
            collectNormalizedTagIds(enrichmentOutcome.repositoryTags).forEach(
              (tagId) => {
                affectedTagIds.add(tagId)
              }
            )
          }

          return statements
        })
        statements.push(
          ...createRefreshPackageSearchStatementsForPackages(batchPackageNames)
        )

        await client.batch(statements, "write")
        await client.batch(
          createRefreshTagStatsStatements(Array.from(affectedTagIds)),
          "write"
        )
        storedCount += batch.length

        const now = Date.now()

        if (
          now - lastWriteProgressAt >= PROGRESS_INTERVAL_MS ||
          storedCount === packageMetadata.length
        ) {
          options.onProgress?.(
            `Stored ${storedCount}/${packageMetadata.length} npm packages.`
          )
          lastWriteProgressAt = now
        }
      })
    )
  }

  await Promise.all(writeTasks)

  options.onProgress?.("Pruning orphaned tags.")
  await pruneOrphanedTags(client)
  options.onProgress?.("Rebuilding package search index.")
  await client.batch(createRebuildPackageSearchStatements(), "write")
  options.onProgress?.("Rebuilding tag stats.")
  await client.batch(createRebuildTagStatsStatements(), "write")

  options.onProgress?.(`Stored ${packageMetadata.length} npm packages total.`)

  return {
    syncedCount: packageMetadata.length,
  }
}

export function selectTopDownloadCountEntries(
  entries: DownloadCountEntry[],
  selection:
    | number
    | {
        topPackageLimit: number
        shardCount?: number
        shardIndex?: number
      }
) {
  const { topPackageLimit, shardCount, shardIndex } =
    normalizeDownloadCountSelection(selection)

  const topEntries = [...entries]
    .filter(
      (entry) =>
        normalizeOptionalString(entry.packageName) &&
        Number.isFinite(entry.packageDownloads) &&
        entry.packageDownloads > 0
    )
    .sort(
      (left, right) =>
        right.packageDownloads - left.packageDownloads ||
        left.packageName.localeCompare(right.packageName)
    )
    .slice(0, topPackageLimit)

  if (typeof shardCount === "undefined" || typeof shardIndex === "undefined") {
    return topEntries
  }

  return topEntries.filter(
    (entry) => calculateShardIndex(entry.packageName, shardCount) === shardIndex
  )
}

export function parseGitHubRepositoryRef(repositoryUrl?: string | null) {
  const normalizedRepositoryUrl = normalizeRepositoryUrl(repositoryUrl)

  if (!normalizedRepositoryUrl) {
    return undefined
  }

  try {
    const url = new URL(normalizedRepositoryUrl)

    if (url.hostname !== "github.com") {
      return undefined
    }

    const [owner, name] = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .slice(0, 2)

    if (!owner || !name) {
      return undefined
    }

    return { owner, name }
  } catch {
    return undefined
  }
}

function getRepositoryEnrichmentOutcome(
  packageName: string,
  repositoryUrl: string | null,
  repositoryRef: GitHubRepositoryRef | undefined,
  existingRepositoryUrlsByPackage: Map<string, string | null>,
  githubMetadataByRepository: GitHubRepositoryMetadataMap
): RepositoryEnrichmentOutcome {
  if (!repositoryUrl) {
    return { kind: "preserve" }
  }

  if (!repositoryRef) {
    return {
      kind: "replace",
      repositoryStars: null,
      repositoryTags: [],
    }
  }

  const githubMetadata = githubMetadataByRepository.get(
    `${repositoryRef.owner}/${repositoryRef.name}`
  )

  if (!githubMetadata) {
    const previousRepositoryRef = parseGitHubRepositoryRef(
      existingRepositoryUrlsByPackage.get(packageName) ?? null
    )

    if (
      previousRepositoryRef &&
      previousRepositoryRef.owner === repositoryRef.owner &&
      previousRepositoryRef.name === repositoryRef.name
    ) {
      return { kind: "preserve" }
    }

    return {
      kind: "replace",
      repositoryStars: null,
      repositoryTags: [],
    }
  }

  return {
    kind: "replace",
    repositoryStars: githubMetadata.repositoryStars,
    repositoryTags: githubMetadata.repositoryTags,
  }
}

async function loadTopDownloadCountEntries(
  client: CatalogDatabaseClient,
  options: SyncNpmCatalogOptions
) {
  const entries =
    options.downloadCountsEntries ?? (await loadDownloadCountsEntries())
  const removedPackageNames = await loadRemovedPackageNames(client)
  const eligibleEntries =
    removedPackageNames.size === 0
      ? entries
      : entries.filter(
          (entry) =>
            !removedPackageNames.has(
              normalizeOptionalString(entry.packageName) ?? ""
            )
        )

  return selectTopDownloadCountEntries(eligibleEntries, {
    topPackageLimit: options.topPackageLimit,
    shardCount: options.shardCount,
    shardIndex: options.shardIndex,
  })
}

async function loadRemovedPackageNames(client: CatalogDatabaseClient) {
  const result = await client.execute({
    sql: `
      SELECT package_name
      FROM packages p
      WHERE ${createRemovedPackageSql("p")}
    `,
  })

  return new Set(result.rows.map((row) => String(row.package_name)))
}

async function loadExistingRepositoryUrls(
  client: CatalogDatabaseClient,
  packageNames: string[]
) {
  const repositoryUrls = new Map<string, string | null>()
  const uniquePackageNames = Array.from(new Set(packageNames))

  const batches = getChunkedEntries(uniquePackageNames, 500)
  const results = await Promise.all(
    batches.map(async (batch) => {
      const placeholders = batch.map(() => "?").join(", ")

      return client.execute({
        sql: `
          SELECT package_name, repository_url
          FROM packages
          WHERE package_name IN (${placeholders})
        `,
        args: batch,
      })
    })
  )

  for (const result of results) {
    for (const row of result.rows) {
      repositoryUrls.set(
        String(row.package_name),
        normalizeStoredUrl(row.repository_url)
      )
    }
  }

  return repositoryUrls
}

async function loadExistingTagIdsForPackages(
  client: CatalogDatabaseClient,
  packageNames: string[]
) {
  const uniquePackageNames = Array.from(new Set(packageNames))

  if (uniquePackageNames.length === 0) {
    return [] as string[]
  }

  const placeholders = uniquePackageNames.map(() => "?").join(", ")
  const result = await client.execute({
    sql: `
      SELECT DISTINCT tag_id
      FROM (
        SELECT tag_id
        FROM package_tags
        WHERE package_name IN (${placeholders})
        UNION ALL
        SELECT tag_id
        FROM repository_tags
        WHERE package_name IN (${placeholders})
      )
    `,
    args: [...uniquePackageNames, ...uniquePackageNames],
  })

  return result.rows.map((row) => String(row.tag_id))
}

function normalizeStoredUrl(value: unknown) {
  return typeof value === "string" ? value : null
}

function collectNormalizedTagIds(rawTags: string[]) {
  return Array.from(
    new Set(
      rawTags.flatMap((rawTag) => {
        const normalizedRawTag = normalizeOptionalString(rawTag)
        const normalizedTagId = normalizedRawTag
          ? normalizeTagValue(normalizedRawTag)
          : undefined

        return normalizedTagId ? [normalizedTagId] : []
      })
    )
  )
}

function normalizeDownloadCountSelection(
  selection:
    | number
    | {
        topPackageLimit: number
        shardCount?: number
        shardIndex?: number
      }
) {
  const topPackageLimit =
    typeof selection === "number"
      ? Math.max(1, selection)
      : Math.max(1, selection.topPackageLimit)
  const shardCount =
    typeof selection === "number" ? undefined : selection.shardCount
  const shardIndex =
    typeof selection === "number" ? undefined : selection.shardIndex

  if (
    (typeof shardCount === "undefined") !==
    (typeof shardIndex === "undefined")
  ) {
    throw new Error(
      "NPM sync sharding requires both shardCount and shardIndex."
    )
  }

  if (typeof shardCount === "undefined" || typeof shardIndex === "undefined") {
    return { topPackageLimit }
  }

  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("NPM sync shardCount must be a positive integer.")
  }

  if (!Number.isInteger(shardIndex) || shardIndex < 0) {
    throw new Error("NPM sync shardIndex must be a non-negative integer.")
  }

  if (shardIndex >= shardCount) {
    throw new Error("NPM sync shardIndex must be less than shardCount.")
  }

  return { topPackageLimit, shardCount, shardIndex }
}

function calculateShardIndex(packageName: string, shardCount: number) {
  let hash = 0

  for (let index = 0; index < packageName.length; index += 1) {
    hash = (hash * 31 + packageName.charCodeAt(index)) >>> 0
  }

  return hash % shardCount
}

function createSelectionProgressMessage(
  selectedPackages: DownloadCountEntry[],
  options: SyncNpmCatalogOptions
) {
  if (
    typeof options.shardCount === "number" &&
    typeof options.shardIndex === "number"
  ) {
    return `Selected ${selectedPackages.length} npm packages from the top ${options.topPackageLimit} download-count entries for shard ${options.shardIndex + 1}/${options.shardCount}.`
  }

  return `Selected ${selectedPackages.length} npm packages from the top ${options.topPackageLimit} download-count entries.`
}

async function loadDownloadCountsEntries() {
  const countsJsonPath = require.resolve("download-counts")
  const downloadCounts = JSON.parse(
    await readFile(countsJsonPath, "utf8")
  ) as DownloadCountsModule

  if (!downloadCounts || typeof downloadCounts !== "object") {
    throw new Error("download-counts did not export a package count map.")
  }

  return Object.entries(downloadCounts).map(
    ([packageName, packageDownloads]) => ({
      packageName,
      packageDownloads: normalizeInteger(packageDownloads),
    })
  )
}

async function fetchNpmPackageMetadataBatch(
  packages: DownloadCountEntry[],
  options: SyncNpmCatalogOptions
) {
  const queue = new PQueue({
    concurrency: options.npmFetchConcurrency ?? DEFAULT_NPM_FETCH_CONCURRENCY,
  })
  let completedCount = 0
  let lastProgressAt = Date.now()

  const results = await Promise.all(
    packages.map((entry) =>
      queue.add(async () => {
        const result = await fetchNpmPackageMetadata(entry, options)
        completedCount += 1

        const now = Date.now()

        if (
          now - lastProgressAt >= PROGRESS_INTERVAL_MS ||
          completedCount === packages.length
        ) {
          options.onProgress?.(
            `Fetched npm metadata for ${completedCount}/${packages.length} packages.`
          )
          lastProgressAt = now
        }

        return result
      })
    )
  )

  return results.filter(
    (item): item is NpmPackageMetadata => typeof item !== "undefined"
  )
}

async function fetchNpmPackageMetadata(
  entry: DownloadCountEntry,
  options: SyncNpmCatalogOptions
) {
  const packageName = normalizeOptionalString(entry.packageName)

  if (!packageName) {
    return undefined
  }

  const npmRegistryBaseUrl = stripTrailingSlash(
    options.npmRegistryBaseUrl ?? "https://registry.npmjs.org"
  )
  const requestUrl = `${npmRegistryBaseUrl}/${encodeURIComponent(packageName)}`
  const response = await retryableFetch(requestUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": DEFAULT_SYNC_USER_AGENT,
    },
  })

  if (response.status === 404) {
    options.onProgress?.(
      `Marking npm package ${packageName} as removed because the npm registry returned 404.`
    )

    const unpublishedMarker = createUnpublishedPackageMarker()

    return {
      isRemoved: true,
      packageName,
      packageUrl: createPackageUrl(packageName),
      packageDescription: unpublishedMarker.packageDescription,
      homepageUrl: unpublishedMarker.homepageUrl,
      repositoryUrl: unpublishedMarker.repositoryUrl,
      packageDownloads: entry.packageDownloads,
      packageDownloadsPeriod: DEFAULT_DOWNLOADS_PERIOD,
      packageLastPublishedAt: null,
      packageTags: [],
    }
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch npm registry metadata for ${packageName}: ${response.status} ${response.statusText}`
    )
  }

  const payload = (await response.json()) as NpmRegistryDocument

  if (hasUnpublishedRegistryMarker(payload)) {
    options.onProgress?.(
      `Marking npm package ${packageName} as removed because the registry document is marked unpublished.`
    )

    const unpublishedMarker = createUnpublishedPackageMarker()

    return {
      isRemoved: true,
      packageName,
      packageUrl: createPackageUrl(packageName),
      packageDescription: unpublishedMarker.packageDescription,
      homepageUrl: unpublishedMarker.homepageUrl,
      repositoryUrl: unpublishedMarker.repositoryUrl,
      packageDownloads: entry.packageDownloads,
      packageDownloadsPeriod: DEFAULT_DOWNLOADS_PERIOD,
      packageLastPublishedAt: null,
      packageTags: [],
    }
  }

  const rawLatestVersionTag = normalizeOptionalString(
    payload["dist-tags"]?.latest
  )
  const { latestVersionTag, latestVersion } = resolveLatestVersionEntry({
    latestVersionTag: rawLatestVersionTag,
    versions: payload.versions,
  })
  const packageDescription =
    normalizeOptionalString(latestVersion?.description) ??
    normalizeOptionalString(payload.description) ??
    null
  const homepageUrl =
    normalizeUrl(latestVersion?.homepage) ??
    normalizeUrl(payload.homepage) ??
    null
  const repositoryUrl =
    normalizeRepositoryUrl(latestVersion?.repository) ??
    normalizeRepositoryUrl(payload.repository) ??
    null
  const isRemoved = isSecurityHoldingPackage({
    latestVersionTag: rawLatestVersionTag ?? latestVersionTag,
    packageDescription,
    repositoryUrl,
    homepageUrl,
  })
  const packageLastPublishedAt = extractLatestPublishedAt(
    payload,
    latestVersionTag
  )

  if (isRemoved) {
    options.onProgress?.(
      `Marking npm package ${packageName} as removed because npm returned a security holding package.`
    )

    return {
      isRemoved,
      packageName,
      packageUrl: createPackageUrl(packageName),
      packageDescription,
      homepageUrl,
      repositoryUrl,
      packageDownloads: entry.packageDownloads,
      packageDownloadsPeriod: DEFAULT_DOWNLOADS_PERIOD,
      packageLastPublishedAt,
      packageTags: [],
    }
  }

  if (
    shouldValidatePackageWithNpmView({
      homepageUrl,
      packageDescription,
      packageLastPublishedAt,
      repositoryUrl,
    })
  ) {
    const npmViewResolves =
      typeof options.npmViewRunner === "function"
        ? await options.npmViewRunner(packageName)
        : await resolvePackageWithNpmView(packageName)

    if (npmViewResolves === null) {
      options.onProgress?.(
        `Skipping npm package ${packageName} because npm view validation was inconclusive.`
      )
      return undefined
    }

    if (npmViewResolves === false) {
      options.onProgress?.(
        `Marking npm package ${packageName} as removed because npm view could not resolve it.`
      )

      const npmViewMarker = createNpmViewUnresolvablePackageMarker()

      return {
        isRemoved: true,
        packageName,
        packageUrl: createPackageUrl(packageName),
        packageDescription: npmViewMarker.packageDescription,
        homepageUrl: npmViewMarker.homepageUrl,
        repositoryUrl: npmViewMarker.repositoryUrl,
        packageDownloads: entry.packageDownloads,
        packageDownloadsPeriod: DEFAULT_DOWNLOADS_PERIOD,
        packageLastPublishedAt: null,
        packageTags: [],
      }
    }
  }

  return {
    isRemoved: false,
    packageName,
    packageUrl: createPackageUrl(packageName),
    packageDescription,
    homepageUrl,
    repositoryUrl,
    packageDownloads: entry.packageDownloads,
    packageDownloadsPeriod: DEFAULT_DOWNLOADS_PERIOD,
    packageLastPublishedAt,
    packageTags: normalizeKeywords(latestVersion?.keywords ?? payload.keywords),
  }
}

async function fetchGitHubRepositoryMetadataBatch(
  repositories: GitHubRepositoryRef[],
  input: {
    githubBatchSize?: number
    githubGraphqlUrl?: string
    githubToken: string
    onProgress?: (message: string) => void
  }
) {
  const repositoryMetadata = new Map<string, GitHubRepositoryMetadata>()
  const githubGraphqlUrl =
    input.githubGraphqlUrl ?? "https://api.github.com/graphql"
  const githubBatchSize = input.githubBatchSize ?? DEFAULT_GITHUB_BATCH_SIZE
  const githubQueue = new PQueue({ concurrency: 1 })
  const githubTasks: Array<Promise<void>> = []
  let isEnrichmentUnavailable = false

  getChunkedEntries(repositories, githubBatchSize).forEach(
    (batch, batchIndex) => {
      githubTasks.push(
        githubQueue.add(async () => {
          if (isEnrichmentUnavailable) {
            return
          }

          let batchMetadata: GitHubRepositoryMetadataMap

          try {
            batchMetadata = await fetchGitHubRepositoryMetadata(
              batch,
              githubGraphqlUrl,
              input.githubToken
            )
          } catch (error) {
            if (isRecoverableGitHubMetadataError(error)) {
              isEnrichmentUnavailable = true
              input.onProgress?.(
                `GitHub repository enrichment became unavailable (${error.message}). Preserving previously synced repository metadata for any repositories not enriched in this run.`
              )
              return
            }

            throw error
          }

          for (const [key, value] of batchMetadata) {
            repositoryMetadata.set(key, value)
          }

          input.onProgress?.(
            `Enriched ${Math.min((batchIndex + 1) * githubBatchSize, repositories.length)}/${repositories.length} GitHub repositories.`
          )
        })
      )
    }
  )

  await Promise.all(githubTasks)

  return repositoryMetadata
}

async function fetchGitHubRepositoryMetadata(
  repositories: GitHubRepositoryRef[],
  githubGraphqlUrl: string,
  githubToken: string
): Promise<GitHubRepositoryMetadataMap> {
  if (repositories.length === 0) {
    return new Map()
  }

  const response = await retryableFetch(githubGraphqlUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_SYNC_USER_AGENT,
    },
    body: JSON.stringify({
      query: createGitHubRepositoryMetadataQuery(repositories),
    }),
  })

  if (!response.ok) {
    throw new GitHubMetadataFetchError(
      response.status,
      response.statusText,
      await response.text()
    )
  }

  const payload = (await response.json()) as {
    data?: GitHubRepositoryBatchResponse
    errors?: Array<{ message?: string }>
  }

  if (
    payload.errors &&
    payload.errors.length > 0 &&
    !hasGitHubRepositoryData(payload.data)
  ) {
    throw new Error(
      `GitHub GraphQL request failed: ${payload.errors
        .map((error) => error.message ?? "Unknown GraphQL error")
        .join("; ")}`
    )
  }

  const results = new Map<string, GitHubRepositoryMetadata>()

  repositories.forEach((repository, index) => {
    const alias = createGitHubAlias(index)
    const node = payload.data?.[alias]

    if (!node) {
      return
    }

    results.set(`${repository.owner}/${repository.name}`, {
      repositoryStars:
        typeof node.stargazerCount === "number" ? node.stargazerCount : null,
      repositoryTags: normalizeGitHubTopics(node.repositoryTopics?.nodes),
    })
  })

  return results
}

function hasGitHubRepositoryData(data?: GitHubRepositoryBatchResponse) {
  if (!data) {
    return false
  }

  return Object.values(data).some((value) => value != null)
}

function isRecoverableGitHubMetadataError(
  error: unknown
): error is GitHubMetadataFetchError {
  return error instanceof GitHubMetadataFetchError && error.status === 403
}

function createGitHubRepositoryMetadataQuery(
  repositories: GitHubRepositoryRef[]
) {
  const fields = repositories
    .map(
      (repository, index) => `
        ${createGitHubAlias(index)}: repository(owner: ${JSON.stringify(
          repository.owner
        )}, name: ${JSON.stringify(repository.name)}) {
          stargazerCount
          repositoryTopics(first: 20) {
            nodes {
              topic {
                name
              }
            }
          }
        }
      `
    )
    .join("\n")

  return `query RepositoryMetadata {\n${fields}\n}`
}

function createGitHubAlias(index: number) {
  return `repo_${index}`
}

function truncateSingleLine(value: string, maxLength: number) {
  const normalizedValue = value.replace(/\s+/g, " ").trim()

  if (normalizedValue.length <= maxLength) {
    return normalizedValue
  }

  return `${normalizedValue.slice(0, maxLength - 3)}...`
}

async function retryableFetch(url: string, init?: RequestInit) {
  return pRetry(
    async () => {
      const response = await fetch(url, init)

      if (response.status === 404) {
        return response
      }

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        throw new Error(`Retryable HTTP ${response.status} for ${url}`)
      }

      return response
    },
    {
      retries: 3,
      onFailedAttempt(error) {
        if (
          error instanceof Error &&
          error.message.includes(String(HTTP_TOO_MANY_REQUESTS))
        ) {
          return
        }
      },
      shouldRetry(error) {
        if (error instanceof AbortError) {
          return false
        }

        return error instanceof Error
      },
    }
  )
}

async function pruneOrphanedTags(client: CatalogDatabaseClient) {
  await client.execute(`
    DELETE FROM tag_aliases
    WHERE tag_id NOT IN (
      SELECT DISTINCT tag_id FROM package_tags
      UNION
      SELECT DISTINCT tag_id FROM repository_tags
    )
  `)
  await client.execute(`
    DELETE FROM tags
    WHERE tag_id NOT IN (
      SELECT DISTINCT tag_id FROM package_tags
      UNION
      SELECT DISTINCT tag_id FROM repository_tags
    )
  `)
}

function extractLatestPublishedAt(
  payload: NpmRegistryDocument,
  latestVersionTag?: string
) {
  return (
    normalizeTimestamp(
      resolveLatestPublishedAt({
        latestVersionTag,
        time: payload.time,
      })
    ) ?? null
  )
}

function shouldValidatePackageWithNpmView(input: {
  packageDescription: string | null
  repositoryUrl: string | null
  homepageUrl: string | null
  packageLastPublishedAt: string | null
}) {
  return input.repositoryUrl == null || input.packageLastPublishedAt == null
}

async function resolvePackageWithNpmView(packageName: string) {
  try {
    await execFileAsync(
      "npm",
      ["view", packageName, "name", "version", "--json"],
      {
        timeout: NPM_VIEW_TIMEOUT_MS,
      }
    )
    return true
  } catch (error) {
    if (isNpmViewNotFoundError(error)) {
      return false
    }

    if (isNpmViewIndeterminateError(error)) {
      return null
    }

    throw error
  }
}

function isNpmViewIndeterminateError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === null &&
    "signal" in error &&
    (error as { signal?: unknown }).signal === "SIGTERM"
  )
}

function isNpmViewNotFoundError(error: unknown) {
  const stderr =
    error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : ""
  const combinedMessage = [
    error instanceof Error ? error.message : String(error),
    stderr,
  ]
    .join("\n")
    .toLowerCase()

  return (
    combinedMessage.includes("npm error code e404") ||
    combinedMessage.includes("no match found for version") ||
    combinedMessage.includes("could not be found") ||
    combinedMessage.includes("not in this registry")
  )
}

function normalizeKeywords(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(
    new Set(
      value.flatMap((item) => {
        if (typeof item !== "string") {
          return []
        }

        const normalizedItem = item.trim()
        return normalizedItem ? [normalizedItem] : []
      })
    )
  )
}

function normalizeGitHubTopics(
  nodes?: Array<{
    topic?: {
      name?: unknown
    }
  }>
) {
  if (!Array.isArray(nodes)) {
    return []
  }

  return Array.from(
    new Set(
      nodes.flatMap((node) => {
        const normalizedTopic = normalizeOptionalString(node.topic?.name)
        return normalizedTopic ? [normalizedTopic] : []
      })
    )
  )
}

function getChunkedEntries<T>(entries: T[], chunkSize: number) {
  const chunks: T[][] = []

  for (let index = 0; index < entries.length; index += chunkSize) {
    chunks.push(entries.slice(index, index + chunkSize))
  }

  return chunks
}

function normalizeRepositoryUrl(value: unknown) {
  const rawValue =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "url" in value
        ? (value as { url?: unknown }).url
        : undefined
  const normalizedValue = normalizeOptionalString(rawValue)

  if (!normalizedValue) {
    return undefined
  }

  const withoutPrefix = normalizedValue.replace(/^git\+/i, "")
  const withoutHashOrQuery = withoutPrefix.replace(/[?#].*$/, "")
  const bareGitHubMatch = withoutHashOrQuery.match(
    /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/
  )

  if (bareGitHubMatch) {
    return `https://github.com/${sanitizeRepositoryPath(
      `${bareGitHubMatch[1]}/${bareGitHubMatch[2]}`
    )}`
  }

  const hostPathMatch = withoutHashOrQuery.match(
    /^(github\.com|gitlab\.com|bitbucket\.org)\/(.+)$/i
  )

  if (hostPathMatch) {
    return `https://${hostPathMatch[1].toLowerCase()}/${sanitizeRepositoryPath(
      hostPathMatch[2]
    )}`
  }

  if (/^https?:\/\//i.test(withoutHashOrQuery)) {
    try {
      const url = new URL(withoutHashOrQuery)
      const pathname = sanitizeRepositoryPath(url.pathname)

      if (!pathname) {
        return undefined
      }

      return `${url.protocol}//${url.host}/${pathname}`
    } catch {
      return undefined
    }
  }

  const sshProtocolMatch = withoutHashOrQuery.match(
    /^ssh:\/\/git@([^/]+)\/(.+)$/i
  )

  if (sshProtocolMatch) {
    return `https://${sshProtocolMatch[1]}/${sanitizeRepositoryPath(
      sshProtocolMatch[2]
    )}`
  }

  const sshMatch = withoutHashOrQuery.match(/^git@([^:]+):(.+)$/)

  if (sshMatch) {
    return `https://${sshMatch[1]}/${sanitizeRepositoryPath(sshMatch[2])}`
  }

  const gitProtocolMatch = withoutHashOrQuery.match(/^git:\/\/([^/]+)\/(.+)$/i)

  if (gitProtocolMatch) {
    return `https://${gitProtocolMatch[1]}/${sanitizeRepositoryPath(
      gitProtocolMatch[2]
    )}`
  }

  const shorthandMatch = withoutHashOrQuery.match(
    /^(github|gitlab|bitbucket):([^/]+\/[^/]+)$/i
  )

  if (shorthandMatch) {
    const host = resolveRepositoryHost(shorthandMatch[1].toLowerCase())

    return host
      ? `https://${host}/${sanitizeRepositoryPath(shorthandMatch[2])}`
      : undefined
  }

  return undefined
}

function sanitizeRepositoryPath(value: string) {
  return value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")
}

function resolveRepositoryHost(provider: string) {
  switch (provider) {
    case "github":
      return "github.com"
    case "gitlab":
      return "gitlab.com"
    case "bitbucket":
      return "bitbucket.org"
    default:
      return undefined
  }
}

function normalizeUrl(value: unknown) {
  const normalizedValue = normalizeOptionalString(value)
  return normalizedValue && /^https?:\/\//i.test(normalizedValue)
    ? normalizedValue
    : undefined
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeInteger(value: unknown) {
  return Number.isFinite(value) ? Math.trunc(value as number) : 0
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

type NpmRegistryVersion = {
  description?: unknown
  homepage?: unknown
  repository?: unknown
  keywords?: unknown
}

type NpmRegistryDocument = {
  description?: unknown
  homepage?: unknown
  repository?: unknown
  keywords?: unknown
  versions?: Record<string, NpmRegistryVersion | undefined>
  time?: Record<string, unknown>
  "dist-tags"?: {
    latest?: unknown
  }
}
