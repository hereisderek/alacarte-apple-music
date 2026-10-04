import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-stall-cfg-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-stall-music-'))
process.env.AMDL_WRAPPER_HOST = '127.0.0.1'
for (const k of ['SUPERVISOR', 'DECRYPT', 'M3U8', 'ACCOUNT']) process.env[`AMDL_WRAPPER_${k}_PORT`] = '1'

const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) =>
  String(url).startsWith('http://127.0.0.1') ? realFetch(url, opts) : new Response('', { status: 503 })

const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset

const { emitEvent } = await import('../lib/eventBus.mjs')
const { healthRouter } = await import('../routes/health.mjs')

test.after(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
})

async function stall() {
  const app = express()
  app.use('/api/health', healthRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/health`)
    const { stallActive, stallRecent } = (await res.json()).wrapper
    return { stallActive, stallRecent }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const MIN = 60_000
const warn = (jobId) => emitEvent('wrapper.stall.suspected', { jobId, phase: 'warning' })
const clear = (jobId) => emitEvent('wrapper.stall.cleared', { jobId })

test('nothing to report before any stall', async () => {
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: false })
})

test('a stall shows as stalled, then recovered, then goes back to ready', async () => {
  warn('j1')
  assert.deepEqual(await stall(), { stallActive: true, stallRecent: false })
  offset += 30_000
  clear('j1')
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: true })
  offset += MIN
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: true })
  offset += MIN + 1000
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: false })
})

test('repeated slow patches during a long download do not keep it from going back', async () => {
  for (let i = 0; i < 6; i++) {
    warn('j2')
    offset += 10_000
    clear('j2')
    offset += 50_000
  }
  assert.equal((await stall()).stallRecent, true)
  offset += 2 * MIN
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: false })
})

test('an aborted stall and a job that finishes mid-stall both end it', async () => {
  emitEvent('wrapper.stall.suspected', { jobId: 'j3', phase: 'aborting' })
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: true })
  offset += 3 * MIN

  warn('j4')
  warn('j5')
  emitEvent('job.update', { id: 'j4', status: 'done' })
  assert.equal((await stall()).stallActive, true, 'j5 is still stalled')
  emitEvent('job.update', { id: 'j5', status: 'failed' })
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: true })
  offset += 3 * MIN
  assert.deepEqual(await stall(), { stallActive: false, stallRecent: false })
})
