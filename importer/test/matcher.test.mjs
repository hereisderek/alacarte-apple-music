import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickBestMatch } from '../lib/matcher.mjs'

test('pickBestMatch auto-picks the top candidate whenever any results exist', () => {
  // Apple Music storefronts outside Greater China return romanized metadata
  // ("周杰倫" -> "Jay Chou"), so this must not require the artist name to
  // textually match the parsed (Chinese) artist — see lib/matcher.mjs.
  const candidates = [
    { id: '1', name: 'Qi-Li-Xiang', artistName: 'Jay Chou' },
    { id: '2', name: '七里香 (Live)', artistName: 'Jay Chou' },
  ]
  const result = pickBestMatch(candidates)
  assert.equal(result.status, 'matched')
  assert.equal(result.chosen.id, '1')
  assert.equal(result.candidates.length, 2)
})

test('pickBestMatch reports notfound for an empty candidate list', () => {
  assert.equal(pickBestMatch([]).status, 'notfound')
  assert.equal(pickBestMatch(undefined).status, 'notfound')
})

test('pickBestMatch auto-picks when query contains singer info', () => {
  const candidates = [
    { id: '1', name: '甜甜的', artistName: '周杰伦' },
  ]
  const result = pickBestMatch(candidates, { query: '甜甜的 周杰倫', parsedArtists: [] })
  assert.equal(result.status, 'matched')
  assert.equal(result.chosen.id, '1')
})

test('pickBestMatch auto-picks when query contains album info', () => {
  const candidates = [
    { id: '1', name: '甜甜的', artistName: '周杰伦', albumName: '我很忙' },
  ]
  const result = pickBestMatch(candidates, { query: '甜甜的 我很忙', parsedArtists: [] })
  assert.equal(result.status, 'matched')
  assert.equal(result.chosen.id, '1')
})

test('pickBestMatch requires preview (notfound) when query has no singer info', () => {
  const candidates = [
    { id: '1', name: '时光机', artistName: '五月天' },
    { id: '2', name: '时光机', artistName: '周杰伦' },
  ]
  const result = pickBestMatch(candidates, { query: '时光机', parsedArtists: [] })
  assert.equal(result.status, 'notfound')
  assert.equal(result.chosen, null)
  assert.equal(result.candidates.length, 2)
})
