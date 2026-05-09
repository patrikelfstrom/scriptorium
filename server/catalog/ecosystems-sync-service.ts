import PQueue from "p-queue"
import pRetry, { AbortError } from "p-retry"

import type { CatalogDatabaseClient } from "./database"
import { normalizeEcosystemsPackage } from "./ecosystems-normalization"
import {
  createEcosystemsPackageRecord,
  createUpsertRawEcosystemsPackageStatement,
} from "./ecosystems-storage"
import type {
  EcosystemsPackage,
  SyncEcosystemsPopularOptions,
} from "./ecosystems-types"
import {
  createReplacePackageTagsStatements,
  createUpsertPackageStatement,
} from "./package-store"

const DEFAULT_ECOSYSTEMS_PAGE_SIZE = 50
const ECOSYSTEMS_FETCH_MAX_ATTEMPTS = 3
const ECOSYSTEMS_FETCH_RETRY_DELAY_MS = 1_000
const ECOSYSTEMS_INTERNAL_SERVER_ERROR_DELAY_MS = [10_000, 20_000] as const
const ECOSYSTEMS_INTERNAL_SERVER_ERROR_STATUS = 500
const ECOSYSTEMS_RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504])
const ECOSYSTEMS_RATE_LIMIT_LOW_REMAINING_THRESHOLD = 10
const ECOSYSTEMS_RATE_LIMIT_RESET_WAIT_THRESHOLD = 3

type FetchEcosystemsPackagesPageMode = "defer-500" | "fail-500"

type ScheduledEcosystemsPageTaskMode = "initial" | "deferred" | "final-pass"

type FetchEcosystemsPackagesPageResponse =
  | {
      kind: "response"
      response: Response
    }
  | {
      kind: "retry-after-delay"
      delayMs: number
      internalServerErrorCount: number
    }
  | {
      kind: "retry-after-sweep"
      internalServerErrorCount: number
    }

type FetchAndNormalizeEcosystemsPackagesPageResult =
  | {
      kind: "success"
      normalizedEntries: EcosystemsPackage[]
      payloadLength: number
    }
  | {
      kind: "retry-after-delay"
      delayMs: number
      internalServerErrorCount: number
    }
  | {
      kind: "retry-after-sweep"
      internalServerErrorCount: number
    }

type ScheduledEcosystemsPageTask = {
  page: number
  mode: ScheduledEcosystemsPageTaskMode
  internalServerErrorCount: number
}

type EcosystemsRateLimitStatus = {
  limit: number | undefined
  remaining: number | undefined
  resetAtMs: number | undefined
  tier: string | undefined
}

class RetryableEcosystemsFetchError extends Error {
  readonly retryAfterHeader: string | null | undefined
  readonly status: number | undefined
  readonly reason: string

  constructor(
    message: string,
    options: {
      retryAfterHeader?: string | null
      status?: number
      reason: string
      cause?: unknown
    }
  ) {
    super(message, { cause: options.cause })
    this.name = "RetryableEcosystemsFetchError"
    this.retryAfterHeader = options.retryAfterHeader
    this.status = options.status
    this.reason = options.reason
  }
}

class DeferredEcosystemsInternalServerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeferredEcosystemsInternalServerError"
  }
}

