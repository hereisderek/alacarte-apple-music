import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-retired-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir, readPublicSettings, writeSettings } = await import('../lib/settingsStore.mjs')
const { WRITABLE_KEYS } = await import('../routes/settings.mjs')
await ensureConfigDir(tmpDir)

const RETIRED = ['albumFolderFormat', 'artistFolderFormat', 'songFileFormat', 'keepAlac']
const SETTINGS_FILE = path.join(tmpDir, 'settings.json')

test('settings that had no effect are no longer offered or accepted', async () => {
  const pub = await readPublicSettings()
  for (const key of RETIRED) {
    assert.equal(key in pub, false, `${key} is not public`)
    assert.equal(WRITABLE_KEYS.has(key), false, `${key} is not writable`)
  }
})

test('older settings files lose the retired keys on the next save', async () => {
  const old = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'))
  await fsp.writeFile(
    SETTINGS_FILE,
    JSON.stringify({ ...old, keepAlac: true, albumFolderFormat: '{AlbumName}', storefront: 'gb' }),
  )
  await writeSettings({ coverSize: '600x600' })
  const saved = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'))
  for (const key of RETIRED) assert.equal(key in saved, false)
  assert.equal(saved.storefront, 'gb')
  assert.equal(saved.coverSize, '600x600')
})
