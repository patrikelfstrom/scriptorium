import {
  createPackageKey,
  createPrimaryUrl,
  type CatalogPackageRecord,
} from "./package-store"
import type { EcosystemsPackage } from "./ecosystems-types"

export function createEcosystemsPackageRecord(
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
      ecosystemPackage.primaryUrl ??
      createPrimaryUrl("npm", ecosystemPackage.name),
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

export function createUpsertRawEcosystemsPackageStatement(
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
