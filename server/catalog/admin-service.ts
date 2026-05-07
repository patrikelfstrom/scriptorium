import type { CatalogDatabaseClient } from "./database"
import {
  createPackageKey,
  createPrimaryUrl,
  createReplacePackageTagsStatements,
  createUpsertPackageStatement,
  type CatalogPackageRecord,
} from "./package-store"

export async function syncEcosystemsPopular(
  client: CatalogDatabaseClient,
  options: SyncEcosystemsPopularOptions
) {
  options.onProgress?.(
    `Fetching ecosyste.ms npm packages for up to ${options.syncLimit} packages.`
  )
  const packages = await fetchEcosystemsPopularPackages(options)
  const selectedPackages = packages.slice(0, options.syncLimit)
  const fetchedAt = new Date().toISOString()

  options.onProgress?.(
    `Fetched ${selectedPackages.length} ecosyste.ms packages. Writing package records...`
  )

  const writeBatchSize = 25
  const progressIntervalMs = 60_000
  let lastWriteProgressAt = Date.now()

  for (let index = 0; index < selectedPackages.length; index += writeBatchSize) {
    const batch = selectedPackages.slice(index, index + writeBatchSize)
    const statements = batch.flatMap((ecosystemPackage) => {
      const packageRecord = createEcosystemsPackageRecord(ecosystemPackage, fetchedAt)

      return [
        createUpsertRawEcosystemsPackageStatement(ecosystemPackage, fetchedAt),
        createUpsertPackageStatement(packageRecord),
        ...createReplacePackageTagsStatements(
          packageRecord.packageKey,
          "npm",
          ecosystemPackage.npmTags
        ),
        ...createReplacePackageTagsStatements(
          packageRecord.packageKey,
          "github",
          ecosystemPackage.githubTags
        ),
      ]
    })

    await client.batch(statements, "write")

    const storedCount = Math.min(index + writeBatchSize, selectedPackages.length)
    const now = Date.now()

    if (
      now - lastWriteProgressAt >= progressIntervalMs ||
      storedCount === selectedPackages.length
    ) {
      options.onProgress?.(
        `Stored ${storedCount}/${selectedPackages.length} ecosyste.ms packages.`
      )
      lastWriteProgressAt = now
    }
  }

  return {
    syncedCount: selectedPackages.length,
  }
}

export async function pruneEcosystemsPackages(
  client: CatalogDatabaseClient,
  options: PruneEcosystemsPackagesOptions = {}
) {
  const result = await client.execute(`
    SELECT p.package_key, rep.raw_json
    FROM packages p
    JOIN raw_ecosystems_packages rep ON rep.package_key = p.package_key
    WHERE p.source_type = 'npm'
  `)

  const packageKeysToDelete = result.rows
    .filter((row) => shouldDeleteEcosystemsPackageRow(row.raw_json, options.now))
    .map((row) => String(row.package_key))

  if (packageKeysToDelete.length === 0) {
    return { deletedCount: 0 }
  }

  for (const batch of chunkValues(packageKeysToDelete, 100)) {
    const placeholders = batch.map(() => "?").join(", ")

    await client.execute({
      sql: `DELETE FROM packages WHERE package_key IN (${placeholders})`,
      args: batch,
    })
    await client.execute({
      sql: `DELETE FROM raw_ecosystems_packages WHERE package_key IN (${placeholders})`,
      args: batch,
    })
  }

  await client.execute(`
    DELETE FROM tag_aliases
    WHERE tag_id NOT IN (SELECT DISTINCT tag_id FROM package_tags)
  `)
  await client.execute(`
    DELETE FROM tags
    WHERE tag_id NOT IN (SELECT DISTINCT tag_id FROM package_tags)
  `)

  return {
    deletedCount: packageKeysToDelete.length,
  }
}

