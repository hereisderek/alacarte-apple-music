import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-events-'))

const { bumpSessionVersion, getSessionVersion } = await import('../lib/authStore.mjs')
const { emitEvent } = await import('../lib/eventBus.mjs')
const { eventsRouter } = await import('../routes/events.mjs')

async function withEventsServer(session, fn) {
  const app = express()
  app.use((req, _res, next) => {
    req.session = session
    next()
  })
  app.use('/api/events', eventsRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(server.address().port)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

function connect(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/events' }, resolve)
  })
}

test('a revoked session loses its event stream', async () => {
  const sv = await getSessionVersion()
  await withEventsServer({ user: 'owner', sv }, async (port) => {
    const res = await connect(port)
    const ended = new Promise((resolve) => res.on('end', resolve))
    res.resume()
    await bumpSessionVersion()
    const result = await Promise.race([
      ended.then(() => 'ended'),
      new Promise((r) => setTimeout(() => r('still open'), 2000)),
    ])
    assert.equal(result, 'ended')
  })
})

test('a client that stops reading is not buffered every event and is told to resync', async () => {
  await withEventsServer({ user: 'owner', sv: 1e9 }, async (port) => {
    const res = await connect(port)
    res.pause()
    const payload = 'x'.repeat(20_000)
    const EMITTED = 2000 // ~40 MB, far beyond the socket buffers
    for (let i = 0; i < EMITTED; i++) emitEvent('test.big', { i, payload })
    let received = 0
    let tail = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      const text = tail + chunk
      received += (text.match(/event: test\.big/g) || []).length
      tail = text.slice(-20)
    })
    const ended = new Promise((resolve) => res.on('end', resolve))
    res.resume()
    // Once it caught up the stream closes, so the browser reconnects and
    // reloads what it missed.
    const result = await Promise.race([
      ended.then(() => 'ended'),
      new Promise((r) => setTimeout(() => r('still open'), 3000)),
    ])
    assert.equal(result, 'ended')
    assert.ok(received > 0, 'events still arrive')
    assert.ok(received < EMITTED / 2, `only what fit in the buffers arrived (${received})`)
  })
})

test('a client that keeps up gets every event on one stream', async () => {
  await withEventsServer({ user: 'owner', sv: 1e9 }, async (port) => {
    const res = await connect(port)
    let received = 0
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      received += (chunk.match(/event: test\.small/g) || []).length
    })
    await new Promise((r) => setTimeout(r, 50))
    for (let i = 0; i < 200; i++) emitEvent('test.small', { i })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(received, 200)
    assert.equal(res.complete, false, 'stream stays open')
    res.destroy()
  })
})
