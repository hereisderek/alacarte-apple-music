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
