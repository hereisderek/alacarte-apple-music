import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-store-atomic-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir, readSettings, writeSettings, encryptSecret, decryptSecret } =
  await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)

const { readFollowingStore, updateFollowedArtist, unfollowArtist } =
  await import('../lib/followedArtistsStore.mjs')

const SETTINGS_FILE = path.join(tmpDir, 'settings.json')
const FOLLOWING_FILE = path.join(tmpDir, 'followed-artists.json')

test('concurrent settings writes all land', async () => {
  await Promise.all([
    writeSettings({ storefront: 'jp' }),
    writeSettings({ navidromeUser: 'nd' }),
    writeSettings({ applePassword: encryptSecret('hunter2') }),
    writeSettings({ coverSize: '600x600' }),
  ])
  const s = await readSettings()
  assert.equal(s.storefront, 'jp')
  assert.equal(s.navidromeUser, 'nd')
  assert.equal(decryptSecret(s.applePassword), 'hunter2')
  assert.equal(s.coverSize, '600x600')
})

test('readers never see a half-written settings file during writes', async () => {
  await writeSettings({ appleEmail: encryptSecret('me@example.com') })
  let stop = false
  let sawDefaults = 0
  const reader = (async () => {
    while (!stop) {
      const raw = await fsp.readFile(SETTINGS_FILE, 'utf8')
      try {
        JSON.parse(raw)
      } catch {
        sawDefaults += 1
      }
      await new Promise((r) => setImmediate(r))
    }
  })()
  for (let i = 0; i < 50; i++) await writeSettings({ coverSize: `${i}x${i}` })
  stop = true
  await reader
  assert.equal(sawDefaults, 0)
  const s = await readSettings()
  assert.equal(decryptSecret(s.appleEmail), 'me@example.com')
  assert.equal(fs.existsSync(`${SETTINGS_FILE}.tmp`), false)
})

test('a corrupt settings file is kept aside instead of being overwritten', async () => {
  await writeSettings({ appleEmail: encryptSecret('keep@example.com') })
  const good = await fsp.readFile(SETTINGS_FILE, 'utf8')
  await fsp.writeFile(SETTINGS_FILE, good.slice(0, 40))
  const s = await readSettings()
  assert.equal(s.appleEmail, null)
  const backups = (await fsp.readdir(tmpDir)).filter((f) => f.startsWith('settings.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.equal(await fsp.readFile(path.join(tmpDir, backups[0]), 'utf8'), good.slice(0, 40))
})

test('concurrent followed-artist updates are not lost', async () => {
  await fsp.writeFile(
    FOLLOWING_FILE,
    JSON.stringify({
      version: 1,
      artists: {
        a1: { id: 'a1', name: 'One', missingReleaseCount: 5 },
        a2: { id: 'a2', name: 'Two', missingReleaseCount: 3 },
      },
    }),
  )
  const dec = (c) => ({ missingReleaseCount: Math.max(0, c.missingReleaseCount - 1) })
  await Promise.all([
    updateFollowedArtist('a1', dec),
    updateFollowedArtist('a1', dec),
    updateFollowedArtist('a2', { name: 'Two renamed' }),
    updateFollowedArtist('a1', dec),
  ])
  const store = await readFollowingStore()
  assert.equal(store.artists.a1.missingReleaseCount, 2)
  assert.equal(store.artists.a2.name, 'Two renamed')
  assert.equal(store.artists.a2.missingReleaseCount, 3)

  const [, unf] = await Promise.all([
    updateFollowedArtist('a2', { name: 'late' }),
    unfollowArtist('a2'),
  ])
  assert.equal(unf.existed, true)
  assert.equal((await readFollowingStore()).artists.a2, undefined)
})

test('a corrupt followed-artists file is kept aside', async () => {
  await fsp.writeFile(FOLLOWING_FILE, '{"version":1,"artists":{"a1"')
  const store = await readFollowingStore()
  assert.deepEqual(store.artists, {})
  const backups = (await fsp.readdir(tmpDir)).filter((f) => f.startsWith('followed-artists.json.corrupt-'))
  assert.equal(backups.length, 1)
})
