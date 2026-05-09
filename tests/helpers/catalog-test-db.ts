import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createClient } from "@libsql/client"

import type { CatalogDatabaseClient } from "../../server/catalog/database"
import {
  createPackageUrl,
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
    packageName: string
    packageTags?: string[]
    repositoryTags?: string[]
  }
) {
  const record: CatalogPackageRecord = {
    packageName: input.packageName,
    repositoryUrl: input.repositoryUrl ?? null,
    packageUrl: input.packageUrl ?? createPackageUrl(input.packageName),
    packageDescription: input.packageDescription ?? null,
    homepageUrl: input.homepageUrl ?? null,
    repositoryStars: input.repositoryStars ?? null,
    packageDownloads: input.packageDownloads ?? 0,
    packageDownloadsPeriod: input.packageDownloadsPeriod ?? "last-month",
    packageLastPublishedAt: input.packageLastPublishedAt ?? null,
    lastSyncedAt:
      input.lastSyncedAt ?? new Date("2026-01-01T00:00:00.000Z").toISOString(),
  }

  await upsertPackage(client, record)

  if (input.packageTags && input.packageTags.length > 0) {
    await replacePackageTags(
      client,
      "package_tags",
      input.packageName,
      input.packageTags
    )
  }

  if (input.repositoryTags && input.repositoryTags.length > 0) {
    await replacePackageTags(
      client,
      "repository_tags",
      input.packageName,
      input.repositoryTags
    )
  }

  return record
}

async function createTempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "scriptorium-test-"))
}
