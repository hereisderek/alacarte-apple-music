import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { internalRouter } from '../routes/internal.mjs'

test('internalRouter GET /health returns status structure', async () => {
  const app = express()
  app.use('/api/internal', internalRouter)

  const server = app.listen(0)
  try {
    const port = server.address().port
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/health`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok('ok' in data)
    assert.ok('wrapper' in data)
    assert.ok('appleToken' in data)
    assert.ok('queue' in data)
    assert.ok(typeof data.queue.running === 'number')
    assert.ok(typeof data.queue.queued === 'number')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
