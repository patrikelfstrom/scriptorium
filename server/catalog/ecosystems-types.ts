export type SyncEcosystemsPopularOptions = {
  ecosystemsBaseUrl: string
  fromAddress: string
  onProgress?: (message: string) => void
  pageSize?: number
  syncLimit: number
  updatedAfter: string
  userAgent: string
}

export type PruneEcosystemsPackagesOptions = {
  now?: Date
}

export type EcosystemsPackage = {
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