export async function backfillLastPublishedAtFromRawEcosystems(
  client: CatalogDatabaseClient
) {
  const result = await client.execute(`
    SELECT p.package_key, p.last_published_at, rep.raw_json
    FROM packages p
    JOIN raw_ecosystems_packages rep ON rep.package_key = p.package_key
    WHERE p.source_type = 'npm'
  `)

  let updatedCount = 0

  for (const row of result.rows) {
    const nextPublishedAt = extractLastPublishedAtFromRawJson(row.raw_json)
    const currentPublishedAt = normalizeOptionalString(row.last_published_at)

    if (!nextPublishedAt || nextPublishedAt === currentPublishedAt) {
      continue
    }

    await client.execute({
      sql: `
        UPDATE packages
        SET last_published_at = ?
        WHERE package_key = ?
      `,
      args: [nextPublishedAt, row.package_key],
    })

    updatedCount += 1
  }

  return {
    packageCount: result.rows.length,
    updatedCount,
  }
}

export type SyncEcosystemsPopularOptions = {
  ecosystemsBaseUrl: string
  fromAddress: string
  onProgress?: (message: string) => void
  syncLimit: number
  updatedAfter: string
  userAgent: string
}

export type PruneEcosystemsPackagesOptions = {
  now?: Date
}

type EcosystemsPackage = {
  name: string
  description: string | undefined
  homepageUrl: string | undefined
  primaryUrl: string | undefined
  repositoryName: string | undefined
  publishedAt: Date | null
  stars: number | null
  downloads: number
  downloadsPeriod: string | null
  dependentPackagesCount: number
  npmTags: string[]
  githubTags: string[]
  rawJson: string
}

const ECOSYSTEMS_PAGE_SIZE = 10
const ECOSYSTEMS_FETCH_MAX_ATTEMPTS = 3
const ECOSYSTEMS_FETCH_RETRY_DELAY_MS = 1_000
const ECOSYSTEMS_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

function createEcosystemsRetryDelayMs(attempt: number, retryAfterHeader?: string | null) {
  return parseRetryAfterDelayMs(retryAfterHeader) ?? ECOSYSTEMS_FETCH_RETRY_DELAY_MS * attempt
}

function createEcosystemsPackageRecord(
  ecosystemPackage: EcosystemsPackage,
  fetchedAt: string
): CatalogPackageRecord {
  return {
    packageKey: createPackageKey("npm", ecosystemPackage.name),
    sourceType: "npm",
    sourceName: ecosystemPackage.name,
    displayName: ecosystemPackage.name,
    searchName: ecosystemPackage.name.trim().toLowerCase(),
    description: ecosystemPackage.description ?? null,
    homepageUrl: ecosystemPackage.homepageUrl ?? null,
    primaryUrl:
      ecosystemPackage.primaryUrl ?? createPrimaryUrl("npm", ecosystemPackage.name),
    repositoryName: ecosystemPackage.repositoryName ?? null,
    npmPackageName: ecosystemPackage.name,
    publishedAt: ecosystemPackage.publishedAt?.toISOString() ?? null,
    stars: ecosystemPackage.stars,
    downloads: ecosystemPackage.downloads,
    downloadsPeriod: ecosystemPackage.downloadsPeriod,
    dependentPackagesCount: ecosystemPackage.dependentPackagesCount,
    rawEcosystemsFetchedAt: fetchedAt,
    npmSyncedAt: null,
    githubSyncedAt: null,
    isActive: 1,
  }
}

async function fetchEcosystemsPopularPackages(options: SyncEcosystemsPopularOptions) {
  const packages: EcosystemsPackage[] = []

  for (let page = 1; packages.length < options.syncLimit; page += 1) {
    const requestUrl = new URL(
      `${stripTrailingSlash(options.ecosystemsBaseUrl)}/registries/npmjs.org/packages`
    )

    requestUrl.searchParams.set("page", String(page))
    requestUrl.searchParams.set("per_page", String(ECOSYSTEMS_PAGE_SIZE))
    requestUrl.searchParams.set("updated_after", options.updatedAfter)
    requestUrl.searchParams.set("sort", "downloads")
    requestUrl.searchParams.set("order", "desc")

    options.onProgress?.(
      `Fetching ecosyste.ms page ${page} (${ECOSYSTEMS_PAGE_SIZE} packages requested).`
    )

    const response = await fetchEcosystemsPackagesPage(requestUrl, page, options)

    const payload = await response.json()

    if (!Array.isArray(payload)) {
      throw new Error("Expected ecosyste.ms packages endpoint to return an array.")
    }

    const normalizedEntries = payload
      .map((entry) => normalizeEcosystemsPackage(entry))
      .filter((entry): entry is EcosystemsPackage => Boolean(entry))

    packages.push(...normalizedEntries)

    options.onProgress?.(
      `Fetched ecosyste.ms page ${page}; accumulated ${packages.length}/${options.syncLimit} packages.`
    )

    if (payload.length < ECOSYSTEMS_PAGE_SIZE) {
      break
    }
  }

  return packages.slice(0, options.syncLimit)
}

