import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Response } from 'express'
import { listPagination, pageResult, PaginationError } from '../api/list-pagination.js'

test('pagination rejects malformed cursors and oversized or fractional limits', () => {
  assert.deepEqual(listPagination({}, 200), { limit: 200, offset: 0 })
  assert.deepEqual(listPagination({ cursor: '200', limit: '10' }, 200), { limit: 10, offset: 200 })
  for (const query of [{ cursor: '-1' }, { cursor: 'nope' }, { limit: '201' }, { limit: '1.5' }, { limit: '0' }]) {
    assert.throws(() => listPagination(query, 200), PaginationError)
  }
})

test('lookahead distinguishes an exact full last page from truncation and exposes headers', () => {
  const headers = new Map<string, string>()
  const res = { setHeader: (key: string, value: string) => headers.set(key, value) } as unknown as Response
  assert.deepEqual(pageResult(res, [1, 2], { limit: 2, offset: 0 }), { items: [1, 2], hasMore: false, nextCursor: null })
  assert.deepEqual(pageResult(res, [1, 2, 3], { limit: 2, offset: 2 }), { items: [1, 2], hasMore: true, nextCursor: '4' })
  assert.equal(headers.get('X-Has-More'), 'true')
  assert.equal(headers.get('X-Next-Cursor'), '4')
})
