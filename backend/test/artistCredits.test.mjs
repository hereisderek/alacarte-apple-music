import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmpConfig = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alacarte-credits-cfg-'))
const tmpMusic = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alacarte-credits-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const { creditFields, creditArtists, startArtistBackfill, getArtistBackfillStatus } = await import('../lib/artistCredits.mjs')
const { buildMinimalFlacWithTags, readFlacComments, writeFlacComments } = await import('../lib/audioTags.mjs')

const AUDIO = Buffer.from('pretend-audio-frames')

function makeFlac(rel, extra) {
  const abs = path.join(tmpMusic, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.concat([buildMinimalFlacWithTags({ extra }), AUDIO]))
  return abs
}

const songs = {
  USAAA0000001: { artists: ['Charli xcx', 'Billie Eilish'], composers: ['Billie Eilish', 'FINNEAS'] },
  USAAA0000002: { artists: ['Simon & Garfunkel'], composers: ['Paul Simon'] },
}
const albums = { '0000000000001': ['Denzel Curry', 'Kenny Beats'] }

function deps(extra = {}) {
  return {
    readSettings: async () => ({ storefront: 'pl', language: 'en-US' }),
    getSongsByIsrc: async ({ isrcs, include }) => {
      assert.equal(include, 'artists,composers')
      return {
        data: isrcs.filter((i) => songs[i]).map((isrc) => ({
          attributes: { isrc },
          relationships: {
            artists: { data: songs[isrc].artists.map((name) => ({ attributes: { name } })) },
            composers: { data: songs[isrc].composers.map((name) => ({ attributes: { name } })) },
          },
        })),
      }
    },
    getAlbumsByUpc: async ({ upcs }) => ({
      data: upcs.filter((u) => albums[u]).map((upc) => ({
        attributes: { upc },
        relationships: { artists: { data: albums[upc].map((name) => ({ attributes: { name } })) } },
      })),
    }),
    triggerNavidromeScan: async () => {},
    delayMs: 0,
    now: () => Date.now(),
    ...extra,
  }
}

test('only multi-name credits that differ are written', () => {
  assert.deepEqual(creditFields({}, { artists: ['A'], composers: ['C'], albumArtists: ['A'] }), {})
  assert.deepEqual(
    creditFields({ COMPOSER: ['X & Y'] }, { artists: ['A', 'B'], composers: ['X', 'Y'] }),
    { ARTISTS: ['A', 'B'], COMPOSER: ['X', 'Y'] },
  )
  assert.deepEqual(creditFields({ ARTISTS: ['A', 'B'] }, { artists: ['A', 'B'] }), {})
  assert.deepEqual(
    creditFields({ ARTIST: ['A & B'], PERFORMER: ['A & B'] }, { artists: ['A', 'B'] }),
    { ARTISTS: ['A', 'B'], PERFORMER: ['A', 'B'] },
  )
  assert.deepEqual(
    creditFields({ ARTIST: ['A & B'], ARTISTS: ['A', 'B'], PERFORMER: ['Session Drummer'] }, { artists: ['A', 'B'] }),
    {},
  )
})

test('writer replaces fields, keeps other tags and the audio bytes', async () => {
  const f = makeFlac('W/W/01. w.flac', { TITLE: 'Guess', ARTIST: 'Charli xcx & Billie Eilish', COMPOSER: 'old' })
  assert.equal(await writeFlacComments(f, { ARTISTS: ['Charli xcx', 'Billie Eilish'], COMPOSER: ['A', 'B'] }), true)
  const tags = await readFlacComments(f)
  assert.deepEqual(tags.ARTISTS, ['Charli xcx', 'Billie Eilish'])
  assert.deepEqual(tags.COMPOSER, ['A', 'B'])
  assert.deepEqual(tags.TITLE, ['Guess'])
  assert.deepEqual(tags.ARTIST, ['Charli xcx & Billie Eilish'])
  const buf = fs.readFileSync(f)
  assert.ok(buf.subarray(buf.length - AUDIO.length).equals(AUDIO))
})

test('credits come from apple data, not from splitting the display name', async () => {
  const collab = makeFlac('C/Brat/16. Guess.flac', { ISRC: 'USAAA0000001', ARTIST: 'Charli xcx & Billie Eilish' })
  const duo = makeFlac('S/Hits/01. Song.flac', { ISRC: 'USAAA0000002', ARTIST: 'Simon & Garfunkel' })
  const album = makeFlac('D/ii/01. x.flac', { BARCODE: '0000000000001', ALBUMARTIST: 'Denzel Curry & Kenny Beats' })
  const untagged = makeFlac('U/U/01. u.flac', { TITLE: 'no ids' })

  const results = {}
  await creditArtists([path.join(tmpMusic, 'C'), duo, album, untagged], {
    deps: deps(),
    onFile: ({ file, result }) => { results[path.basename(file)] = result },
  })
  assert.deepEqual(results, { '16. Guess.flac': 'updated', '01. Song.flac': 'unchanged', '01. x.flac': 'updated', '01. u.flac': 'noMatch' })
  assert.deepEqual((await readFlacComments(collab)).ARTISTS, ['Charli xcx', 'Billie Eilish'])
  assert.deepEqual((await readFlacComments(collab)).COMPOSER, ['Billie Eilish', 'FINNEAS'])
  assert.equal((await readFlacComments(duo)).ARTISTS, undefined)
  assert.deepEqual((await readFlacComments(album)).ALBUMARTISTS, ['Denzel Curry', 'Kenny Beats'])

  // a second run changes nothing
  const again = []
  await creditArtists([collab], { deps: deps(), onFile: ({ result }) => again.push(result) })
  assert.deepEqual(again, ['unchanged'])
})

test('backfill walks the library and asks for a full navidrome scan', async () => {
  makeFlac('B/B/01. b.flac', { ISRC: 'USAAA0000001' })
  const albumFile = makeFlac('B2/ii/01. y.flac', { BARCODE: '0000000000001' })
  let scan = null
  await startArtistBackfill({ deps: deps({ triggerNavidromeScan: async (opts) => { scan = opts } }) })
  while (getArtistBackfillStatus().running) await new Promise((r) => setTimeout(r, 10))
  const s = getArtistBackfillStatus()
  assert.equal(s.scanned, s.total)
  assert.equal(s.updated, 2)
  assert.equal(s.failed, 0)
  assert.deepEqual(scan, { fullScan: true })
  assert.deepEqual((await readFlacComments(albumFile)).ALBUMARTISTS, ['Denzel Curry', 'Kenny Beats'])
})
