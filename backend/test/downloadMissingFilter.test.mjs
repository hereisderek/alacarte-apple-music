import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-dl-missing-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-dl-missing-music-'))
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

// Fake Apple: the artist has an explicit and a clean edition of one album.
const realFetch = globalThis.fetch
const artistLanguages = []
const album = (id, contentRating) => ({
  id,
  type: 'albums',
  attributes: { name: 'Record', artistName: 'Band', releaseDate: '2020-01-01', trackCount: 10, contentRating },
})
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u === 'https://music.apple.com') return new Response('<script src="/assets/index~abc.js"></script>')
  if (u.includes('/assets/index~')) return new Response('x="eyJa.eyJb.sig"')
  if (u.includes('/artists/')) {
    artistLanguages.push(new URL(u).searchParams.get('l'))
    return Response.json({
      data: [
        {
          id: 'art1',
          type: 'artists',
          attributes: { name: 'Band' },
          relationships: { albums: { data: [album('explicit1', 'explicit'), album('clean1', 'clean')] } },
        },
      ],
    })
  }
  const id = u.match(/\/albums\/([^/?]+)/)?.[1]
  return Response.json({ data: [{ ...album(id), relationships: { tracks: { data: [] } } }] })
}

const { ensureConfigDir, writeSettings } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpConfig)
loadSecretsAtBoot(tmpConfig)
await writeSettings({ explicitFilter: 'clean', language: 'ja' })
await fsp.writeFile(
  path.join(tmpConfig, 'followed-artists.json'),
  JSON.stringify({
    version: 1,
    artists: { art1: { id: 'art1', name: 'Band', storefront: 'us', missingReleaseCount: 1, releaseScope: 'everything' } },
  }),
)

const { setQueuePaused, cancelAllJobs, __test__ } = await import('../lib/queue.mjs')
const { followingRouter } = await import('../routes/following.mjs')
const { state } = __test__
setQueuePaused(true)
test.after(() => {
  globalThis.fetch = realFetch
})

async function post(route) {
  const app = express()
  app.use(express.json())
  app.use('/api/following', followingRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/following${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return res.json()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const queuedAlbumIds = () =>
  [...state.jobs.values()].filter((j) => j.status === 'queued').map((j) => j.albumId).sort()

for (const route of ['/art1/download-missing', '/download-missing']) {
  test(`${route} queues the edition the explicit/clean setting picks`, async () => {
    await cancelAllJobs()
    artistLanguages.length = 0
    const body = await post(route)
    assert.equal(body.queued, 1)
    assert.deepEqual(queuedAlbumIds(), ['clean1'])
    assert.ok(artistLanguages.every((l) => l === 'ja'), 'uses the catalog language setting')
  })
}
