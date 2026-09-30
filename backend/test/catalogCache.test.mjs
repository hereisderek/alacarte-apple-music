import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-catcache-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-catcache-music-'))

const { __catalogCache } = await import('../lib/integrationCatalog.mjs')
const { cached, clear } = __catalogCache

test('repeat and concurrent lookups share one apple call until they expire', async () => {
  clear()
  let calls = 0
  const load = async () => ({ n: ++calls })
  const [a, b] = await Promise.all([cached(1000, 'k', load), cached(1000, 'k', load)])
  assert.equal(calls, 1)
  assert.equal(a, b)
  await cached(1000, 'k', load)
  assert.equal(calls, 1)
  await cached(-1, 'expired', load)
  await cached(-1, 'expired', load)
  assert.equal(calls, 3)
})

test('failed lookups are not kept', async () => {
  clear()
  let calls = 0
  await assert.rejects(cached(1000, 'bad', async () => { calls++; throw new Error('apple down') }))
  assert.deepEqual(await cached(1000, 'bad', async () => { calls++; return 'ok' }), 'ok')
  assert.equal(calls, 2)
})
