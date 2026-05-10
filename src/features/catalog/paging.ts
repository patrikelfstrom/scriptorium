import {
  DEFAULT_CATALOG_SEARCH_LIMIT,
  encodeCatalogCursor,
} from "../../../shared/catalog"

export function getCatalogPageCursorForOffset(offset: number) {
  const normalizedOffset = normalizeRowIndex(offset)

  return normalizedOffset > 0 ? encodeCatalogCursor(normalizedOffset) : null
}

export function getCatalogPageOffsetForIndex(
  index: number,
  pageSize = DEFAULT_CATALOG_SEARCH_LIMIT
) {
  const normalizedIndex = normalizeRowIndex(index)
  const normalizedPageSize = Math.max(1, Math.trunc(pageSize))

  return Math.floor(normalizedIndex / normalizedPageSize) * normalizedPageSize
}

export function getCatalogPageOffsetsForRange(
  startIndex: number,
  endIndex: number,
  pageSize = DEFAULT_CATALOG_SEARCH_LIMIT
) {
  const normalizedPageSize = Math.max(1, Math.trunc(pageSize))
  const normalizedStartIndex = normalizeRowIndex(startIndex)
  const normalizedEndIndex = Math.max(
    normalizedStartIndex,
    normalizeRowIndex(endIndex)
  )
  const startOffset = getCatalogPageOffsetForIndex(
    normalizedStartIndex,
    normalizedPageSize
  )
  const endOffset = getCatalogPageOffsetForIndex(
    normalizedEndIndex,
    normalizedPageSize
  )
  const offsets: number[] = []

  for (
    let currentOffset = startOffset;
    currentOffset <= endOffset;
    currentOffset += normalizedPageSize
  ) {
    offsets.push(currentOffset)
  }

  return offsets
}

function normalizeRowIndex(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.trunc(value))
}
