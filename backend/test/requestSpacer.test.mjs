import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSpacer } from '../lib/requestSpacer.mjs'

test('createSpacer enforces a minimum gap between dispatch times', async () => {
  const run = createSpacer(50)
  const starts = []
  const calls = [1, 2, 3].map((n) =>
    run(() => {
      starts.push(Date.now())
      return n
    }),
  )
  const results = await Promise.all(calls)
  assert.deepEqual(results, [1, 2, 3])
  assert.ok(starts[1] - starts[0] >= 45, `expected >=45ms gap, got ${starts[1] - starts[0]}`)
  assert.ok(starts[2] - starts[1] >= 45, `expected >=45ms gap, got ${starts[2] - starts[1]}`)
})

test('createSpacer keeps running later calls after an earlier one throws', async () => {
  const run = createSpacer(10)
  await assert.rejects(run(() => Promise.reject(new Error('boom'))))
  const value = await run(() => 'ok')
  assert.equal(value, 'ok')
})