async function fetchEcosystemsPackagesPage(
  requestUrl: URL,
  page: number,
  options: SyncEcosystemsPopularOptions
) {
  for (let attempt = 1; attempt <= ECOSYSTEMS_FETCH_MAX_ATTEMPTS; attempt += 1) {
    let response: Response

    try {
      response = await fetch(requestUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": options.userAgent,
          From: options.fromAddress,
        },
      })
    } catch (error) {
      if (attempt < ECOSYSTEMS_FETCH_MAX_ATTEMPTS) {
        const retryDelayMs = createEcosystemsRetryDelayMs(attempt)
        const reason = error instanceof Error ? error.message : String(error)

        options.onProgress?.(
          `Retrying ecosyste.ms page ${page} after network error (attempt ${attempt + 1}/${ECOSYSTEMS_FETCH_MAX_ATTEMPTS}) in ${retryDelayMs}ms: ${reason}`
        )
        await delay(retryDelayMs)
        continue
      }

      throw error
    }

    if (response.ok) {
      return response
    }

    const details = await response.text()
    const error = new Error(
      `Failed to fetch ecosyste.ms packages from ${requestUrl.toString()}: ${response.status} ${response.statusText}\n${details}`
    )

    if (
      attempt < ECOSYSTEMS_FETCH_MAX_ATTEMPTS &&
      ECOSYSTEMS_RETRYABLE_STATUS_CODES.has(response.status)
    ) {
      const retryDelayMs = createEcosystemsRetryDelayMs(
        attempt,
        response.headers.get("Retry-After")
      )
      options.onProgress?.(
        `Retrying ecosyste.ms page ${page} after ${response.status} ${response.statusText} (attempt ${attempt + 1}/${ECOSYSTEMS_FETCH_MAX_ATTEMPTS}) in ${retryDelayMs}ms.`
      )
      await delay(retryDelayMs)
      continue
    }

    throw error
  }

  throw new Error(
    `Failed to fetch ecosyste.ms packages from ${requestUrl.toString()}: exhausted retry attempts.`
  )
}

function normalizeEcosystemsPackage(entry: unknown) {
  if (!entry || typeof entry !== "object") {
    return undefined
  }

  const candidate = entry as Record<string, unknown>
  const name = normalizeOptionalString(candidate.name)
  const latestReleasePublishedAt = normalizeTimestamp(
    candidate.latest_release_published_at
  )
  const dependentPackagesCount = normalizeInteger(
    candidate.dependent_packages_count
  )

  if (
    !name ||
    !meetsEcosystemsRetentionCriteria({
      dependentPackagesCount,
      latestReleasePublishedAt,
    })
  ) {
    return undefined
  }

  const repoMetadata =
    candidate.repo_metadata && typeof candidate.repo_metadata === "object"
      ? (candidate.repo_metadata as Record<string, unknown>)
      : undefined
  const repositoryName =
    normalizeOptionalString(repoMetadata?.full_name) ??
    extractGitHubRepositoryName(candidate.repository_url)

  return {
    name,
    description: normalizeOptionalString(candidate.description),
    homepageUrl: normalizeUrl(candidate.homepage) ?? undefined,
    primaryUrl:
      normalizeUrl(candidate.homepage) ??
      normalizeUrl(candidate.registry_url) ??
      undefined,
    repositoryName,
    publishedAt: latestReleasePublishedAt ?? null,
    stars: normalizeNullableInteger(repoMetadata?.stargazers_count),
    downloads: normalizeInteger(candidate.downloads),
    downloadsPeriod: normalizeOptionalString(candidate.downloads_period) ?? null,
    dependentPackagesCount,
    npmTags: normalizeStringArray(candidate.keywords_array),
    githubTags: normalizeStringArray(repoMetadata?.topics),
    rawJson: JSON.stringify(entry),
  }
}