export async function syncEcosystemsPopular(
  client: CatalogDatabaseClient,
  options: SyncEcosystemsPopularOptions
) {
  const fetchedAt = new Date().toISOString()
  const writeBatchSize = 25
  const progressIntervalMs = 60_000
  let lastWriteProgressAt = Date.now()
  let storedCount = 0

  options.onProgress?.(
    `Fetching ecosyste.ms npm packages for up to ${options.syncLimit} packages.`
  )

  await fetchEcosystemsPopularPackages(options, async (pagePackages) => {
    const remainingCapacity = options.syncLimit - storedCount

    if (remainingCapacity <= 0) {
      return
    }

    const packagesToStore = pagePackages.slice(0, remainingCapacity)

    for (
      let index = 0;
      index < packagesToStore.length;
      index += writeBatchSize
    ) {
      const batch = packagesToStore.slice(index, index + writeBatchSize)
      const statements = batch.flatMap((ecosystemPackage) => {
        const packageRecord = createEcosystemsPackageRecord(
          ecosystemPackage,
          fetchedAt
        )

        return [
          createUpsertRawEcosystemsPackageStatement(
            ecosystemPackage,
            fetchedAt
          ),
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
    }

    storedCount += packagesToStore.length

    const now = Date.now()

    if (
      now - lastWriteProgressAt >= progressIntervalMs ||
      storedCount === options.syncLimit
    ) {
      options.onProgress?.(
        `Stored ${storedCount}/${options.syncLimit} ecosyste.ms packages.`
      )
      lastWriteProgressAt = now
    }
  })

  options.onProgress?.(`Stored ${storedCount} ecosyste.ms packages total.`)

  return {
    syncedCount: storedCount,
  }
}

async function fetchEcosystemsPopularPackages(
  options: SyncEcosystemsPopularOptions,
  onPageFetched?: (
    pagePackages: EcosystemsPackage[],
    page: number
  ) => Promise<void> | void
) {
  const queue = new PQueue({ concurrency: 1 })
  const pageSize = getEcosystemsPageSize(options)
  const packagesByPage = new Map<number, EcosystemsPackage[]>()
  const retryAfterSweepPages = new Set<number>()
  const scheduledOperations = new Set<Promise<void>>()
  let nextAllowedRequestAtMs = 0
  let accumulatedCount = 0
  let nextPage = 1
  let finalPage: number | null = null
  const maxPageCount = Math.max(1, options.syncLimit)
  let pendingInitialTasks = 0
  let pendingNonFinalPassTasks = 0
  let finalPassScheduled = false
  let firstError: unknown

  const storePackages = async (
    page: number,
    pagePackages: EcosystemsPackage[],
    fetchDurationMs: number
  ) => {
    const previousCount = packagesByPage.get(page)?.length ?? 0

    packagesByPage.set(page, pagePackages)
    accumulatedCount += pagePackages.length - previousCount
    retryAfterSweepPages.delete(page)

    options.onProgress?.(
      `Fetched ecosyste.ms page ${page} in ${fetchDurationMs}ms; accumulated ${accumulatedCount}/${options.syncLimit} packages.`
    )

    await onPageFetched?.(pagePackages, page)
  }

  const maybeScheduleNextInitialPage = () => {
    if (firstError) {
      return
    }

    if (
      !shouldFetchAnotherEcosystemsPage(
        accumulatedCount,
        options.syncLimit,
        finalPage,
        nextPage,
        maxPageCount
      )
    ) {
      return
    }

    schedulePage({
      page: nextPage,
      mode: "initial",
      internalServerErrorCount: 0,
    })
    nextPage += 1
  }

  const isInitialSweepComplete = () => {
    return (
      pendingInitialTasks === 0 &&
      !shouldFetchAnotherEcosystemsPage(
        accumulatedCount,
        options.syncLimit,
        finalPage,
        nextPage,
        maxPageCount
      )
    )
  }

  const maybeScheduleFinalPass = () => {
    if (
      firstError ||
      finalPassScheduled ||
      pendingNonFinalPassTasks > 0 ||
      !isInitialSweepComplete() ||
      retryAfterSweepPages.size === 0
    ) {
      return
    }

    finalPassScheduled = true

    for (const page of Array.from(retryAfterSweepPages).sort(
      (left, right) => left - right
    )) {
      options.onProgress?.(
        `Retrying deferred ecosyste.ms page ${page} after other pages finished.`
      )
      schedulePage({ page, mode: "final-pass", internalServerErrorCount: 0 })
    }

    retryAfterSweepPages.clear()
  }

  const schedulePage = (task: ScheduledEcosystemsPageTask, delayMs = 0) => {
    if (firstError) {
      return
    }

    if (task.mode === "initial") {
      pendingInitialTasks += 1
    }

    if (task.mode !== "final-pass") {
      pendingNonFinalPassTasks += 1
    }

    const operation = (async () => {
      if (delayMs > 0) {
        await delay(delayMs)
      }

      if (firstError) {
        return
      }

      await queue.add(async () => {
        const rateLimitDelayMs = nextAllowedRequestAtMs - Date.now()

        if (rateLimitDelayMs > 0) {
          options.onProgress?.(
            `Waiting ${rateLimitDelayMs}ms for ecosyste.ms rate limit recovery before requesting page ${task.page}.`
          )
          await delay(rateLimitDelayMs)
        }

        options.onProgress?.(
          `Fetching ecosyste.ms page ${task.page} (${pageSize} packages requested).`
        )
        const fetchStartedAt = Date.now()

        const result = await fetchAndNormalizeEcosystemsPackagesPage(
          task.page,
          options,
          pageSize,
          {
            mode: task.mode === "final-pass" ? "fail-500" : "defer-500",
            internalServerErrorCount: task.internalServerErrorCount,
            onRateLimitStatus: (rateLimitStatus) => {
              options.onProgress?.(
                formatEcosystemsRateLimitStatus(rateLimitStatus)
              )

              const throttleDelayMs =
                createEcosystemsRateLimitThrottleDelayMs(rateLimitStatus)

              if (throttleDelayMs === undefined) {
                nextAllowedRequestAtMs = 0
                return
              }

              nextAllowedRequestAtMs = Date.now() + throttleDelayMs
            },
          }
        )

        if (result.kind === "success") {
          await storePackages(
            task.page,
            result.normalizedEntries,
            Date.now() - fetchStartedAt
          )

          if (result.payloadLength < pageSize) {
            finalPage =
              finalPage === null ? task.page : Math.min(finalPage, task.page)
          }

          return
        }

        if (result.kind === "retry-after-delay") {
          options.onProgress?.(
            `Retrying deferred ecosyste.ms page ${task.page}.`
          )
          schedulePage(
            {
              page: task.page,
              mode: "deferred",
              internalServerErrorCount: result.internalServerErrorCount,
            },
            result.delayMs
          )
          return
        }

        retryAfterSweepPages.add(task.page)
      })
    })()
      .catch((error) => {
        if (!firstError) {
          firstError = unwrapEcosystemsFetchError(error)
        }
        queue.pause()
      })
      .finally(() => {
        scheduledOperations.delete(operation)

        if (task.mode === "initial") {
          pendingInitialTasks -= 1
          maybeScheduleNextInitialPage()
        }

        if (task.mode !== "final-pass") {
          pendingNonFinalPassTasks -= 1
        }

        maybeScheduleFinalPass()
      })

    scheduledOperations.add(operation)
  }

  maybeScheduleNextInitialPage()

  while (scheduledOperations.size > 0) {
    await Promise.allSettled(Array.from(scheduledOperations))

    if (firstError) {
      throw firstError
    }

    maybeScheduleFinalPass()
  }

  return Array.from(packagesByPage.entries())
    .sort(([leftPage], [rightPage]) => leftPage - rightPage)
    .flatMap(([, pagePackages]) => pagePackages)
    .slice(0, options.syncLimit)
}

async function fetchAndNormalizeEcosystemsPackagesPage(
  page: number,
  options: SyncEcosystemsPopularOptions,
  pageSize: number,
  requestBehavior: {
    mode: FetchEcosystemsPackagesPageMode
    internalServerErrorCount: number
    onRateLimitStatus?: (rateLimitStatus: EcosystemsRateLimitStatus) => void
  }
): Promise<FetchAndNormalizeEcosystemsPackagesPageResult> {
  const requestUrl = createEcosystemsPackagesRequestUrl(options, page, pageSize)
  const result = await fetchEcosystemsPackagesPage(
    requestUrl,
    page,
    options,
    requestBehavior
  )

  if (result.kind !== "response") {
    return result
  }

  const payload = await result.response.json()

  if (!Array.isArray(payload)) {
    throw new Error(
      "Expected ecosyste.ms packages endpoint to return an array."
    )
  }

  return {
    kind: "success",
    normalizedEntries: payload
      .map((entry) => normalizeEcosystemsPackage(entry))
      .filter((entry): entry is EcosystemsPackage => Boolean(entry)),
    payloadLength: payload.length,
  }
}

async function fetchEcosystemsPackagesPage(
  requestUrl: URL,
  page: number,
  options: SyncEcosystemsPopularOptions,
  requestBehavior: {
    mode: FetchEcosystemsPackagesPageMode
    internalServerErrorCount: number
    onRateLimitStatus?: (rateLimitStatus: EcosystemsRateLimitStatus) => void
  }
): Promise<FetchEcosystemsPackagesPageResponse> {
  try {
    const response = await pRetry(
      async () => {
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
          throw createRetryableEcosystemsNetworkError(requestUrl, error)
        }

        const rateLimitStatus = parseEcosystemsRateLimitStatus(response.headers)

        if (rateLimitStatus) {
          requestBehavior.onRateLimitStatus?.(rateLimitStatus)
        }

        if (response.ok) {
          return response
        }

        const details = await response.text()

        if (response.status === ECOSYSTEMS_INTERNAL_SERVER_ERROR_STATUS) {
          if (requestBehavior.mode === "defer-500") {
            throw new DeferredEcosystemsInternalServerError(
              createEcosystemsFetchFailureMessage(
                requestUrl,
                response.status,
                response.statusText,
                details
              )
            )
          }

          throw new AbortError(
            new Error(
              createEcosystemsFetchFailureMessage(
                requestUrl,
                response.status,
                response.statusText,
                details
              )
            )
          )
        }

        const fetchError = createRetryableEcosystemsResponseError(
          requestUrl,
          response,
          details
        )

        if (ECOSYSTEMS_RETRYABLE_STATUS_CODES.has(response.status)) {
          throw fetchError
        }

        throw new AbortError(new Error(fetchError.message))
      },
      {
        retries: ECOSYSTEMS_FETCH_MAX_ATTEMPTS - 1,
        factor: 1,
        minTimeout: 0,
        randomize: false,
        shouldRetry: ({ error }) =>
          error instanceof RetryableEcosystemsFetchError,
        onFailedAttempt: async ({ error, attemptNumber }) => {
          if (!(error instanceof RetryableEcosystemsFetchError)) {
            return
          }

          const retryDelayMs = createEcosystemsRetryDelayMs(
            attemptNumber,
            error.retryAfterHeader
          )

          options.onProgress?.(
            createEcosystemsRetryMessage(
              page,
              attemptNumber,
              retryDelayMs,
              error
            )
          )
          await delay(retryDelayMs)
        },
      }
    )

    return {
      kind: "response",
      response,
    }
  } catch (error) {
    if (error instanceof DeferredEcosystemsInternalServerError) {
      const internalServerErrorCount =
        requestBehavior.internalServerErrorCount + 1
      const retryDelayMs =
        ECOSYSTEMS_INTERNAL_SERVER_ERROR_DELAY_MS[internalServerErrorCount - 1]

      if (retryDelayMs !== undefined) {
        options.onProgress?.(
          `Delaying ecosyste.ms page ${page} after 500 Internal Server Error for ${retryDelayMs}ms while continuing with other pages.`
        )

        return {
          kind: "retry-after-delay",
          delayMs: retryDelayMs,
          internalServerErrorCount,
        }
      }

      options.onProgress?.(
        `Skipping ecosyste.ms page ${page} after a third 500 Internal Server Error. It will retry after the remaining pages finish.`
      )

      return {
        kind: "retry-after-sweep",
        internalServerErrorCount,
      }
    }

    throw unwrapEcosystemsFetchError(error)
  }
}

function createEcosystemsPackagesRequestUrl(
  options: SyncEcosystemsPopularOptions,
  page: number,
  pageSize: number
) {
  const requestUrl = new URL(
    `${stripTrailingSlash(options.ecosystemsBaseUrl)}/registries/npmjs.org/packages`
  )

  requestUrl.searchParams.set("page", String(page))
  requestUrl.searchParams.set("per_page", String(pageSize))
  requestUrl.searchParams.set("updated_after", options.updatedAfter)
  requestUrl.searchParams.set("mailto", options.fromAddress)
  requestUrl.searchParams.set("sort", "downloads")
  requestUrl.searchParams.set("order", "desc")

  return requestUrl
}

function getEcosystemsPageSize(options: SyncEcosystemsPopularOptions) {
  return options.pageSize ?? DEFAULT_ECOSYSTEMS_PAGE_SIZE
}

function shouldFetchAnotherEcosystemsPage(
  accumulatedCount: number,
  syncLimit: number,
  finalPage: number | null,
  nextPage: number,
  maxPageCount: number
) {
  if (nextPage > maxPageCount) {
    return false
  }

  if (finalPage !== null) {
    return nextPage <= finalPage
  }

  return accumulatedCount < syncLimit
}

function createEcosystemsRetryDelayMs(
  attempt: number,
  retryAfterHeader?: string | null
) {
  return (
    parseRetryAfterDelayMs(retryAfterHeader) ??
    ECOSYSTEMS_FETCH_RETRY_DELAY_MS * attempt
  )
}

function parseEcosystemsRateLimitStatus(
  headers: Headers
): EcosystemsRateLimitStatus | undefined {
  const tier = normalizeOptionalHeaderValue(headers.get("x-ratelimit-tier"))
  const limit = parseRateLimitInteger(headers.get("x-ratelimit-limit"))
  const remaining = parseRateLimitInteger(headers.get("x-ratelimit-remaining"))
  const resetAtSeconds = parseRateLimitInteger(headers.get("x-ratelimit-reset"))
  const resetAtMs =
    resetAtSeconds === undefined ? undefined : resetAtSeconds * 1_000

  if (
    tier === undefined &&
    limit === undefined &&
    remaining === undefined &&
    resetAtMs === undefined
  ) {
    return undefined
  }

  return {
    tier,
    limit,
    remaining,
    resetAtMs,
  }
}

function createEcosystemsRateLimitThrottleDelayMs(
  rateLimitStatus: EcosystemsRateLimitStatus
) {
  if (
    rateLimitStatus.remaining === undefined ||
    rateLimitStatus.resetAtMs === undefined ||
    rateLimitStatus.remaining > ECOSYSTEMS_RATE_LIMIT_LOW_REMAINING_THRESHOLD
  ) {
    return undefined
  }

  const resetDelayMs = rateLimitStatus.resetAtMs - Date.now()

  if (resetDelayMs <= 0) {
    return undefined
  }

  if (rateLimitStatus.remaining <= ECOSYSTEMS_RATE_LIMIT_RESET_WAIT_THRESHOLD) {
    return resetDelayMs
  }

  return Math.ceil(resetDelayMs / rateLimitStatus.remaining)
}

function formatEcosystemsRateLimitStatus(
  rateLimitStatus: EcosystemsRateLimitStatus
) {
  const tierLabel = rateLimitStatus.tier ?? "unknown"
  const remainingLabel =
    rateLimitStatus.remaining === undefined
      ? "unknown"
      : String(rateLimitStatus.remaining)
  const limitLabel =
    rateLimitStatus.limit === undefined
      ? "unknown"
      : String(rateLimitStatus.limit)
  const resetDelayMs =
    rateLimitStatus.resetAtMs === undefined
      ? undefined
      : Math.max(rateLimitStatus.resetAtMs - Date.now(), 0)

  if (resetDelayMs === undefined) {
    return `ecosyste.ms rate limit: tier ${tierLabel}, remaining ${remainingLabel}/${limitLabel}.`
  }

  return `ecosyste.ms rate limit: tier ${tierLabel}, remaining ${remainingLabel}/${limitLabel}, resets in ${resetDelayMs}ms.`
}

function createRetryableEcosystemsNetworkError(
  requestUrl: URL,
  error: unknown
) {
  const reason = error instanceof Error ? error.message : String(error)

  return new RetryableEcosystemsFetchError(
    `Failed to fetch ecosyste.ms packages from ${requestUrl.toString()}: ${reason}`,
    {
      cause: error,
      reason,
    }
  )
}

function createRetryableEcosystemsResponseError(
  requestUrl: URL,
  response: Response,
  details: string
) {
  return new RetryableEcosystemsFetchError(
    createEcosystemsFetchFailureMessage(
      requestUrl,
      response.status,
      response.statusText,
      details
    ),
    {
      retryAfterHeader: response.headers.get("Retry-After"),
      status: response.status,
      reason: `${response.status} ${response.statusText}`,
    }
  )
}

function createEcosystemsFetchFailureMessage(
  requestUrl: URL,
  status: number,
  statusText: string,
  details: string
) {
  return `Failed to fetch ecosyste.ms packages from ${requestUrl.toString()}: ${status} ${statusText}\n${details}`
}

function createEcosystemsRetryMessage(
  page: number,
  attemptNumber: number,
  retryDelayMs: number,
  error: RetryableEcosystemsFetchError
) {
  if (error.status === undefined) {
    return `Retrying ecosyste.ms page ${page} after network error (attempt ${attemptNumber + 1}/${ECOSYSTEMS_FETCH_MAX_ATTEMPTS}) in ${retryDelayMs}ms: ${error.reason}`
  }

  return `Retrying ecosyste.ms page ${page} after ${error.reason} (attempt ${attemptNumber + 1}/${ECOSYSTEMS_FETCH_MAX_ATTEMPTS}) in ${retryDelayMs}ms.`
}

function unwrapEcosystemsFetchError(error: unknown) {
  if (error instanceof AbortError) {
    return error.originalError
  }

  if (
    error instanceof RetryableEcosystemsFetchError &&
    error.cause instanceof Error
  ) {
    return error.cause
  }

  return error
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

function parseRateLimitInteger(value: string | null | undefined) {
  if (!value) {
    return undefined
  }

  const parsedValue = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsedValue) ? parsedValue : undefined
}

function normalizeOptionalHeaderValue(value: string | null | undefined) {
  if (!value) {
    return undefined
  }

  const trimmedValue = value.trim()
  return trimmedValue.length > 0 ? trimmedValue : undefined
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}
