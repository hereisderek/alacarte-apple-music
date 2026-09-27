import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-lang-cfg-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir, readSettings, readPublicSettings, writeSettings } =
  await import('../lib/settingsStore.mjs')
await ensureConfigDir(tmpDir)

const { WRITABLE_KEYS } = await import('../routes/settings.mjs')

test('WRITABLE_KEYS includes the new language settings', () => {
  assert.ok(WRITABLE_KEYS.has('uiLanguage'))
  assert.ok(WRITABLE_KEYS.has('acceptedLanguages'))
  assert.ok(WRITABLE_KEYS.has('namingLanguageMode'))
})

test('language settings default to system / empty / display', async () => {
  const s = await readSettings()
  const pub = await readPublicSettings()
  assert.equal(s.uiLanguage, 'system')
  assert.deepEqual(s.acceptedLanguages, [])
  assert.equal(s.namingLanguageMode, 'display')
  assert.equal(pub.uiLanguage, 'system')
  assert.deepEqual(pub.acceptedLanguages, [])
  assert.equal(pub.namingLanguageMode, 'display')
})

test('writeSettings persists uiLanguage and namingLanguageMode', async () => {
  await writeSettings({ uiLanguage: 'zh', namingLanguageMode: 'dual' })
  const s = await readSettings()
  assert.equal(s.uiLanguage, 'zh')
  assert.equal(s.namingLanguageMode, 'dual')
  await writeSettings({ uiLanguage: 'system', namingLanguageMode: 'display' })
})

test('writeSettings normalizes an unknown uiLanguage/namingLanguageMode away', async () => {
  await writeSettings({ uiLanguage: 'klingon', namingLanguageMode: 'made-up' })
  const s = await readSettings()
  assert.equal(s.uiLanguage, 'system')
  assert.equal(s.namingLanguageMode, 'display')
})

test('acceptedLanguages dedupes, lowercases, filters invalid codes, and caps length', async () => {
  await writeSettings({
    acceptedLanguages: ['ZH', 'zh', 'en', 'not-a-language', 'ja', 'ko', 'es', 'fr'],
  })
  const s = await readSettings()
  assert.deepEqual(s.acceptedLanguages, ['zh', 'en', 'ja', 'ko', 'es', 'fr'])
})

test('acceptedLanguages preserves order (it is a preference ranking)', async () => {
  await writeSettings({ acceptedLanguages: ['fr', 'zh', 'en'] })
  const s = await readSettings()
  assert.deepEqual(s.acceptedLanguages, ['fr', 'zh', 'en'])
  await writeSettings({ acceptedLanguages: [] })
})
