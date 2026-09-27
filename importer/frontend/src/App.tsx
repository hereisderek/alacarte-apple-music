import { useEffect, useMemo, useState } from 'react'

import {
  api,
  subscribeToSession,
  HttpError,
  type ImportItem,
  type ImportSession,
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

function ImporterApp() {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [session, setSession] = useState<ImportSession | null>(null)

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
      const { session: created } = await api.submitImport({ text, title: title.trim() || undefined })
      setSession(created)
    } catch (err) {
      setFormError(err instanceof HttpError ? err.message : 'import failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen max-w-3xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Music Import</h1>
        <p className="text-neutral-400 text-sm mt-1">
          Paste a song list (one "Title - Artist" per line) or a playlist link from Spotify, Qishui,
          KKBOX, or a supported chart site.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-3">
        <textarea
          className="w-full h-40 rounded bg-neutral-800 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-600 font-mono text-sm"
          placeholder={'七里香 - 周杰倫\n晴天 - 周杰倫\n\nor a link like https://open.spotify.com/playlist/...'}
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

      {session && <SessionView session={session} onSessionUpdate={setSession} />}
    </div>
  )
}

function SessionView({
  session,
  onSessionUpdate,
}: {
  session: ImportSession
  onSessionUpdate: (s: ImportSession) => void
}) {
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
            onResolved={(updated) => onSessionUpdate(updated)}
          />
        ))}
      </ul>
    </section>
  )
}

function Summary({ counts }: { counts: ImportSession['counts'] }) {
  return (
    <div className="flex gap-2 text-xs">
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
  onResolved,
}: {
  item: ImportItem
  sessionId: string
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
            {STATUS_LABEL[item.status]}
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
        <ReviewPicker item={item} sessionId={sessionId} onResolved={onResolved} onClose={() => setOpen(false)} />
      )}
    </li>
  )
}

function ReviewPicker({
  item,
  sessionId,
  onResolved,
  onClose,
}: {
  item: ImportItem
  sessionId: string
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
      const { songs } = await api.manualSearch(query)
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
