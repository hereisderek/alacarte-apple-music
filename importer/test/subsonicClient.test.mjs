import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  buildSubsonicUrl,
  searchSubsonicSongs,
  pingSubsonic,
  downloadSubsonicSongStream,
} from '../lib/subsonicClient.mjs'

test('buildSubsonicUrl formats authentication with token and salt', () => {
  const url = buildSubsonicUrl(
    'rest/search3.view',
    { query: 'test query', songCount: 5 },
    { url: 'http://test-server:8080', username: 'alice', password: 'secretpassword' },
  )

  const parsed = new URL(url)
  assert.equal(parsed.origin, 'http://test-server:8080')
  assert.equal(parsed.pathname, '/rest/search3.view')
  assert.equal(parsed.searchParams.get('u'), 'alice')
  assert.equal(parsed.searchParams.get('v'), '1.16.1')
  assert.equal(parsed.searchParams.get('c'), 'alacarte-importer')
  assert.equal(parsed.searchParams.get('f'), 'json')
  assert.equal(parsed.searchParams.get('query'), 'test query')
  assert.equal(parsed.searchParams.get('songCount'), '5')

  const salt = parsed.searchParams.get('s')
  const token = parsed.searchParams.get('t')
  assert.ok(salt, 'salt must be present')
  assert.ok(token, 'token must be present')

  // Verify md5(password + salt) == token
  const expectedToken = crypto.createHash('md5').update('secretpassword' + salt).digest('hex')
  assert.equal(token, expectedToken)
})

test('searchSubsonicSongs parses songs into SongCandidate format', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              song: [
                {
                  id: 'song-123',
                  title: 'Yellow',
                  artist: 'Coldplay',
                  album: 'Parachutes',
                  albumId: 'album-456',
                  duration: 269,
                  coverArt: 'cover-789',
                },
              ],
            },
          },
        }),
      }
    }

    const songs = await searchSubsonicSongs({
      query: 'Yellow Coldplay',
      limit: 1,
      url: 'http://test-server:8080',
      username: 'test',
      password: 'test',
    })

    assert.equal(songs.length, 1)
    assert.equal(songs[0].id, 'song-123')
    assert.equal(songs[0].name, 'Yellow')
    assert.equal(songs[0].artistName, 'Coldplay')
    assert.equal(songs[0].albumName, 'Parachutes')
    assert.equal(songs[0].albumId, 'album-456')
    assert.equal(songs[0].durationMs, 269000)
    assert.ok(songs[0].artworkTemplate.includes('getCoverArt.view?id=cover-789'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('downloadSubsonicSongStream drains response body stream', async () => {
  const originalFetch = globalThis.fetch
  try {
    const chunk1 = Buffer.from('AUDIO_HEADER_')
    const chunk2 = Buffer.from('AUDIO_DATA_PAYLOAD')
    globalThis.fetch = async (url) => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mp4' }),
        body: (async function* () {
          yield chunk1
          yield chunk2
        })(),
      }
    }

    const res = await downloadSubsonicSongStream('song-123', {
      override: { url: 'http://test-server:8080', username: 'test', password: 'test' },
    })

    assert.equal(res.ok, true)
    assert.equal(res.bytesDownloaded, chunk1.length + chunk2.length)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('buildSubsonicUrl reuses existing password when override has empty password', async () => {
  const { updateConfig, _resetConfigForTest, getInternalConfig } = await import('../lib/configStore.mjs')
  const initial = getInternalConfig()
  try {
    updateConfig({
      subsonic: {
        url: 'http://test-server:8080',
        username: 'savedUser',
        password: 'savedPassword123',
      },
    })

    // User tests connection with empty password (reusing existing password)
    const url = buildSubsonicUrl('rest/ping.view', {}, {
      url: 'http://test-server:8080',
      username: 'savedUser',
      password: '',
    })

    const parsed = new URL(url)
    const salt = parsed.searchParams.get('s')
    const token = parsed.searchParams.get('t')
    assert.ok(salt, 'salt must be generated')
    assert.ok(token, 'token must be generated')

    // Verify token was calculated from saved password 'savedPassword123'
    const expectedToken = crypto.createHash('md5').update('savedPassword123' + salt).digest('hex')
    assert.equal(token, expectedToken)
  } finally {
    _resetConfigForTest(initial)
  }
})

test('pingSubsonic fails early if username or password is missing', async () => {
  const res = await pingSubsonic({
    url: 'http://test-server:8080',
    username: '',
    password: '',
  })
  assert.equal(res.connected, false)
  assert.equal(res.ok, false)
  assert.ok(res.error.includes('required'))
})

