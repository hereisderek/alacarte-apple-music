import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getPublicConfig,
  getInternalConfig,
  updateConfig,
  isLocked,
  _resetConfigForTest,
} from '../lib/configStore.mjs'

test('configStore returns public config with masked credentials', () => {
  const cfg = getPublicConfig()
  assert.equal(typeof cfg.mode, 'string')
  assert.equal(typeof cfg.locked, 'boolean')
  assert.equal(typeof cfg.alacarte.backendUrl, 'string')
  assert.equal(typeof cfg.alacarte.hasKey, 'boolean')
  assert.equal(typeof cfg.subsonic.url, 'string')
  assert.equal(typeof cfg.subsonic.hasPassword, 'boolean')
  assert.equal(typeof cfg.subsonic.downloadEndpoint, 'string')
  // Public config should never expose raw internalApiKey or password
  assert.equal('internalApiKey' in cfg.alacarte, false)
  assert.equal('password' in cfg.subsonic, false)
})

test('configStore allows updates when unlocked', () => {
  if (isLocked()) return // Skipped if locked in environment

  const initial = getInternalConfig()
  try {
    updateConfig({
      mode: 'subsonic',
      subsonic: {
        url: 'http://test-subsonic:4533',
        username: 'testuser',
        password: 'testpassword',
        downloadEndpoint: 'rest/download.view',
      },
    })

    const updated = getPublicConfig()
    assert.equal(updated.mode, 'subsonic')
    assert.equal(updated.subsonic.url, 'http://test-subsonic:4533')
    assert.equal(updated.subsonic.username, 'testuser')
    assert.equal(updated.subsonic.hasPassword, true)
    assert.equal(updated.subsonic.downloadEndpoint, 'rest/download.view')

    const internal = getInternalConfig()
    assert.equal(internal.subsonic.password, 'testpassword')
  } finally {
    _resetConfigForTest(initial)
  }
})

test('configStore supports searchIntervalMs updates when unlocked', () => {
  if (isLocked()) return

  const initial = getInternalConfig()
  try {
    updateConfig({ searchIntervalMs: 2000 })
    const updated = getPublicConfig()
    assert.equal(updated.searchIntervalMs, 2000)
    assert.equal(getInternalConfig().searchIntervalMs, 2000)
  } finally {
    _resetConfigForTest(initial)
  }
})

test('configStore saves and remembers alacarte internalApiKey, and preserves it on empty update', () => {
  if (isLocked()) return

  const initial = getInternalConfig()
  try {
    // 1. Save new API key
    updateConfig({
      mode: 'alacarte',
      alacarte: {
        backendUrl: 'http://my-web:7373',
        internalApiKey: 'super-secret-key-123',
      },
    })

    let pub = getPublicConfig()
    assert.equal(pub.alacarte.hasKey, true)
    assert.equal(getInternalConfig().alacarte.internalApiKey, 'super-secret-key-123')

    // 2. Update without changing key (e.g. empty key in form or undefined)
    updateConfig({
      alacarte: {
        backendUrl: 'http://my-web:7373',
        internalApiKey: '',
      },
    })

    pub = getPublicConfig()
    assert.equal(pub.alacarte.hasKey, true)
    assert.equal(getInternalConfig().alacarte.internalApiKey, 'super-secret-key-123')

    // 3. Update other settings (like searchIntervalMs) without touching alacarte
    updateConfig({
      searchIntervalMs: 1800,
    })

    pub = getPublicConfig()
    assert.equal(pub.alacarte.hasKey, true)
    assert.equal(getInternalConfig().alacarte.internalApiKey, 'super-secret-key-123')
  } finally {
    _resetConfigForTest(initial)
  }
})

test('configStore preserves subsonic password on empty update', () => {
  if (isLocked()) return

  const initial = getInternalConfig()
  try {
    // 1. Set password
    updateConfig({
      mode: 'subsonic',
      subsonic: {
        url: 'http://octo-test:8080',
        username: 'alice',
        password: 'alice-secret-password',
      },
    })

    let pub = getPublicConfig()
    assert.equal(pub.subsonic.hasPassword, true)
    assert.equal(getInternalConfig().subsonic.password, 'alice-secret-password')

    // 2. User updates other subsonic fields (e.g. endpoint) with empty password (keep existing)
    updateConfig({
      subsonic: {
        downloadEndpoint: 'rest/download.view',
        password: '',
      },
    })

    pub = getPublicConfig()
    assert.equal(pub.subsonic.hasPassword, true)
    assert.equal(getInternalConfig().subsonic.password, 'alice-secret-password')
    assert.equal(getInternalConfig().subsonic.downloadEndpoint, 'rest/download.view')
  } finally {
    _resetConfigForTest(initial)
  }
})

