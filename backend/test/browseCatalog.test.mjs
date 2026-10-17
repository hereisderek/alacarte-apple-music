import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.APPLE_GATEWAY_INTERVAL_MS = '0'
process.env.APPLE_GATEWAY_MIN_INTERVAL_MS = '0'
process.env.AMDL_CONFIG_DIR = '/nonexistent-alacarte-test'
const { loadCurator, loadRecordLabel } = await import('../lib/browseCatalog.mjs')

const realFetch = globalThis.fetch
let appleCalls = []
let routes = {}
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u === 'https://music.apple.com') return new Response('<script src="/assets/index~a.js"></script>')
  if (u.endsWith('/assets/index~a.js')) return new Response('eyJhaa.eyJbbb.ccc')
  const path = new URL(u).pathname
  appleCalls.push(path)
  const body = routes[path]
  if (!body) return new Response('{"errors":[]}', { status: 404 })
  return Response.json(body)
}
test.after(() => {
  globalThis.fetch = realFetch
})

const album = (id, extra = {}) => ({ id, type: 'albums', attributes: { name: `A${id}`, artistName: 'X', ...extra } })

test('curator links fall back to apple-curators', async () => {
  appleCalls = []
  routes = {
    '/v1/catalog/us/apple-curators/7': {
      data: [{
        id: '7',
        attributes: { name: 'Lost Lands', editorialNotes: { short: 'fest' } },
        relationships: { playlists: { data: [{ id: 'pl.a', type: 'playlists', attributes: { name: 'P' } }] } },
      }],
    },
  }
  const r = await loadCurator({ id: '7', storefront: 'us' })
  assert.deepEqual(appleCalls, ['/v1/catalog/us/curators/7', '/v1/catalog/us/apple-curators/7'])
  assert.equal(r.curator.name, 'Lost Lands')
  assert.equal(r.curator.description, 'fest')
  assert.deepEqual(r.playlists.map((p) => p.id), ['pl.a'])
})

test('label pages the latest releases only when there are more', async () => {
  appleCalls = []
  routes = {
    '/v1/catalog/us/record-labels/9': {
      data: [{
        id: '9',
        attributes: { name: 'NSD' },
        views: {
          'latest-releases': { data: [album('1')], next: '/v1/catalog/us/record-labels/9/view/latest-releases?offset=10' },
          'top-releases': { data: [album('2'), album('2'), album('3', { name: 'A2', contentRating: 'explicit' })] },
        },
      }],
    },
    '/v1/catalog/us/record-labels/9/view/latest-releases': { data: [album('1'), album('4')] },
  }
  const r = await loadRecordLabel({ id: '9', storefront: 'us', explicitFilter: 'clean' })
  assert.equal(appleCalls.length, 2)
  assert.deepEqual(r.latestReleases.map((a) => a.id), ['1', '4'])
  assert.deepEqual(r.topReleases.map((a) => a.id), ['2'])

  appleCalls = []
  delete routes['/v1/catalog/us/record-labels/9'].data[0].views['latest-releases'].next
  await loadRecordLabel({ id: '9', storefront: 'us' })
  assert.equal(appleCalls.length, 1)
})

test('missing catalog resources are told apart from other apple errors', async () => {
  const { isMissingCatalogResource } = await import('../lib/appleErrors.mjs')
  assert.equal(isMissingCatalogResource(new Error('Apple API 404 on /v1/catalog/us/record-labels/1: ')), true)
  assert.equal(isMissingCatalogResource({ status: 404 }), true)
  assert.equal(isMissingCatalogResource(new Error('Apple API 500 on /v1/catalog/us/record-labels/1: ')), false)
})
