import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  subscribeToSession,
  HttpError,
  type ImportItem,
  type ImportSession,
  type ServerStatus,
  type SongCandidate,
} from './api'

const STATUS_LABEL: Record<ImportItem['status'], string> = {
  pending: 'Searching…',
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
  notfound: 'Not found',
}

const STATUS_CLASS: Record<ImportItem['status'], string> = {
  pending: 'bg-neutral-700 text-neutral-200',
  queued: 'bg-blue-900 text-blue-200',
  done: 'bg-green-900 text-green-200',
  failed: 'bg-red-900 text-red-200',
  notfound: 'bg-amber-900 text-amber-200',
}

export const IMPORTER_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '简体中文 (Simplified Chinese)' },
  { code: 'zh-hant', label: '繁體中文 (Traditional Chinese)' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'fr', label: 'Français (French)' },
]

export function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[2]) : null
}

export function setCookie(name: string, value: string, days = 365) {
  if (typeof document === 'undefined') return
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`
}

export function detectDefaultLanguage(): string {
  const saved = getCookie('importer_language')
  if (saved && IMPORTER_LANGUAGES.some((l) => l.code === saved)) {
    return saved
  }
  const browserLangs =
    typeof navigator !== 'undefined' && navigator.languages?.length
      ? navigator.languages
      : typeof navigator !== 'undefined' && navigator.language
        ? [navigator.language]
        : []
  for (const raw of browserLangs) {
    const l = String(raw || '').toLowerCase()
    if (l.startsWith('zh-tw') || l.startsWith('zh-hk') || l.startsWith('zh-hant') || l.startsWith('zh-mo')) {
      return 'zh-hant'
    }
    if (l.startsWith('zh')) return 'zh'
    if (l.startsWith('ja')) return 'ja'
    if (l.startsWith('ko')) return 'ko'
    if (l.startsWith('es')) return 'es'
    if (l.startsWith('fr')) return 'fr'
    if (l.startsWith('en')) return 'en'
  }
  return 'en'
}

export default function App() {
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)

  useEffect(() => {
    api
      .authState()
      .then((s) => {
        setAuthEnabled(s.authEnabled)
        setLoggedIn(!s.authEnabled)
      })
      .catch(() => setAuthEnabled(false))
  }, [])

  if (authEnabled === null) return <Centered>Loading…</Centered>
  if (authEnabled && !loggedIn) return <LoginForm onLoggedIn={() => setLoggedIn(true)} />
  return <ImporterApp />
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center text-neutral-400">{children}</div>
  )
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(username, password)
      onLoggedIn()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 p-6">
        <h1 className="text-xl font-semibold text-center mb-4">Music Import</h1>
        <input
          className="w-full rounded bg-neutral-800 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-600"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          className="w-full rounded bg-neutral-800 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-600"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 py-2 font-medium hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

function ServerStatusIndicator({
  status,
  loading,
  onRefresh,
}: {
  status: ServerStatus | null
  loading: boolean
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  let tone: 'green' | 'amber' | 'red' | 'gray' = 'gray'
  let label = 'Checking…'

  if (loading && !status) {
    tone = 'gray'
    label = 'Checking…'
  } else if (!status || !status.connected) {
    tone = 'red'
    label = 'Backend Down'
  } else if (!status.wrapper?.ok) {
    tone = 'red'
    label = 'Wrapper Offline'
  } else if (!status.appleToken?.ok) {
    tone = 'amber'
    label = 'Apple Token Expired'
  } else if (status.ok) {
    tone = 'green'
    label = 'Ready'
  } else {
    tone = 'amber'
    label = 'Degraded'
  }

  const dotColor = {
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-rose-500',
    gray: 'bg-neutral-500',
  }[tone]

  const pingColor = {
    green: 'bg-emerald-400',
    amber: 'bg-amber-400',
    red: 'bg-rose-400',
    gray: 'bg-neutral-400',
  }[tone]

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-2 rounded-full bg-neutral-800/90 hover:bg-neutral-800 border border-neutral-700/80 px-2.5 py-1 text-xs font-medium text-neutral-300 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-600/50"
        title="Click to view server status details"
      >
        <span className="relative flex h-2 w-2">
          {tone === 'green' && (
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingColor}`}
            />
          )}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
        </span>
        <span>{label}</span>
        <span className="text-[10px] text-neutral-400">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 mt-2 w-72 rounded-lg bg-neutral-900 border border-neutral-700/80 p-3.5 shadow-xl text-xs z-50 animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-neutral-800 text-neutral-200">
            <span className="font-semibold text-neutral-100">Server Status</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRefresh()
              }}
              disabled={loading}
              className="text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
              title="Refresh status"
            >
              ⟳ Refresh
            </button>
          </div>

          <div className="space-y-2 text-neutral-300">
            <div className="flex items-center justify-between">
              <span className="text-neutral-400">Main Backend:</span>
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    status?.connected ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}
                />
                {status?.connected ? 'Connected' : 'Unreachable'}
              </span>
            </div>

            <div className="flex items-start justify-between">
              <span className="text-neutral-400">FairPlay Wrapper:</span>
              <div className="text-right">
                <span className="flex items-center justify-end gap-1.5 font-medium">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      status?.wrapper?.ok ? 'bg-emerald-500' : 'bg-rose-500'
                    }`}
                  />
                  {status?.wrapper?.ok ? 'Ready (3/3 ports)' : 'Offline'}
                </span>
                {status?.wrapper?.failedPorts && status.wrapper.failedPorts.length > 0 && (
                  <div className="text-[11px] text-rose-400 mt-0.5 max-w-[170px] leading-tight">
                    {status.wrapper.failedPorts.map((p) => (
                      <div key={p.name}>
                        {p.name}: {p.friendlyError || p.error}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-neutral-400">Apple Music Session:</span>
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    status?.appleToken?.ok ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                {status?.appleToken?.ok ? 'Active' : 'Unauthenticated'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-neutral-400">Download Queue:</span>
              <span className="font-medium text-neutral-300">
                {status ? `${status.queue.running} active, ${status.queue.queued} queued` : '—'}
              </span>
            </div>
          </div>

          {status && (!status.connected || !status.wrapper?.ok) && (
            <div className="mt-3 pt-2.5 border-t border-neutral-800 text-[11px] text-rose-300/90 leading-snug">
              ⚠️ Downloads will fail while the FairPlay decryption wrapper is unreachable.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ImporterApp() {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState<string>(() => detectDefaultLanguage())
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [session, setSession] = useState<ImportSession | null>(null)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)

  const fetchStatus = useCallback(() => {
    setStatusLoading(true)
    api
      .serverStatus()
      .then((s) => setServerStatus(s))
      .catch((err) => {
        setServerStatus({
          connected: false,
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to reach server',
          wrapper: { ok: false },
          appleToken: { ok: false },
          queue: { running: 0, queued: 0 },
        })
      })
      .finally(() => setStatusLoading(false))
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      fetchStatus()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  function handleLanguageChange(newLang: string) {
    setLanguage(newLang)
    setCookie('importer_language', newLang)
  }

  useEffect(() => {
    if (!session) return
    return subscribeToSession(session.id, setSession)
  }, [session?.id])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setSubmitting(true)
    setFormError(null)
    try {
      const { session: created } = await api.submitImport({
        text,
        title: title.trim() || undefined,
        language,
      })
      setSession(created)
    } catch (err) {
      setFormError(err instanceof HttpError ? err.message : 'import failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <header>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">Music Import</h1>
            <ServerStatusIndicator
              status={serverStatus}
              loading={statusLoading}
              onRefresh={fetchStatus}
            />
          </div>
          <p className="text-neutral-400 text-sm mt-1">
            Paste a song list (one per line, search terms, or "Title - Artist") or playlist links from NetEase (163.com),
            YouTube Music, Spotify, Qishui, KKBOX, or supported chart sites.
          </p>
        </header>
        <div className="shrink-0 flex items-center gap-2 self-start sm:self-auto">
          <label htmlFor="language-select" className="text-sm text-neutral-400">
            Language:
          </label>
          <select
            id="language-select"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            className="rounded bg-neutral-800 border border-neutral-700 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:ring-2 focus:ring-blue-600"
          >
            {IMPORTER_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-neutral-900">
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {serverStatus && (!serverStatus.connected || !serverStatus.wrapper?.ok) && (
        <div className="rounded border border-rose-800/80 bg-rose-950/40 p-3.5 text-sm text-rose-200 flex items-start gap-2.5">
          <span className="text-base select-none">⚠️</span>
          <div>
            <p className="font-medium">
              {!serverStatus.connected
                ? 'Main backend is unreachable'
                : 'FairPlay decryption wrapper is unreachable'}
            </p>
            <p className="text-xs text-rose-300/80 mt-0.5">
              {!serverStatus.connected
                ? 'Check that the alacarte-web container is running on the network.'
                : 'Downloads will fail until the alacarte-wrapper container is running on the same network.'}
            </p>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <textarea
          className="w-full h-40 rounded bg-neutral-800 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-600 font-mono text-sm"
          placeholder={
            '七里香 - 周杰倫\n甜甜的-周杰倫\n时光机\n\nor playlist links like:\nhttps://music.163.com/m/playlist?id=...\nhttps://music.youtube.com/playlist?list=...'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <input
          className="w-full rounded bg-neutral-800 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-600"
          placeholder="Playlist title (used when the source has no title of its own)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {formError && <p className="text-sm text-red-400">{formError}</p>}
        <button
          type="submit"
          disabled={submitting || !text.trim()}
          className="rounded bg-blue-600 px-4 py-2 font-medium hover:bg-blue-500 disabled:opacity-50"
        >
          {submitting ? 'Starting…' : 'Import'}
        </button>
      </form>

      {session && (
        <SessionView
          session={session}
          onSessionUpdate={setSession}
          language={language}
        />
      )}
    </div>
  )
}

function SessionView({
  session,
  onSessionUpdate,
  language,
}: {
  session: ImportSession
  onSessionUpdate: (s: ImportSession) => void
  language?: string
}) {
  const activeLanguage = session.language || language
  const needsReview = useMemo(
    () => session.items.filter((i) => i.status === 'notfound'),
    [session.items],
  )

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{session.title}</h2>
        <Summary counts={session.counts} />
      </div>

      {session.warnings && session.warnings.length > 0 && (
        <div className="space-y-2">
          {session.warnings.map((w, idx) => (
            <div
              key={idx}
              className="rounded border border-amber-800/80 bg-amber-950/40 p-3 text-sm text-amber-200"
            >
              {w}
            </div>
          ))}
        </div>
      )}

      {needsReview.length > 0 && (
        <div className="rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          {needsReview.length} track{needsReview.length === 1 ? '' : 's'} need a manual pick below.
        </div>
      )}

      <ul className="divide-y divide-neutral-800 rounded border border-neutral-800">
        {session.items.map((item) => (
          <ItemRow
            key={item.index}
            item={item}
            sessionId={session.id}
            language={activeLanguage}
            onResolved={(updated) => onSessionUpdate(updated)}
          />
        ))}
      </ul>
    </section>
  )
}

function Summary({ counts }: { counts: ImportSession['counts'] }) {
  const processed = counts.processed ?? counts.total - counts.pending
  const added = counts.added ?? counts.queued + counts.done

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-mono bg-neutral-800 text-neutral-200 border border-neutral-700 rounded-full px-2.5 py-1">
        {processed}/{added} (total: {counts.total})
      </span>
      <Pill label={`${counts.done} done`} className="bg-green-900 text-green-200" />
      <Pill label={`${counts.queued} queued`} className="bg-blue-900 text-blue-200" />
      {counts.failed > 0 && <Pill label={`${counts.failed} failed`} className="bg-red-900 text-red-200" />}
      {counts.notfound > 0 && (
        <Pill label={`${counts.notfound} to review`} className="bg-amber-900 text-amber-200" />
      )}
    </div>
  )
}

function Pill({ label, className }: { label: string; className: string }) {
  return <span className={`rounded-full px-2 py-1 ${className}`}>{label}</span>
}

function ItemRow({
  item,
  sessionId,
  language,
  onResolved,
}: {
  item: ImportItem
  sessionId: string
  language?: string
  onResolved: (session: ImportSession) => void
}) {
  const [open, setOpen] = useState(false)
  const needsReview = item.status === 'notfound'

  return (
    <li className="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{item.parsedTitle || item.raw}</p>
          <p className="truncate text-sm text-neutral-400">
            {item.chosenArtist || item.parsedArtists.join(', ') || '—'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`rounded-full px-2 py-1 text-xs ${STATUS_CLASS[item.status]}`}>
            {item.status === 'notfound' && item.candidates?.length > 0
              ? 'To review'
              : STATUS_LABEL[item.status]}
          </span>
          {needsReview && (
            <button
              className="text-xs text-blue-400 hover:text-blue-300"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide' : 'Review'}
            </button>
          )}
        </div>
      </div>
      {item.error && <p className="mt-1 text-xs text-red-400">{item.error}</p>}
      {open && needsReview && (
        <ReviewPicker
          item={item}
          sessionId={sessionId}
          language={language}
          onResolved={onResolved}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  )
}

function ReviewPicker({
  item,
  sessionId,
  language,
  onResolved,
  onClose,
}: {
  item: ImportItem
  sessionId: string
  language?: string
  onResolved: (session: ImportSession) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(`${item.parsedTitle} ${item.parsedArtists.join(' ')}`.trim())
  const [results, setResults] = useState<SongCandidate[]>(item.candidates)
  const [searching, setSearching] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function search(e: React.FormEvent) {
    e.preventDefault()
    setSearching(true)
    setError(null)
    try {
      const { songs } = await api.manualSearch(query, language)
      setResults(songs)
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'search failed')
    } finally {
      setSearching(false)
    }
  }

  async function pick(candidate: SongCandidate) {
    setPicking(candidate.id)
    setError(null)
    try {
      const { session } = await api.selectCandidate(sessionId, item.index, {
        songId: candidate.id,
        albumId: candidate.albumId,
        name: candidate.name,
        artistName: candidate.artistName,
      })
      onResolved(session)
      onClose()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'could not queue that track')
    } finally {
      setPicking(null)
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded bg-neutral-900 p-3">
      <form onSubmit={search} className="flex gap-2">
        <input
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-600"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="submit"
          disabled={searching}
          className="rounded bg-neutral-700 px-3 py-1 text-sm hover:bg-neutral-600 disabled:opacity-50"
        >
          Search
        </button>
      </form>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <ul className="space-y-1">
        {results.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded bg-neutral-800 px-2 py-1">
            <div className="min-w-0">
              <p className="truncate text-sm">{c.name}</p>
              <p className="truncate text-xs text-neutral-400">{c.artistName}</p>
            </div>
            <button
              disabled={picking === c.id}
              onClick={() => pick(c)}
              className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500 disabled:opacity-50"
            >
              {picking === c.id ? 'Queuing…' : 'Use this'}
            </button>
          </li>
        ))}
        {results.length === 0 && <p className="text-sm text-neutral-500">No results yet.</p>}
      </ul>
    </div>
  )
}