function createUpsertRawEcosystemsPackageStatement(
  ecosystemPackage: EcosystemsPackage,
  fetchedAt: string
) {
  return {
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
      ON CONFLICT(package_key) DO UPDATE SET
        downloads = excluded.downloads,
        downloads_period = excluded.downloads_period,
        dependent_packages_count = excluded.dependent_packages_count,
        raw_json = excluded.raw_json,
        fetched_at = excluded.fetched_at
    `,
    args: [
      createPackageKey("npm", ecosystemPackage.name),
      "npm",
      ecosystemPackage.name,
      ecosystemPackage.downloads,
      ecosystemPackage.downloadsPeriod,
      ecosystemPackage.dependentPackagesCount,
      ecosystemPackage.rawJson,
      fetchedAt,
    ],
  }
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeStringArray(value: unknown) {
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
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function extractLastPublishedAtFromRawJson(rawJson: unknown) {
  if (typeof rawJson !== "string") {
    return undefined
  }

  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    return normalizeTimestamp(parsed.latest_release_published_at)?.toISOString()
  } catch {
    return undefined
  }
}

function isRecentRelease(value?: Date, now = new Date()) {
  if (!value) {
    return false
  }

  const cutoff = new Date(now)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)

  return value >= cutoff
}

const MIN_DEPENDENT_PACKAGES_COUNT = 500

function meetsEcosystemsRetentionCriteria(input: {
  dependentPackagesCount: number
  latestReleasePublishedAt?: Date
  now?: Date
}) {
  return (
    input.dependentPackagesCount > MIN_DEPENDENT_PACKAGES_COUNT &&
    isRecentRelease(input.latestReleasePublishedAt, input.now)
  )
}

function shouldDeleteEcosystemsPackageRow(rawJson: unknown, now = new Date()) {
  if (typeof rawJson !== "string") {
    return true
  }

  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>

    return !meetsEcosystemsRetentionCriteria({
      dependentPackagesCount: normalizeInteger(parsed.dependent_packages_count),
      latestReleasePublishedAt: normalizeTimestamp(parsed.latest_release_published_at),
      now,
    })
  } catch {
    return true
  }
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = []

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }

  return chunks
}

function delay(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}

function parseRetryAfterDelayMs(value: string | null | undefined) {
  if (!value) {
    return undefined
  }

  const trimmedValue = value.trim()

  if (!trimmedValue) {
    return undefined
  }

  const retryAfterSeconds = Number.parseInt(trimmedValue, 10)

  if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1_000
  }

  const retryAfterAt = new Date(trimmedValue)

  if (Number.isNaN(retryAfterAt.getTime())) {
    return undefined
  }

  const retryDelayMs = retryAfterAt.getTime() - Date.now()
  return retryDelayMs > 0 ? retryDelayMs : undefined
}

function normalizeInteger(value: unknown) {
  return Number.isFinite(value) ? Math.trunc(value as number) : 0
}

function normalizeNullableInteger(value: unknown) {
  return Number.isFinite(value) ? Math.trunc(value as number) : null
}

function extractGitHubRepositoryName(repository: unknown) {
  if (typeof repository === "string") {
    return parseGitHubRepositoryName(repository)
  }

  if (!repository || typeof repository !== "object") {
    return undefined
  }

  if (typeof (repository as { url?: unknown }).url === "string") {
    return parseGitHubRepositoryName((repository as { url: string }).url)
  }

  return undefined
}

function parseGitHubRepositoryName(value: string) {
  const normalizedValue = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/i, "")

  const shorthandMatch = normalizedValue.match(/^github:([^/]+\/[^/]+)$/i)

  if (shorthandMatch) {
    return shorthandMatch[1]
  }

  const urlMatch = normalizedValue.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i
  )

  if (urlMatch) {
    return urlMatch[1]
  }

  const gitProtocolMatch = normalizedValue.match(
    /^git:\/\/github\.com\/([^/]+\/[^/]+)$/i
  )

  if (gitProtocolMatch) {
    return gitProtocolMatch[1]
  }

  const sshMatch = normalizedValue.match(/^git@github\.com:([^/]+\/[^/]+)$/i)

  if (sshMatch) {
    return sshMatch[1]
  }

  return undefined
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}
