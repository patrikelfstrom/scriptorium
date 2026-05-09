import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

import PQueue from "p-queue"
import pRetry, { AbortError } from "p-retry"

import type { CatalogDatabaseClient } from "./database"
import {
  createReplaceTagStatements,
  createUpsertPackageStatement,
  createPackageUrl,
  type CatalogPackageRecord,
} from "./package-store"

const DEFAULT_DOWNLOADS_PERIOD = "last-month"
const DEFAULT_GITHUB_BATCH_SIZE = 50
const DEFAULT_NPM_FETCH_CONCURRENCY = 12
const DEFAULT_WRITE_BATCH_SIZE = 25
const DEFAULT_SYNC_USER_AGENT = "scriptorium/0.1.1"
const HTTP_TOO_MANY_REQUESTS = 429
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])
const require = createRequire(import.meta.url)

type DownloadCountsModule = Record<string, number>

type DownloadCountEntry = {
  packageName: string
  packageDownloads: number
}

type NpmPackageMetadata = {
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

export type SyncNpmCatalogOptions = {
  githubToken: string
  onProgress?: (message: string) => void
  syncLimit: number
  npmRegistryBaseUrl?: string
  githubGraphqlUrl?: string
  downloadCountsEntries?: DownloadCountEntry[]
  npmFetchConcurrency?: number
  githubBatchSize?: number
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

  const topPackages = await loadTopDownloadCountEntries(options)
  options.onProgress?.(
    `Selected ${topPackages.length} npm packages from download-counts.`
  )

  const packageMetadata = await fetchNpmPackageMetadataBatch(
    topPackages,
    options
  )
  options.onProgress?.(
    `Fetched npm registry metadata for ${packageMetadata.length} packages.`
  )

  const githubRepositories = new Map<string, GitHubRepositoryRef>()

  for (const item of packageMetadata) {
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

  for (
    let index = 0;
    index < packageMetadata.length;
    index += DEFAULT_WRITE_BATCH_SIZE
  ) {
    const batch = packageMetadata.slice(index, index + DEFAULT_WRITE_BATCH_SIZE)
    const statements = batch.flatMap((item) => {
      const repositoryRef = parseGitHubRepositoryRef(item.repositoryUrl)
      const enrichmentOutcome = getRepositoryEnrichmentOutcome(
        item.repositoryUrl,
        repositoryRef,
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
        preserveRepositoryStarsOnNull: enrichmentOutcome.kind === "preserve",
      }

      const statements = [
        createUpsertPackageStatement(packageRecord),
        ...createReplaceTagStatements(
          "package_tags",
          item.packageName,
          item.packageTags
        ),
      ]

      if (enrichmentOutcome.kind === "replace") {
        statements.push(
          ...createReplaceTagStatements(
            "repository_tags",
            item.packageName,
            enrichmentOutcome.repositoryTags
          )
        )
      }

      return statements
    })

    await client.batch(statements, "write")
  }

  await pruneOrphanedTags(client)

  options.onProgress?.(`Stored ${packageMetadata.length} npm packages total.`)

  return {
    syncedCount: packageMetadata.length,
  }
}

export function selectTopDownloadCountEntries(
  entries: DownloadCountEntry[],
  syncLimit: number
) {
  return [...entries]
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
    .slice(0, Math.max(1, syncLimit))
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
  repositoryUrl: string | null,
  repositoryRef: GitHubRepositoryRef | undefined,
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
    return { kind: "preserve" }
  }

  return {
    kind: "replace",
    repositoryStars: githubMetadata.repositoryStars,
    repositoryTags: githubMetadata.repositoryTags,
  }
}

async function loadTopDownloadCountEntries(options: SyncNpmCatalogOptions) {
  const entries =
    options.downloadCountsEntries ?? (await loadDownloadCountsEntries())

  return selectTopDownloadCountEntries(entries, options.syncLimit)
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

  const results = await Promise.all(
    packages.map((entry) =>
      queue.add(async () => fetchNpmPackageMetadata(entry, options))
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
    options.onProgress?.(`Skipping missing npm package ${packageName}.`)
    return undefined
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch npm registry metadata for ${packageName}: ${response.status} ${response.statusText}`
    )
  }

  const payload = (await response.json()) as NpmRegistryDocument
  const latestVersionTag = normalizeOptionalString(payload["dist-tags"]?.latest)
  const latestVersion =
    latestVersionTag && payload.versions
      ? payload.versions[latestVersionTag]
      : undefined

  return {
    packageName,
    packageUrl: createPackageUrl(packageName),
    packageDescription:
      normalizeOptionalString(latestVersion?.description) ??
      normalizeOptionalString(payload.description) ??
      null,
    homepageUrl:
      normalizeUrl(latestVersion?.homepage) ??
      normalizeUrl(payload.homepage) ??
      null,
    repositoryUrl:
      normalizeRepositoryUrl(latestVersion?.repository) ??
      normalizeRepositoryUrl(payload.repository) ??
      null,
    packageDownloads: entry.packageDownloads,
    packageDownloadsPeriod: DEFAULT_DOWNLOADS_PERIOD,
    packageLastPublishedAt: extractLatestPublishedAt(payload, latestVersionTag),
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

  for (let index = 0; index < repositories.length; index += githubBatchSize) {
    const batch = repositories.slice(index, index + githubBatchSize)
    const batchMetadata = await fetchGitHubRepositoryMetadata(
      batch,
      githubGraphqlUrl,
      input.githubToken
    )

    for (const [key, value] of batchMetadata) {
      repositoryMetadata.set(key, value)
    }

    input.onProgress?.(
      `Enriched ${Math.min(index + batch.length, repositories.length)}/${repositories.length} GitHub repositories.`
    )
  }

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
    throw new Error(
      `Failed to fetch GitHub repository metadata: ${response.status} ${response.statusText}`
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
  if (!latestVersionTag) {
    return null
  }

  return normalizeTimestamp(payload.time?.[latestVersionTag]) ?? null
}

function normalizeKeywords(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
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
      nodes
        .map((node) => normalizeOptionalString(node.topic?.name))
        .filter((value): value is string => Boolean(value))
    )
  )
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
