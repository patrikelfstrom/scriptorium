const SECURITY_HOLDER_DESCRIPTION = "security holding package"
const SECURITY_HOLDER_REPOSITORY_URL = "https://github.com/npm/security-holder"
const SECURITY_HOLDER_HOMEPAGE_URL =
  "https://github.com/npm/security-holder#readme"
const SECURITY_HOLDER_VERSION_PATTERN = /(?:^|[.-])security(?:[.-]\d+)*$/i
const UNPUBLISHED_DESCRIPTION = "unpublished package"
const UNPUBLISHED_REPOSITORY_URL = "https://registry.npmjs.org/-/unpublished"

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
  `
}

export function createUnpublishedPackageMarker() {
  return {
    packageDescription: "Unpublished package",
    homepageUrl: null,
    repositoryUrl: UNPUBLISHED_REPOSITORY_URL,
  }
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : undefined
}
