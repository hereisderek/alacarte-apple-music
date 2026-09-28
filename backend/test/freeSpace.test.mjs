import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const { assertFreeSpace, estimateJobBytes } = await import('../lib/folderLayout.mjs')

const GB = 1024 ** 3
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-space-'))
const staging = path.join(root, 'staging', 'not-created-yet')
const music = path.join(root, 'music')
await fsp.mkdir(music)

const freeOf = (gb) => async () => ({ bavail: gb * 1024, bsize: 1024 ** 2 })

test('estimate scales with tracks and quality', () => {
  assert.equal(estimateJobBytes(10, 'flac'), 10 * 100 * 1024 ** 2)
  assert.equal(estimateJobBytes(0, 'aac'), 12 * 1024 ** 2)
  assert.ok(estimateJobBytes(10, 'atmos') < estimateJobBytes(10, 'alac'))
})

test('passes when the disk has room', async () => {
  await assertFreeSpace({ stagingRoot: staging, musicRoot: music, bytes: 2 * GB, stagingFactor: 2, statfs: freeOf(10) })
})

test('refuses with a readable message when the disk is too full', async () => {
  await assert.rejects(
    assertFreeSpace({ stagingRoot: staging, musicRoot: music, bytes: 2 * GB, stagingFactor: 2, statfs: freeOf(4) }),
    (err) => err.code === 'NO_SPACE' && /4\.0 GB free, about 5\.0 GB needed/.test(err.message),
  )
})

test('a shared disk only needs the staging peak, not both', async () => {
  // staging 2x2 GB + 1 GB headroom = 5 GB; summing staging and library would need 7
  await assertFreeSpace({ stagingRoot: staging, musicRoot: music, bytes: 2 * GB, stagingFactor: 2, statfs: freeOf(5.5) })
})

test('separate disks are each checked for their own share', async () => {
  const statfs = async (dir) => (dir === music ? { bavail: 1024, bsize: 1024 ** 2 } : { bavail: 100 * 1024, bsize: 1024 ** 2 })
  const realStat = fsp.stat
  fsp.stat = async (p) => ({ ...(await realStat(p)), dev: p === music ? 2 : 1 })
  try {
    await assert.rejects(
      assertFreeSpace({ stagingRoot: staging, musicRoot: music, bytes: 2 * GB, stagingFactor: 2, statfs }),
      (err) => err.message.includes(music),
    )
  } finally {
    fsp.stat = realStat
  }
})

test('skips the check when free space cannot be read', async () => {
  await assertFreeSpace({
    stagingRoot: staging,
    musicRoot: music,
    bytes: 500 * GB,
    statfs: async () => {
      throw new Error('ENOSYS')
    },
  })
})
