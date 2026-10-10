import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.IMPORTER_SEARCH_PACING_MS = '100'
process.env.BACKEND_URL = 'http://backend.test:7373'
process.env.INTERNAL_API_KEY = 'k'

const { createImportSession } = await import('../lib/importSession.mjs')
const { parsePlainText } = await import('../parsers/plaintext.mjs')

const realFetch = globalThis.fetch
const calls = []
// songs the fake backend knows, by search text
const catalog = {
  'song one artist one': [{ id: '1', name: 'Song One', artistName: 'Artist One', albumId: '10', isrc: 'USAAA0000001' }],
  'song two': [{ id: '2', name: 'Song Two', artistName: 'Artist Two', albumId: '20', isrc: 'USAAA0000002' }],
}
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url))
  if (u.hostname !== 'backend.test') return realFetch(url, init)
  calls.push(`${u.pathname}${u.search ? '?' + decodeURIComponent(u.search.slice(1)).slice(0, 60) : ''}`)
  if (u.pathname === '/api/internal/search') {
    return Response.json({ songs: catalog[(u.searchParams.get('q') || '').toLowerCase()] || [] })
  }
  if (u.pathname === '/api/internal/songs-by-isrc') {
    const songs = u.searchParams.get('isrcs').split(',').map((isrc, i) => ({
      id: `isrc-${isrc}`, name: `Track ${isrc}`, artistName: 'Artist', albumId: String(i), isrc,
    }))
    return Response.json({ songs })
  }
  // downloads are not what is tested here
  return Response.json({ error: 'not under test' }, { status: 500 })
}
test.after(() => {
  globalThis.fetch = realFetch
})

async function settled(session) {
  for (let i = 0; i < 200 && session.items.some((it) => it.status === 'pending'); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('plain text lines can carry an ISRC, which is taken out of the title and artist', () => {
  const tracks = parsePlainText('Song One - Artist One [USAAA0000001]\nSong Two - Artist Two ISRC: GBBBB1234567\nSong Three - Artist Three')
  assert.equal(tracks[0].isrc, 'USAAA0000001')
  assert.deepEqual([tracks[0].title, tracks[0].artists], ['Song One', ['Artist One']])
  assert.equal(tracks[1].isrc, 'GBBBB1234567')
  assert.deepEqual([tracks[1].title, tracks[1].artists], ['Song Two', ['Artist Two']])
  assert.equal(tracks[2].isrc, undefined)
})

test('tracks with an ISRC are looked up 25 at a time, without any text search', async () => {
  calls.length = 0
  const tracks = Array.from({ length: 30 }, (_, i) => ({
    title: `T${i}`, artists: ['A'], isrc: `USAAA00000${String(i).padStart(2, '0')}`,
  }))
  const session = await createImportSession({ title: 'isrc', tracks })
  await settled(session)
  const isrcCalls = calls.filter((c) => c.startsWith('/api/internal/songs-by-isrc'))
  assert.equal(isrcCalls.length, 2, '25 + 5')
  assert.equal(calls.filter((c) => c.startsWith('/api/internal/search')).length, 0)
  assert.ok(session.items.every((it) => it.chosenSongId?.startsWith('isrc-')), 'all matched through the ISRC lookup')
})

test('an ISRC Apple does not return falls back to the text search', async () => {
  calls.length = 0
  const session = await createImportSession({
    title: 'fallback',
    tracks: [{ title: 'Song One', artists: ['Artist One'], isrc: 'USAAA0000001' }],
  })
  // the fake ISRC endpoint answers every ISRC, so test the unknown case with a malformed one:
  const bad = await createImportSession({
    title: 'bad isrc',
    tracks: [{ title: 'Song One', artists: ['Artist One'], isrc: 'not-an-isrc' }],
  })
  await settled(session)
  await settled(bad)
  assert.equal(bad.items[0].isrc, null)
  assert.equal(bad.items[0].chosenSongId, '1', 'matched by the text search')
})

test('a track costs at most two searches (no reversed-order query) and repeated queries cost none', async () => {
  calls.length = 0
  const session = await createImportSession({
    title: 'queries',
    tracks: [
      { title: 'Song Two', artists: ['Artist Two'] }, // "Song Two Artist Two" finds nothing, so "Song Two" is tried
      { title: 'Song Two', artists: ['Artist Two'] }, // the same again: both queries come from the cache
      { title: 'Nothing', artists: ['Nobody'] }, // nothing found by either query
    ],
  })
  await settled(session)
  const searches = calls.filter((c) => c.startsWith('/api/internal/search'))
  assert.deepEqual(
    searches.map((c) => c.split('q=')[1].split('&')[0].replace(/\+/g, ' ')),
    ['Song Two Artist Two', 'Song Two', 'Nothing Nobody', 'Nothing'],
    'no reversed-order query; each distinct query once',
  )
  assert.equal(session.items[2].status, 'notfound')
})
