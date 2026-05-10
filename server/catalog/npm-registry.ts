export function resolveLatestVersionEntry<T>(input: {
  latestVersionTag?: string | null
  versions?: Record<string, T | undefined>
}) {
  const latestVersionTag = normalizeOptionalString(input.latestVersionTag)

  if (!latestVersionTag) {
    return {
      latestVersionTag: undefined,
      latestVersion: undefined,
    }
  }

  const candidateTags = createVersionTagCandidates(latestVersionTag)

  for (const candidateTag of candidateTags) {
    const candidateVersion = input.versions?.[candidateTag]

    if (candidateVersion) {
      return {
        latestVersionTag: candidateTag,
        latestVersion: candidateVersion,
      }
    }
  }

  return {
    latestVersionTag,
    latestVersion: undefined,
  }
}

export function resolveLatestPublishedAt(input: {
  latestVersionTag?: string | null
  time?: Record<string, unknown>
}) {
  const latestVersionTag = normalizeOptionalString(input.latestVersionTag)

  if (!latestVersionTag) {
    return null
  }

  for (const candidateTag of createVersionTagCandidates(latestVersionTag)) {
    const value = input.time?.[candidateTag]

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function createVersionTagCandidates(versionTag: string) {
  const candidates = [versionTag]

  if (/^v\d/i.test(versionTag)) {
    candidates.push(versionTag.slice(1))
  }

  return candidates
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
