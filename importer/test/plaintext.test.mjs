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

test('parsePlainText detects "Artist - Title" batch format when artists repeat on the left', () => {
  const input = [
    'Beyond - 光辉岁月',
    'Beyond - 真的爱你',
    'By2 - 爱的双重魔力',
    'By2 - 爱丫爱丫',
    'F.I.R. - 你的微笑',
    'F.I.R. - 千年之恋',
  ].join('\n')
  const tracks = parsePlainText(input)
  assert.equal(tracks.length, 6)
  assert.equal(tracks[0].title, '光辉岁月')
  assert.deepEqual(tracks[0].artists, ['Beyond'])
  assert.equal(tracks[2].title, '爱的双重魔力')
  assert.deepEqual(tracks[2].artists, ['By2'])
})

test('parsePlainText cleans multi-hyphen subtitles and remarks', () => {
  const [track] = parsePlainText('JS-杀破狼-《仙剑奇侠传》电视剧片头曲')
  assert.equal(track.title, '杀破狼')
  assert.deepEqual(track.artists, ['JS'])
})

test('parsePlainText cleans parenthetical original singer remarks from title', () => {
  const [track] = parsePlainText('M3 - 爱你(原唱‛：王心凌)')
  assert.equal(track.title, '爱你')
  assert.deepEqual(track.artists, ['M3'])
})

test('parsePlainText filters out non-song files like index.html', () => {
  const tracks = parsePlainText('Beyond - 光辉岁月\nindex.html\nstyle.css\nF4 - 流星雨')
  assert.equal(tracks.length, 2)
  assert.equal(tracks[0].title, '光辉岁月')
  assert.equal(tracks[1].title, '流星雨')
})

test('parsePlainText supports underscore and space delimiters', () => {
  const [t1] = parsePlainText('BoBo_光荣')
  assert.equal(t1.title, '光荣')
  assert.deepEqual(t1.artists, ['BoBo'])

  const [t2] = parsePlainText('Beyond 光辉岁月')
  assert.equal(t2.title, '光辉岁月')
  assert.deepEqual(t2.artists, ['Beyond'])
})
