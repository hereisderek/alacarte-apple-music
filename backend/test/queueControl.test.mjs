import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const tmpConfig = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-queuectl-'))
const tmpMusic = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-queuectl-music-'))
process.env.AMDL_CONFIG_DIR = tmpConfig
process.env.AMDL_MUSIC_PATH = tmpMusic

const { getMeta } = await import('../lib/db.mjs')
const { reorderQueue, setQueuePaused, getQueueState, listJobs, __test__ } = await import('../lib/queue.mjs')
const { state, persistJob, restorePersistedJobs, tickQueue } = __test__

function addQueued(id, createdAt) {
  const job = { id, kind: 'album', status: 'queued', createdAt, progress: 0 }
  state.jobs.set(id, job)
  state.queue.push(id)
  persistJob(job, true)
  return job
}

function reset() {
  state.jobs.clear()
  state.queue = []
  state.active.clear()
}

test('reorder puts listed jobs first and keeps the rest in order', () => {
  reset()
  addQueued('a', 100)
  addQueued('b', 100)
  addQueued('c', 300)
  addQueued('d', 400)

  assert.deepEqual(reorderQueue(['c', 'ghost', 'c']), ['c', 'a', 'b', 'd'])
  const seq = (id) => state.jobs.get(id).queueSeq ?? state.jobs.get(id).createdAt
  assert.ok(seq('c') < seq('a') && seq('a') < seq('b') && seq('b') < seq('d'))
  // new jobs still land at the end
  assert.ok(seq('d') < Date.now())
})

test('queue order survives a restart', () => {
  reset()
  addQueued('x', 1)
  addQueued('y', 2)
  addQueued('z', 3)
  reorderQueue(['z', 'x', 'y'])
  reset()
  restorePersistedJobs()
  assert.deepEqual(state.queue.filter((id) => ['x', 'y', 'z'].includes(id)), ['z', 'x', 'y'])
})

test('paused queue starts nothing and remembers the pause', async () => {
  reset()
  addQueued('p1', 10)
  setQueuePaused(true)
  assert.equal(getQueueState().paused, true)
  assert.equal(getMeta('queue_paused'), '1')
  await tickQueue()
  assert.equal(state.active.size, 0)
  assert.deepEqual(state.queue, ['p1'])
  assert.equal(listJobs().find((j) => j.id === 'p1').status, 'queued')

  // resume without starting a real download
  state.queue = []
  setQueuePaused(false)
  assert.equal(getMeta('queue_paused'), '0')
  assert.equal(getQueueState().paused, false)
})
