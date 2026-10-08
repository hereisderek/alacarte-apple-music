import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createImportSession,
  getSession,
  publicSession,
  selectCandidate,
  getGlobalQueueStatus,
} from '../lib/importSession.mjs'
import { _resetConfigForTest, updateConfig } from '../lib/configStore.mjs'

test('getSession retrieves existing session by id for deep-linking', async () => {
  const session = await createImportSession({
    title: 'Deep Link Test',
    tracks: [{ title: 'Song 1', artists: ['Artist 1'] }],
  })

  const retrieved = getSession(session.id)
  assert.ok(retrieved)
  assert.equal(retrieved.id, session.id)
  assert.equal(retrieved.title, 'Deep Link Test')
  assert.equal(retrieved.items.length, 1)

  const pub = publicSession(retrieved)
  assert.equal(pub.id, session.id)
  assert.equal(pub.title, 'Deep Link Test')
})

test('selectCandidate enqueues track into global download queue', async () => {
  const session = await createImportSession({
    title: 'Manual Pick Queue Test',
    tracks: [{ title: 'Manual Song', artists: ['Artist'] }],
  })

  // Select candidate manually
  const updated = await selectCandidate(session.id, 0, {
    songId: 'candidate-999',
    albumId: 'album-999',
    name: 'Manual Song Title',
    artistName: 'Artist Name',
  })

  assert.ok(updated)
  assert.equal(updated.items[0].chosenSongId, 'candidate-999')
  assert.equal(updated.items[0].chosenName, 'Manual Song Title')
  // Item should transition to waiting or downloading
  assert.ok(['waiting', 'downloading', 'done'].includes(updated.items[0].status))

  const queueStatus = getGlobalQueueStatus()
  assert.equal(typeof queueStatus.active, 'number')
  assert.equal(typeof queueStatus.waiting, 'number')
})

test('otherSongsAhead calculates songs queued ahead from other sessions', async () => {
  const sessionA = await createImportSession({
    title: 'Session A',
    tracks: [{ title: 'A1', artists: ['ArtA'] }],
  })
  const sessionB = await createImportSession({
    title: 'Session B',
    tracks: [{ title: 'B1', artists: ['ArtB'] }],
  })

  await selectCandidate(sessionA.id, 0, {
    songId: 'song-a1',
    name: 'Song A1',
    artistName: 'ArtA',
  })

  await selectCandidate(sessionB.id, 0, {
    songId: 'song-b1',
    name: 'Song B1',
    artistName: 'ArtB',
  })

  const pubB = publicSession(getSession(sessionB.id))
  assert.equal(typeof pubB.otherSongsAhead, 'number')
})

