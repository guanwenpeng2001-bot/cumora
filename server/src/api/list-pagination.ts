import type { Request, Response } from 'express'

export class PaginationError extends Error { readonly status = 400 }

/** Offset cursors are opaque to clients. Ordering always includes a unique
 * tie breaker. Lists are live: callers should deduplicate by id on refresh. */
export function listPagination(query: Request['query'], defaultLimit: number): { limit: number; offset: number } {
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit)
  const cursor = query.cursor === undefined ? '0' : query.cursor
  if (typeof cursor !== 'string' || !/^\d{1,9}$/.test(cursor)
    || !Number.isInteger(limit) || limit < 1 || limit > defaultLimit) {
    throw new PaginationError('invalid pagination: use a decimal cursor and a positive limit within the endpoint maximum')
  }
  return { limit, offset: Number(cursor) }
}

export function pageResult<T>(res: Response, rows: T[], page: { limit: number; offset: number }): {
  items: T[]; hasMore: boolean; nextCursor: string | null;
} {
  const hasMore = rows.length > page.limit
  const nextCursor = hasMore ? String(page.offset + page.limit) : null
  res.setHeader('X-Has-More', String(hasMore))
  res.setHeader('X-Next-Cursor', nextCursor ?? '')
  res.setHeader('Access-Control-Expose-Headers', 'X-Has-More, X-Next-Cursor')
  return { items: rows.slice(0, page.limit), hasMore, nextCursor }
}
