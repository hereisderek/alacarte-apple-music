import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseInput } from '../parsers/index.mjs'

test('pasted text lines are tagged with their source and counted', async () => {
  const parsed = await parseInput({ text: 'Song One - Artist One\nSong Two - Artist Two' })
  assert.equal(parsed.tracks.length, 2)
  assert.deepEqual(parsed.tracks.map((t) => t.source), [
    { kind: 'text', label: 'Pasted text' },
    { kind: 'text', label: 'Pasted text' },
  ])
  assert.deepEqual(parsed.sources, [{ kind: 'text', label: 'Pasted text', count: 2 }])
})
