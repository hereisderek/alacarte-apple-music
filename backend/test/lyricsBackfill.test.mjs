import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmpConfig = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alacarte-lyrics-cfg-'))
const tmpMusic = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alacarte-lyrics-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const { startLyricsBackfill, getLyricsBackfillStatus, ttmlToLrc } = await import('../lib/lyricsBackfill.mjs')
const { buildMinimalFlacWithTags } = await import('../lib/audioTags.mjs')

function makeFlac(rel, isrc) {
  const abs = path.join(tmpMusic, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buildMinimalFlacWithTags(isrc ? { isrc } : {}))
  return abs
}

const TTML =
  '<tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="Line"><body><div>' +
  '<p begin="6.399" end="7.4">I been waitin&apos; on this</p>' +
  '<p begin="1:02.5" end="1:03">Rock &amp; <span>roll</span></p>' +
  '</div></body></tt>'

async function waitUntilDone() {
  const t0 = Date.now()
  while (getLyricsBackfillStatus().running) {
    if (Date.now() - t0 > 10_000) throw new Error('backfill did not finish')
    await new Promise((r) => setTimeout(r, 20))
  }
  return getLyricsBackfillStatus()
}

function deps(overrides = {}) {
  return {
    readSettings: async () => ({ storefront: 'pl', language: 'en-US', lyricsFormat: 'lrc' }),
    readAppleCreds: async () => ({ mediaUserToken: 'token' }),
    getSongsByIsrc: async ({ isrcs }) => ({
      data: isrcs.map((isrc) => ({
        id: `id-${isrc}`,
        attributes: { isrc, hasLyrics: isrc !== 'NOLYRICS0001' },
      })).filter((s) => s.attributes.isrc !== 'UNKNOWN00001'),
    }),
    getSongLyricsTtml: async () => TTML,
    triggerNavidromeScan: async () => {},
    delayMs: 0,
    now: () => Date.now(),
    ...overrides,
  }
}

test('ttmlToLrc writes amdp-style synced lines and decodes entities', () => {
  assert.equal(ttmlToLrc(TTML), "[00:06.39]I been waitin' on this\n[01:02.50]Rock & roll\n")
  assert.equal(
    ttmlToLrc('<tt itunes:timing="None"><p>one</p><p>two</p></tt>'),
    'one\ntwo\n',
  )
  assert.equal(ttmlToLrc('<tt></tt>'), null)
})

test('backfill only fills tracks that have no lyrics sidecar', async () => {
  const withLyrics = makeFlac('A/Album/01. Has.flac', 'USAAA0000001')
  fs.writeFileSync(withLyrics.replace(/\.flac$/, '.lrc'), 'keep me\n')
  const missing = makeFlac('A/Album/02. Missing.flac', 'USAAA0000002')
  makeFlac('A/Album/03. NoLyrics.flac', 'NOLYRICS0001')
  makeFlac('A/Album/04. Unknown.flac', 'UNKNOWN00001')
  makeFlac('A/Album/05. NoIsrc.flac', null)

  const requested = []
  await startLyricsBackfill({
    deps: deps({
      getSongLyricsTtml: async ({ id, mediaUserToken }) => {
        requested.push([id, mediaUserToken])
        return TTML
      },
    }),
  })
  const s = await waitUntilDone()

  assert.equal(s.total, 5)
  assert.equal(s.scanned, 5)
  assert.deepEqual(
    { added: s.added, skipped: s.skipped, noLyrics: s.noLyrics, noMatch: s.noMatch, failed: s.failed },
    { added: 1, skipped: 1, noLyrics: 1, noMatch: 2, failed: 0 },
  )
  assert.deepEqual(requested, [['id-USAAA0000002', 'token']])
  assert.equal(fs.readFileSync(withLyrics.replace(/\.flac$/, '.lrc'), 'utf8'), 'keep me\n')
  assert.match(fs.readFileSync(missing.replace(/\.flac$/, '.lrc'), 'utf8'), /^\[00:06\.39\]/)
})

test('backfill refuses to start without a media-user-token', async () => {
  await assert.rejects(
    startLyricsBackfill({ deps: deps({ readAppleCreds: async () => ({}) }) }),
    (err) => err.statusCode === 412,
  )
})
