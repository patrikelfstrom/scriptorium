import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createClient } from "@libsql/client"

import type { CatalogDatabaseClient } from "../../server/catalog/database"
import {
  createPackageKey,
  createPrimaryUrl,
  replacePackageTags,
  upsertPackage,
  type CatalogPackageRecord,
} from "../../server/catalog/package-store"
import { ensureCatalogSchema } from "../../server/catalog/schema"

export async function createTestCatalogDatabase() {
  const tempDirectory = await createTempDirectory()
  const url = `file:${path.join(tempDirectory, "scriptorium-test.db")}`
  const client = createClient({ url })

  await ensureCatalogSchema(client)

  return {
    client,
    url,
    async cleanup() {
      client.close?.()
      await rm(tempDirectory, { recursive: true, force: true })
    },
  }
}

export async function seedCatalogPackage(
  client: CatalogDatabaseClient,
  input: Partial<CatalogPackageRecord> & {
    packageKey?: string
    sourceType: string
    sourceName: string
    displayName?: string
    tags?: string[]
    tagSource?: string
  }
) {
  const packageKey =
    input.packageKey ?? createPackageKey(input.sourceType, input.sourceName)
  const record: CatalogPackageRecord = {
    packageKey,
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    displayName: input.displayName ?? input.sourceName,
    searchName: (input.displayName ?? input.sourceName).trim().toLowerCase(),
    description: input.description ?? null,
    homepageUrl: input.homepageUrl ?? null,
    primaryUrl:
      input.primaryUrl ?? createPrimaryUrl(input.sourceType, input.sourceName),
    repositoryName: input.repositoryName ?? null,
    npmPackageName: input.npmPackageName ?? null,
    publishedAt: input.publishedAt ?? null,
    stars: input.stars ?? null,
    downloads: input.downloads ?? 0,
    downloadsPeriod: input.downloadsPeriod ?? null,
    dependentPackagesCount: input.dependentPackagesCount ?? 0,
    rawEcosystemsFetchedAt:
      input.rawEcosystemsFetchedAt ??
      new Date("2026-01-01T00:00:00.000Z").toISOString(),
    npmSyncedAt: input.npmSyncedAt ?? null,
    githubSyncedAt: input.githubSyncedAt ?? null,
    isActive: input.isActive ?? 1,
  }

  await upsertPackage(client, record)

  if (input.tags && input.tags.length > 0) {
    await replacePackageTags(
      client,
      packageKey,
      input.tagSource ?? "seed",
      input.tags
    )
  }

  return record
}

async function createTempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "scriptorium-test-"))
}
