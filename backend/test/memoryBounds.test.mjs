import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-membounds-'))
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-membounds-music-'))

const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u === 'https://music.apple.com') return new Response('<script src="/assets/index~a.js"></script>')
  if (u.includes('/assets/index~')) return new Response('x="eyJa.eyJb.sig"')
  const id = u.match(/\/artists\/([^/?]+)/)[1]
  return Response.json({ data: [{ id, attributes: { name: id }, relationships: { albums: { data: [] } } }] })
}

const { __test__ } = await import('../lib/queue.mjs')
const { loadArtistCatalogCached, getArtistCatalogCacheStats, peekArtistCatalog } =
  await import('../lib/artistCatalogCache.mjs')
const { state, updateJob } = __test__

const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset
test.after(() => {
  Date.now = realNow
  globalThis.fetch = realFetch
})

test('finished jobs beyond the history cap are dropped from memory', () => {
  for (let i = 0; i < 350; i++) {
    const id = `job-${i}`
    state.jobs.set(id, { id, kind: 'song', status: 'running', createdAt: i, stats: {} })
    offset = i
    updateJob(id, { status: i % 2 ? 'done' : 'failed' })
  }
  state.jobs.set('still-queued', { id: 'still-queued', kind: 'song', status: 'queued', createdAt: 0, stats: {} })
  offset = 400
  state.jobs.set('last', { id: 'last', kind: 'song', status: 'running', createdAt: 1, stats: {} })
  updateJob('last', { status: 'done' })

  const finished = [...state.jobs.values()].filter((j) => j.status === 'done' || j.status === 'failed')
  assert.equal(finished.length, 300)
  assert.ok(state.jobs.has('last'), 'the job that just finished stays')
  assert.ok(state.jobs.has('job-349'))
  assert.ok(!state.jobs.has('job-0'), 'the oldest finished jobs go')
  assert.ok(state.jobs.has('still-queued'), 'queued jobs are never dropped')
})

test('catalog cache entries older than a day are swept', async () => {
  offset = 0
  await loadArtistCatalogCached({ artistId: 'a1' })
  await loadArtistCatalogCached({ artistId: 'a2' })
  assert.equal(getArtistCatalogCacheStats().size, 2)
  offset = 2 * 60 * 60 * 1000
  await loadArtistCatalogCached({ artistId: 'a3' })
  assert.equal(getArtistCatalogCacheStats().size, 3, 'stale but recent entries stay for peeking')
  offset = 25 * 60 * 60 * 1000
  await loadArtistCatalogCached({ artistId: 'a4' })
  // a1 and a2 are 25h old, a3 23h
  assert.equal(getArtistCatalogCacheStats().size, 2)
  assert.equal(peekArtistCatalog({ artistId: 'a1' }), null)
  assert.equal(peekArtistCatalog({ artistId: 'a2' }), null)
  assert.ok(peekArtistCatalog({ artistId: 'a3' }))
  assert.ok(peekArtistCatalog({ artistId: 'a4' }))
})
