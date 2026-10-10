import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import express from 'express'

process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-isrc-'))
process.env.APPLE_GATEWAY_INTERVAL_MS = '0'
process.env.APPLE_GATEWAY_MIN_INTERVAL_MS = '0'
const { ensureConfigDir } = await import('../lib/settingsStore.mjs')
await ensureConfigDir(process.env.AMDL_CONFIG_DIR)
const { internalRouter } = await import('../routes/internal.mjs')

const realFetch = globalThis.fetch
const appleUrls = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u === 'https://music.apple.com') return new Response('<script src="/assets/index~a.js"></script>')
  if (u.endsWith('/assets/index~a.js')) return new Response('eyJhaa.eyJbbb.ccc')
  if (u.includes('amp-api.music.apple.com')) {
    appleUrls.push(u)
    return Response.json({
      data: [{
        id: '900',
        attributes: { name: 'Song', artistName: 'Artist', isrc: 'USAAA0000001', url: 'https://music.apple.com/us/album/x/555?i=900' },
        relationships: { artists: { data: [{ id: '77' }] } },
      }],
    })
  }
  return realFetch(url, init)
}
test.after(() => {
  globalThis.fetch = realFetch
})

async function get(query) {
  const app = express()
  app.use('/api/internal', internalRouter)
  const server = app.listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/songs-by-isrc?${query}`)
    return { status: res.status, json: await res.json() }
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('songs-by-isrc looks up many ISRCs with one Apple call and maps the songs', async () => {
  const res = await get('isrcs=usaaa0000001,USAAA0000002,USAAA0000001&storefront=nz')
  assert.equal(res.status, 200)
  assert.equal(appleUrls.length, 1)
  const url = new URL(appleUrls[0])
  assert.equal(url.pathname, '/v1/catalog/nz/songs')
  assert.equal(url.searchParams.get('filter[isrc]'), 'USAAA0000001,USAAA0000002', 'upper-cased and de-duplicated')
  assert.deepEqual(res.json.songs, [{
    id: '900', name: 'Song', artistName: 'Artist', artistId: '77', albumId: '555',
    albumName: undefined, durationMs: undefined, artworkTemplate: null, isrc: 'USAAA0000001',
  }].map((s) => JSON.parse(JSON.stringify(s))))
})

test('songs-by-isrc rejects missing, malformed or too many ISRCs without calling Apple', async () => {
  appleUrls.length = 0
  assert.equal((await get('')).status, 400)
  assert.equal((await get('isrcs=not-an-isrc')).status, 400)
  const many = Array.from({ length: 26 }, (_, i) => `USAAA00000${String(i).padStart(2, '0')}`).join(',')
  assert.equal((await get(`isrcs=${many}`)).status, 400)
  assert.equal(appleUrls.length, 0)
})
