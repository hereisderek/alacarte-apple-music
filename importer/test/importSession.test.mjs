import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createImportSession, publicSession, getMaxTracksPerImport } from '../lib/importSession.mjs'

test('createImportSession stores language and publicSession exposes it', async () => {
  const session = await createImportSession({
    title: 'Test Playlist',
    tracks: [{ title: '七里香', artists: ['周杰伦'] }],
    language: 'zh-Hans',
  })
  assert.equal(session.language, 'zh-Hans')

  const pub = publicSession(session)
  assert.equal(pub.language, 'zh-Hans')
  assert.equal(pub.title, 'Test Playlist')
  assert.equal(pub.items.length, 1)
})

test('createImportSession enforces IMPORTER_MAX_TRACKS_PER_IMPORT and adds warning', async () => {
  const origEnv = process.env.IMPORTER_MAX_TRACKS_PER_IMPORT
  try {
    process.env.IMPORTER_MAX_TRACKS_PER_IMPORT = '2'
    assert.equal(getMaxTracksPerImport(), 2)

    const session = await createImportSession({
      title: 'Limit Test',
      tracks: [
        { title: 'Song 1', artists: ['Artist 1'] },
        { title: 'Song 2', artists: ['Artist 2'] },
        { title: 'Song 3', artists: ['Artist 3'] },
        { title: 'Song 4', artists: ['Artist 4'] },
      ],
    })

    assert.equal(session.items.length, 2)
    assert.equal(session.items[0].parsedTitle, 'Song 1')
    assert.equal(session.items[1].parsedTitle, 'Song 2')
    assert.equal(session.warnings.length, 1)
    assert.match(session.warnings[0], /limit of 2 songs/i)

    const pub = publicSession(session)
    assert.equal(pub.items.length, 2)
    assert.equal(pub.warnings.length, 1)
  } finally {
    if (origEnv !== undefined) {
      process.env.IMPORTER_MAX_TRACKS_PER_IMPORT = origEnv
    } else {
      delete process.env.IMPORTER_MAX_TRACKS_PER_IMPORT
    }
  }
})
