import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePlainText } from '../parsers/plaintext.mjs'

test('parsePlainText splits "Title - Artist" lines', () => {
  const tracks = parsePlainText('七里香 - 周杰倫\n晴天 - 周杰倫')
  assert.equal(tracks.length, 2)
  assert.deepEqual(tracks[0], { raw: '七里香 - 周杰倫', title: '七里香', artists: ['周杰倫'] })
})

test('parsePlainText splits multiple comma-separated artists', () => {
  const [track] = parsePlainText('千里之外 - 周杰倫, 費玉清')
  assert.equal(track.title, '千里之外')
  assert.deepEqual(track.artists, ['周杰倫', '費玉清'])
})

test('parsePlainText keeps a title-only line searchable without an artist', () => {
  const [track] = parsePlainText('Some Song With No Dash')
  assert.equal(track.title, 'Some Song With No Dash')
  assert.deepEqual(track.artists, [])
})

test('parsePlainText splits lines with no spaces around hyphen', () => {
  const [track] = parsePlainText('甜甜的-周杰倫')
  assert.equal(track.title, '甜甜的')
  assert.deepEqual(track.artists, ['周杰倫'])
})

test('parsePlainText ignores blank lines', () => {
  const tracks = parsePlainText('七里香 - 周杰倫\n\n\n晴天 - 周杰倫\n')
  assert.equal(tracks.length, 2)
})
