import fs from 'node:fs'
import path from 'node:path'

function isTrue(val) {
  if (!val) return false
  const s = String(val).trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

const LOCKED = isTrue(process.env.IMPORTER_CONFIG_LOCKED)
const INTERVAL_LOCKED = isTrue(process.env.IMPORTER_INTERVAL_LOCKED) || LOCKED
const DEFAULT_INTERVAL_MS = Math.max(
  100,
  Number(process.env.IMPORTER_SEARCH_INTERVAL_MS || process.env.IMPORTER_SEARCH_PACING_MS) || 1500,
)

const CONFIG_FILE = process.env.IMPORTER_CONFIG_FILE || '/data/importer-config.json'

let currentConfig = {
  mode: (process.env.IMPORTER_MODE || 'alacarte').trim().toLowerCase() === 'subsonic' ? 'subsonic' : 'alacarte',
  searchIntervalMs: DEFAULT_INTERVAL_MS,
  alacarte: {
    backendUrl: (process.env.BACKEND_URL || 'http://web:7373').replace(/\/+$/, ''),
    internalApiKey: process.env.INTERNAL_API_KEY || '',
  },
  subsonic: {
    url: (process.env.SUBSONIC_URL || 'http://octo-fiesta:8080').replace(/\/+$/, ''),
    username: process.env.SUBSONIC_USERNAME || '',
    password: process.env.SUBSONIC_PASSWORD || '',
    downloadEndpoint: process.env.SUBSONIC_DOWNLOAD_ENDPOINT || 'rest/stream.view',
  },
}

// Load saved config if file exists and config is not locked
if (!LOCKED && fs.existsSync(CONFIG_FILE)) {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const saved = JSON.parse(raw)
    if (saved.mode === 'alacarte' || saved.mode === 'subsonic') {
      currentConfig.mode = saved.mode
    }
    if (!INTERVAL_LOCKED && typeof saved.searchIntervalMs === 'number' && saved.searchIntervalMs >= 100) {
      currentConfig.searchIntervalMs = Math.floor(saved.searchIntervalMs)
    }
    if (saved.alacarte) {
      if (saved.alacarte.backendUrl) currentConfig.alacarte.backendUrl = saved.alacarte.backendUrl.replace(/\/+$/, '')
      if (typeof saved.alacarte.internalApiKey === 'string' && saved.alacarte.internalApiKey.trim().length > 0) {
        currentConfig.alacarte.internalApiKey = saved.alacarte.internalApiKey.trim()
      }
    }
    if (saved.subsonic) {
      if (saved.subsonic.url) currentConfig.subsonic.url = saved.subsonic.url.replace(/\/+$/, '')
      if (typeof saved.subsonic.username === 'string') currentConfig.subsonic.username = saved.subsonic.username
      if (typeof saved.subsonic.password === 'string' && saved.subsonic.password.length > 0) {
        currentConfig.subsonic.password = saved.subsonic.password
      }
      if (saved.subsonic.downloadEndpoint) currentConfig.subsonic.downloadEndpoint = saved.subsonic.downloadEndpoint
    }
  } catch (err) {
    console.warn('[configStore] Failed to load saved config from', CONFIG_FILE, err.message)
  }
}

function persistConfig() {
  if (LOCKED) return
  try {
    const dir = path.dirname(CONFIG_FILE)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8')
  } catch (err) {
    if (process.env.IMPORTER_CONFIG_FILE) {
      console.warn('[configStore] Failed to persist config to', CONFIG_FILE, err.message)
    }
  }
}

export function isLocked() {
  return LOCKED
}

export function getPublicConfig() {
  return {
    mode: currentConfig.mode,
    locked: LOCKED,
    searchIntervalMs: currentConfig.searchIntervalMs,
    intervalLocked: INTERVAL_LOCKED,
    alacarte: {
      backendUrl: currentConfig.alacarte.backendUrl,
      hasKey: Boolean(currentConfig.alacarte.internalApiKey),
    },
    subsonic: {
      url: currentConfig.subsonic.url,
      username: currentConfig.subsonic.username,
      hasPassword: Boolean(currentConfig.subsonic.password),
      downloadEndpoint: currentConfig.subsonic.downloadEndpoint,
    },
  }
}

export function getInternalConfig() {
  return {
    mode: currentConfig.mode,
    locked: LOCKED,
    searchIntervalMs: currentConfig.searchIntervalMs,
    intervalLocked: INTERVAL_LOCKED,
    alacarte: { ...currentConfig.alacarte },
    subsonic: { ...currentConfig.subsonic },
  }
}

export function updateConfig(patch = {}) {
  if (LOCKED) {
    const err = new Error('Configuration is locked by environment (IMPORTER_CONFIG_LOCKED=true)')
    err.status = 403
    throw err
  }

  if (patch.mode === 'alacarte' || patch.mode === 'subsonic') {
    currentConfig.mode = patch.mode
  }

  if (patch.searchIntervalMs !== undefined) {
    if (INTERVAL_LOCKED) {
      if (patch.searchIntervalMs !== currentConfig.searchIntervalMs) {
        const err = new Error('Search interval is locked by environment (IMPORTER_INTERVAL_LOCKED=true)')
        err.status = 403
        throw err
      }
    } else {
      const ms = Number(patch.searchIntervalMs)
      if (Number.isFinite(ms) && ms >= 100) {
        currentConfig.searchIntervalMs = Math.floor(ms)
      }
    }
  }

  if (patch.alacarte && typeof patch.alacarte === 'object') {
    if (typeof patch.alacarte.backendUrl === 'string' && patch.alacarte.backendUrl.trim()) {
      currentConfig.alacarte.backendUrl = patch.alacarte.backendUrl.trim().replace(/\/+$/, '')
    }
    if (typeof patch.alacarte.internalApiKey === 'string' && patch.alacarte.internalApiKey.trim().length > 0) {
      currentConfig.alacarte.internalApiKey = patch.alacarte.internalApiKey.trim()
    }
  }

  if (patch.subsonic && typeof patch.subsonic === 'object') {
    if (typeof patch.subsonic.url === 'string' && patch.subsonic.url.trim()) {
      currentConfig.subsonic.url = patch.subsonic.url.trim().replace(/\/+$/, '')
    }
    if (typeof patch.subsonic.username === 'string') {
      currentConfig.subsonic.username = patch.subsonic.username.trim()
    }
    if (typeof patch.subsonic.password === 'string' && patch.subsonic.password.length > 0) {
      currentConfig.subsonic.password = patch.subsonic.password
    }
    if (typeof patch.subsonic.downloadEndpoint === 'string' && patch.subsonic.downloadEndpoint.trim()) {
      currentConfig.subsonic.downloadEndpoint = patch.subsonic.downloadEndpoint.trim()
    }
  }

  persistConfig()
  return getPublicConfig()
}

// For testing purposes
export function _resetConfigForTest(newConfig) {
  if (newConfig) {
    currentConfig = { ...newConfig }
  }
}
