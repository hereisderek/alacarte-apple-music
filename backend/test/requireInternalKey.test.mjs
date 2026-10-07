import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.INTERNAL_API_KEY = 'test-key-123'
const { requireInternalKey } = await import('../lib/requireInternalKey.mjs')

function mockRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    res.body = body
    return res
  }
  return res
}

test('requireInternalKey allows a matching X-Internal-Key header', () => {
  const req = { headers: { 'x-internal-key': 'test-key-123' } }
  const res = mockRes()
  let calledNext = false
  requireInternalKey()(req, res, () => {
    calledNext = true
  })
  assert.equal(calledNext, true)
  assert.equal(res.statusCode, null)
})

test('requireInternalKey rejects a missing or wrong header', () => {
  const res = mockRes()
  let calledNext = false
  requireInternalKey()({ headers: {} }, res, () => {
    calledNext = true
  })
  assert.equal(calledNext, false)
  assert.equal(res.statusCode, 401)

  const res2 = mockRes()
  requireInternalKey()(
    { headers: { 'x-internal-key': 'wrong' } },
    res2,
    () => {
      calledNext = true
    },
  )
  assert.equal(res2.statusCode, 401)
})
