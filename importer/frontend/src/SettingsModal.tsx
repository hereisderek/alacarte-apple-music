import React, { useEffect, useState } from 'react'
import {
  api,
  type ImporterConfig,
  type TestConfigResult,
} from './api'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
  onConfigSaved: () => void
}

export function SettingsModal({ open, onClose, onConfigSaved }: SettingsModalProps) {
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<ImporterConfig | null>(null)
  const [mode, setMode] = useState<'alacarte' | 'subsonic'>('alacarte')

  // ALACarte fields
  const [backendUrl, setBackendUrl] = useState('')
  const [internalApiKey, setInternalApiKey] = useState('')

  // Subsonic fields
  const [subsonicUrl, setSubsonicUrl] = useState('')
  const [subsonicUsername, setSubsonicUsername] = useState('')
  const [subsonicPassword, setSubsonicPassword] = useState('')
  const [subsonicDownloadEndpoint, setSubsonicDownloadEndpoint] = useState('rest/stream.view')

  // Search pacing interval
  const [searchIntervalMs, setSearchIntervalMs] = useState(1500)

  // Test & Save state
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConfigResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setTestResult(null)
    setSaveError(null)
    api
      .getConfig()
      .then((cfg) => {
        setConfig(cfg)
        setMode(cfg.mode)
        setSearchIntervalMs(typeof cfg.searchIntervalMs === 'number' ? cfg.searchIntervalMs : 1500)
        setBackendUrl(cfg.alacarte.backendUrl || '')
        setSubsonicUrl(cfg.subsonic.url || '')
        setSubsonicUsername(cfg.subsonic.username || '')
        setSubsonicDownloadEndpoint(cfg.subsonic.downloadEndpoint || 'rest/stream.view')
        // Do not pre-fill cleartext password or key; leave empty unless user wants to change
        setInternalApiKey('')
        setSubsonicPassword('')
      })
      .catch((err) => {
        setSaveError(err.message || 'Failed to load configuration')
      })
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const isLocked = Boolean(config?.locked)

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    setSaveError(null)
    try {
      const res = await api.testConfig({
        mode,
        alacarte: {
          backendUrl: backendUrl.trim(),
          internalApiKey: internalApiKey.trim(),
        },
        subsonic: {
          url: subsonicUrl.trim(),
          username: subsonicUsername.trim(),
          password: subsonicPassword.trim(),
          downloadEndpoint: subsonicDownloadEndpoint.trim(),
        },
      })
      setTestResult(res)
    } catch (err: any) {
      setTestResult({
        connected: false,
        ok: false,
        error: err?.message || 'Connection test failed',
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (isLocked) return
    setSaving(true)
    setSaveError(null)
    try {
      await api.saveConfig({
        mode,
        searchIntervalMs: Number(searchIntervalMs) || 1500,
        alacarte: {
          backendUrl: backendUrl.trim() || undefined,
          internalApiKey: internalApiKey.trim() || undefined,
        },
        subsonic: {
          url: subsonicUrl.trim() || undefined,
          username: subsonicUsername.trim() || undefined,
          password: subsonicPassword.trim() || undefined,
          downloadEndpoint: subsonicDownloadEndpoint.trim() || undefined,
        },
      })
      onConfigSaved()
      onClose()
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save configuration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-lg rounded-xl bg-neutral-900 border border-neutral-700/80 p-5 shadow-2xl text-neutral-100 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚙️</span>
            <h2 className="text-base font-semibold">Importer Settings</h2>
            {isLocked && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-950/80 border border-amber-800/80 px-2 py-0.5 text-[11px] text-amber-300 font-medium">
                🔒 Locked by Environment
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-100 text-lg leading-none p-1 rounded hover:bg-neutral-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-neutral-400">Loading settings…</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            {isLocked && (
              <div className="rounded border border-amber-800/70 bg-amber-950/30 p-3 text-xs text-amber-200/90 leading-relaxed">
                ℹ️ Settings are locked at container startup via{' '}
                <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">
                  IMPORTER_CONFIG_LOCKED=true
                </code>
                . Values shown below reflect active environment configurations and cannot be modified from the UI.
              </div>
            )}

            {/* Mode Selection */}
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-2">Operating Mode</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => setMode('alacarte')}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    mode === 'alacarte'
                      ? 'border-blue-500 bg-blue-950/40 text-blue-100 ring-1 ring-blue-500'
                      : 'border-neutral-700/70 bg-neutral-800/50 text-neutral-300 hover:border-neutral-600'
                  } ${isLocked ? 'cursor-default opacity-80' : ''}`}
                >
                  <div className="font-semibold text-xs flex items-center gap-1.5">
                    <span>🍏</span> ALACarte Direct
                  </div>
                  <p className="text-[11px] text-neutral-400 mt-1 leading-snug">
                    Direct async queue to ALACarte backend.
                  </p>
                </button>

                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => setMode('subsonic')}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    mode === 'subsonic'
                      ? 'border-blue-500 bg-blue-950/40 text-blue-100 ring-1 ring-blue-500'
                      : 'border-neutral-700/70 bg-neutral-800/50 text-neutral-300 hover:border-neutral-600'
                  } ${isLocked ? 'cursor-default opacity-80' : ''}`}
                >
                  <div className="font-semibold text-xs flex items-center gap-1.5">
                    <span>⚡</span> Subsonic API
                  </div>
                  <p className="text-[11px] text-neutral-400 mt-1 leading-snug">
                    Octo-Fiesta / Navidrome. Downloads 1 track at a time.
                  </p>
                </button>
              </div>
            </div>

            {/* Mode Specific Inputs */}
            {mode === 'alacarte' ? (
              <div className="space-y-3 pt-1 border-t border-neutral-800">
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">Main Backend URL</label>
                  <input
                    type="text"
                    disabled={isLocked}
                    value={backendUrl}
                    onChange={(e) => setBackendUrl(e.target.value)}
                    placeholder="http://web:7373"
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">
                    Internal API Key {config?.alacarte.hasKey && <span className="text-emerald-400 font-mono">(Configured)</span>}
                  </label>
                  <input
                    type="password"
                    disabled={isLocked}
                    value={internalApiKey}
                    onChange={(e) => setInternalApiKey(e.target.value)}
                    placeholder={config?.alacarte.hasKey ? '•••••••• (leave blank to keep unchanged)' : 'Enter INTERNAL_API_KEY'}
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3 pt-1 border-t border-neutral-800">
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">Subsonic Server URL</label>
                  <input
                    type="text"
                    disabled={isLocked}
                    value={subsonicUrl}
                    onChange={(e) => setSubsonicUrl(e.target.value)}
                    placeholder="http://octo-fiesta:8080"
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">Username</label>
                    <input
                      type="text"
                      disabled={isLocked}
                      value={subsonicUsername}
                      onChange={(e) => setSubsonicUsername(e.target.value)}
                      placeholder="Username"
                      className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">
                      Password {config?.subsonic.hasPassword && <span className="text-emerald-400 font-mono">(Configured)</span>}
                    </label>
                    <input
                      type="password"
                      disabled={isLocked}
                      value={subsonicPassword}
                      onChange={(e) => setSubsonicPassword(e.target.value)}
                      placeholder={config?.subsonic.hasPassword ? '•••••••• (keep existing)' : 'Enter password'}
                      className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">Download Trigger Endpoint</label>
                  <select
                    disabled={isLocked}
                    value={subsonicDownloadEndpoint}
                    onChange={(e) => setSubsonicDownloadEndpoint(e.target.value)}
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60"
                  >
                    <option value="rest/stream.view">rest/stream.view (Required for Octo-Fiesta on-demand downloads)</option>
                    <option value="rest/download.view">rest/download.view (Standard Subsonic download)</option>
                  </select>
                </div>
              </div>
            )}

            {/* Query Pacing Section */}
            <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="search-interval-input" className="block text-xs font-medium text-neutral-300">
                  Search Query Interval (ms)
                </label>
                {config?.intervalLocked && (
                  <span className="text-[10px] text-amber-400 flex items-center gap-1 font-mono">
                    🔒 Locked
                  </span>
                )}
              </div>
              <input
                id="search-interval-input"
                type="number"
                min={100}
                step={100}
                disabled={isLocked || Boolean(config?.intervalLocked)}
                value={searchIntervalMs}
                onChange={(e) => setSearchIntervalMs(Math.max(100, Number(e.target.value) || 100))}
                className="w-full rounded bg-neutral-800 border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:ring-2 focus:ring-blue-600 disabled:opacity-60 font-mono"
              />
              <p className="text-[11px] text-neutral-400 leading-snug">
                Minimum start-to-start interval between search queries. Prevents Apple Music edge CDN 429 rate limit bans. Any backend or network latency is counted towards this interval.
              </p>
            </div>

            {/* Test result feedback */}
            {testResult && (
              <div
                className={`rounded p-2.5 text-xs border ${
                  testResult.ok
                    ? 'bg-emerald-950/40 border-emerald-800/80 text-emerald-200'
                    : 'bg-rose-950/40 border-rose-800/80 text-rose-200'
                }`}
              >
                <div className="font-medium flex items-center gap-1.5">
                  <span>{testResult.ok ? '✓' : '✗'}</span>
                  <span>{testResult.ok ? 'Connection successful!' : 'Connection test failed'}</span>
                </div>
                {testResult.serverType && (
                  <p className="text-[11px] text-emerald-300/80 mt-0.5">
                    Server: {testResult.serverType} {testResult.serverVersion} (v{testResult.version})
                  </p>
                )}
                {testResult.error && (
                  <p className="text-[11px] text-rose-300/90 mt-0.5">{testResult.error}</p>
                )}
              </div>
            )}

            {saveError && (
              <p className="text-xs text-rose-400">{saveError}</p>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-neutral-800">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors disabled:opacity-50"
              >
                {testing ? 'Testing…' : '⟳ Test Connection'}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  {isLocked ? 'Close' : 'Cancel'}
                </button>

                {!isLocked && (
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded bg-blue-600 hover:bg-blue-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50 shadow-sm"
                  >
                    {saving ? 'Saving…' : 'Save & Apply'}
                  </button>
                )}
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
