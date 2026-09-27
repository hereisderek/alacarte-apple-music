import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createImportSession, publicSession } from '../lib/importSession.mjs'

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
