const SECURITY_HOLDER_DESCRIPTION = "security holding package"
const SECURITY_HOLDER_REPOSITORY_URL = "https://github.com/npm/security-holder"
const SECURITY_HOLDER_HOMEPAGE_URL =
  "https://github.com/npm/security-holder#readme"
const SECURITY_HOLDER_VERSION_PATTERN = /(?:^|[.-])security(?:[.-]\d+)*$/i
const UNPUBLISHED_DESCRIPTION = "unpublished package"
const UNPUBLISHED_REPOSITORY_URL = "https://registry.npmjs.org/-/unpublished"
const NPM_VIEW_UNRESOLVABLE_DESCRIPTION = "unresolvable package"
const NPM_VIEW_UNRESOLVABLE_REPOSITORY_URL =
  "https://registry.npmjs.org/-/unresolvable-via-npm-view"

export function isSecurityHoldingPackage(input: {
  latestVersionTag?: string | null
  packageDescription?: string | null
  repositoryUrl?: string | null
  homepageUrl?: string | null
}) {
  const latestVersionTag = normalizeOptionalString(input.latestVersionTag)

  if (
    !latestVersionTag ||
    !SECURITY_HOLDER_VERSION_PATTERN.test(latestVersionTag)
  ) {
    return false
  }

  const packageDescription = normalizeOptionalString(input.packageDescription)
  const repositoryUrl = normalizeOptionalString(input.repositoryUrl)
  const homepageUrl = normalizeOptionalString(input.homepageUrl)

  return (
    packageDescription === SECURITY_HOLDER_DESCRIPTION ||
    repositoryUrl === SECURITY_HOLDER_REPOSITORY_URL ||
    homepageUrl === SECURITY_HOLDER_HOMEPAGE_URL
  )
}

export function createVisiblePackageSql(alias: string) {
  return `NOT (${createRemovedPackageSql(alias)})`
}

export function createRemovedPackageSql(alias: string) {
  return `
    (
      ${alias}.repository_url = '${SECURITY_HOLDER_REPOSITORY_URL}'
      AND LOWER(COALESCE(${alias}.package_description, '')) = '${SECURITY_HOLDER_DESCRIPTION}'
    )
    OR (
      ${alias}.repository_url = '${UNPUBLISHED_REPOSITORY_URL}'
      AND LOWER(COALESCE(${alias}.package_description, '')) = '${UNPUBLISHED_DESCRIPTION}'
    )
    OR (
      ${alias}.repository_url = '${NPM_VIEW_UNRESOLVABLE_REPOSITORY_URL}'
      AND LOWER(COALESCE(${alias}.package_description, '')) = '${NPM_VIEW_UNRESOLVABLE_DESCRIPTION}'
    )
  `
}

export function createUnpublishedPackageMarker() {
  return {
    packageDescription: "Unpublished package",
    homepageUrl: null,
    repositoryUrl: UNPUBLISHED_REPOSITORY_URL,
  }
}

export function createNpmViewUnresolvablePackageMarker() {
  return {
    packageDescription: "Unresolvable package",
    homepageUrl: null,
    repositoryUrl: NPM_VIEW_UNRESOLVABLE_REPOSITORY_URL,
  }
}

export function hasRemovedPackageMarker(input: {
  packageDescription?: string | null
  repositoryUrl?: string | null
  homepageUrl?: string | null
}) {
  const packageDescription = normalizeOptionalString(input.packageDescription)
  const repositoryUrl = normalizeOptionalString(input.repositoryUrl)
  const homepageUrl = normalizeOptionalString(input.homepageUrl)

  return (
    (repositoryUrl === SECURITY_HOLDER_REPOSITORY_URL &&
      packageDescription === SECURITY_HOLDER_DESCRIPTION) ||
    (repositoryUrl === UNPUBLISHED_REPOSITORY_URL &&
      packageDescription === UNPUBLISHED_DESCRIPTION) ||
    (repositoryUrl === NPM_VIEW_UNRESOLVABLE_REPOSITORY_URL &&
      packageDescription === NPM_VIEW_UNRESOLVABLE_DESCRIPTION) ||
    repositoryUrl === SECURITY_HOLDER_REPOSITORY_URL ||
    repositoryUrl === UNPUBLISHED_REPOSITORY_URL ||
    repositoryUrl === NPM_VIEW_UNRESOLVABLE_REPOSITORY_URL ||
    homepageUrl === SECURITY_HOLDER_HOMEPAGE_URL
  )
}

export function hasUnpublishedRegistryMarker(value: unknown) {
  if (!value || typeof value !== "object") {
    return false
  }

  return (
    "time" in value &&
    Boolean((value as { time?: { unpublished?: unknown } }).time?.unpublished)
  )
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : undefined
}
