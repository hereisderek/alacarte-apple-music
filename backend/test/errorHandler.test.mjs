import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'

const { errorHandler } = await import('../lib/errorHandler.mjs')

async function request(app, opts = {}) {
  app.use(errorHandler())
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x`, opts)
    return { status: res.status, body: await res.json() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('unexpected errors are logged but not echoed to the client', async () => {
  const app = express()
  app.get('/x', () => {
    throw new Error("EACCES: permission denied, open '/config/settings.json'")
  })
  const logged = []
  const orig = console.error
  console.error = (...a) => logged.push(a.map(String).join(' '))
  try {
    const r = await request(app)
    assert.equal(r.status, 500)
    assert.deepEqual(r.body, { error: 'internal error' })
  } finally {
    console.error = orig
  }
  assert.ok(logged.some((l) => l.includes('/config/settings.json')))
})

test('client errors from middleware keep their status and message', async () => {
  const app = express()
  app.use(express.json({ limit: '10b' }))
  app.post('/x', (_req, res) => res.json({ ok: true }))
  const bad = await request(express().use(express.json()).post('/x', (_q, r) => r.json({})), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  })
  assert.equal(bad.status, 400)
  const big = await request(app, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 'x'.repeat(100) }),
  })
  assert.equal(big.status, 413)
  assert.match(big.body.error, /too large/i)
})
