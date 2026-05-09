import type { EcosystemsPackage } from "./ecosystems-types"

const MIN_DEPENDENT_PACKAGES_COUNT = 500

export function normalizeEcosystemsPackage(entry: unknown) {
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
    downloadsPeriod:
      normalizeOptionalString(candidate.downloads_period) ?? null,
    dependentPackagesCount,
    npmTags: normalizeStringArray(candidate.keywords_array),
    githubTags: normalizeStringArray(repoMetadata?.topics),
    rawJson: JSON.stringify(entry),
  } satisfies EcosystemsPackage
}

export function extractLastPublishedAtFromRawJson(rawJson: unknown) {
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

export function shouldDeleteEcosystemsPackageRow(
  rawJson: unknown,
  now = new Date()
) {
  if (typeof rawJson !== "string") {
    return true
  }

  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>

    return !meetsEcosystemsRetentionCriteria({
      dependentPackagesCount: normalizeInteger(parsed.dependent_packages_count),
      latestReleasePublishedAt: normalizeTimestamp(
        parsed.latest_release_published_at
      ),
      now,
    })
  } catch {
    return true
  }
}

export function normalizeOptionalString(value: unknown) {
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

function isRecentRelease(value?: Date, now = new Date()) {
  if (!value) {
    return false
  }

  const cutoff = new Date(now)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)

  return value >= cutoff
}

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
