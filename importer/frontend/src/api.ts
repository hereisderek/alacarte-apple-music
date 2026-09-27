// BASE_URL is Vite's `base` config, always starting and ending with '/' —
// this is what makes the app path-aware (see importer/README.md).
const BASE = import.meta.env.BASE_URL

function apiUrl(path: string) {
  return `${BASE}api/${path.replace(/^\/+/, '')}`
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
    ...init,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError(res.status, data?.error || `request failed (${res.status})`)
  return data as T
}

export type SongCandidate = {
  id: string
  name: string
  artistName: string
  albumId: string | null
  albumName?: string | null
  artworkTemplate?: string | null
}

export type ItemStatus = 'pending' | 'queued' | 'done' | 'failed' | 'notfound'

export type ImportItem = {
  index: number
  raw: string
  parsedTitle: string
  parsedArtists: string[]
  status: ItemStatus
  candidates: SongCandidate[]
  chosenSongId: string | null
  chosenName: string | null
  chosenArtist: string | null
  downloadJobId: string | null
  message: string | null
  error: string | null
}

export type ImportCounts = {
  total: number
  processed?: number
  added?: number
  pending: number
  queued: number
  done: number
  failed: number
  notfound: number
}

export type ImportSession = {
  id: string
  title: string
  language?: string | null
  createdAt: number
  counts: ImportCounts
  items: ImportItem[]
  warnings?: string[]
}

export const api = {
  authState: () => http<{ authEnabled: boolean }>('auth/state'),
  login: (username: string, password: string) =>
    http<{ ok: true }>('auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => http<{ ok: true }>('auth/logout', { method: 'POST' }),
  submitImport: (payload: { text?: string; urls?: string[]; title?: string; language?: string }) =>
    http<{ session: ImportSession }>('import', { method: 'POST', body: JSON.stringify(payload) }),
  getSession: (id: string) => http<{ session: ImportSession }>(`import/${id}`),
  manualSearch: (q: string, language?: string) => {
    const qs = new URLSearchParams({ q })
    if (language) qs.set('language', language)
    return http<{ songs: SongCandidate[] }>(`import/manual-search?${qs.toString()}`)
  },
  selectCandidate: (
    sessionId: string,
    itemIndex: number,
    chosen: { songId: string; albumId?: string | null; name: string; artistName: string },
  ) =>
    http<{ session: ImportSession }>(`import/${sessionId}/select`, {
      method: 'POST',
      body: JSON.stringify({ itemIndex, ...chosen }),
    }),
}

export function subscribeToSession(id: string, onUpdate: (session: ImportSession) => void) {
  const es = new EventSource(apiUrl(`import/${id}/events`))
  es.onmessage = (evt) => {
    try {
      onUpdate(JSON.parse(evt.data))
    } catch {
      /* ignore malformed frame */
    }
  }
  return () => es.close()
}
