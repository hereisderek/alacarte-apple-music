declare global {
  interface Window {
    __BASE_PATH__?: string
  }
}

// Support runtime-injected window.__BASE_PATH__ or build-time import.meta.env.BASE_URL
function getBase(): string {
  if (typeof window !== 'undefined' && window.__BASE_PATH__) {
    const p = window.__BASE_PATH__.trim()
    return p.endsWith('/') ? p : `${p}/`
  }
  const base = import.meta.env.BASE_URL || './'
  return base.endsWith('/') ? base : `${base}/`
}

function apiUrl(path: string) {
  return `${getBase()}api/${path.replace(/^\/+/, '')}`
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

// A search result. Which of the optional fields are set depends on the source: the ALACarte
// backend gives duration, ISRC and artwork; a Subsonic server also reports the file's
// format, bit rate, size and so on.
export type SongCandidate = {
  id: string
  name: string
  artistName: string
  albumId: string | null
  albumName?: string | null
  artistId?: string | null
  artworkTemplate?: string | null
  durationMs?: number | null
  isrc?: string | null
  bitRate?: number | null
  suffix?: string | null
  contentType?: string | null
  sizeBytes?: number | null
  year?: number | null
  genre?: string | null
  trackNumber?: number | null
  discNumber?: number | null
  samplingRate?: number | null
  bitDepth?: number | null
  channelCount?: number | null
  // ALACarte backend (Apple catalog): quality tiers that exist for the track, not a bit rate
  audioTraits?: string[]
  explicit?: boolean
  releaseDate?: string | null
  genreNames?: string[]
  hasLyrics?: boolean
  isAppleDigitalMaster?: boolean
}

// Where a track came from: a link's platform (and the link), or pasted text.
export type ItemSource = { kind: string; label: string; url?: string }

export type ImportSource = ItemSource & { count: number }

// What the backend's download job reports (ALACarte mode).
export type ItemJob = {
  status: string | null
  progress: number | null
  quality: string | null
  variant: string | null
  currentTrack: string | null
  message: string | null
  finalDir: string | null
  unavailable: boolean
}

export type ItemStatus = 'pending' | 'waiting' | 'downloading' | 'queued' | 'done' | 'failed' | 'notfound'

export type ImportItem = {
  index: number
  raw: string
  parsedTitle: string
  parsedArtists: string[]
  status: ItemStatus
  queuePosition?: number | null
  candidates: SongCandidate[]
  chosenSongId: string | null
  chosenName: string | null
  chosenArtist: string | null
  downloadJobId: string | null
  message: string | null
  error: string | null
  isrc?: string | null
  source?: ItemSource | null
  matchedBy?: 'isrc' | 'search' | 'search-swapped' | 'title-only' | 'manual' | null
  matchedQuery?: string | null
  candidateCount?: number
  chosen?: SongCandidate | null
  inLibrary?: boolean
  job?: ItemJob | null
  matchedAt?: number | null
  finishedAt?: number | null
}

export type ImportCounts = {
  total: number
  processed?: number
  added?: number
  pending: number
  waiting?: number
  downloading?: number
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
  queuePosition?: number
  otherSongsAhead?: number
  counts: ImportCounts
  items: ImportItem[]
  sources?: ImportSource[]
  warnings?: string[]
}

export type FailedPort = {
  name: string
  port: number
  error: string
  friendlyError?: string
}

export type ServerStatus = {
  mode?: 'alacarte' | 'subsonic'
  connected: boolean
  ok: boolean
  error?: string | null
  subsonic?: {
    ok: boolean
    version?: string
    serverType?: string
    serverVersion?: string
    openSubsonic?: boolean
  }
  wrapper?: {
    ok: boolean
    host?: string
    failedPorts?: FailedPort[]
  }
  appleToken?: {
    ok: boolean
    error?: string | null
  }
  queue: {
    running: number
    queued: number
    activeSong?: string | null
  }
}

export type ImporterConfig = {
  mode: 'alacarte' | 'subsonic'
  locked: boolean
  searchIntervalMs?: number
  intervalLocked?: boolean
  alacarte: {
    backendUrl: string
    hasKey: boolean
  }
  subsonic: {
    url: string
    username: string
    hasPassword: boolean
    downloadEndpoint: string
  }
}

export type UpdateConfigPayload = {
  mode?: 'alacarte' | 'subsonic'
  searchIntervalMs?: number
  alacarte?: {
    backendUrl?: string
    internalApiKey?: string
  }
  subsonic?: {
    url?: string
    username?: string
    password?: string
    downloadEndpoint?: string
  }
}

export type TestConfigResult = {
  connected: boolean
  ok: boolean
  error?: string | null
  version?: string
  serverType?: string
  serverVersion?: string
  openSubsonic?: boolean
  wrapper?: { ok: boolean }
  appleToken?: { ok: boolean }
}

export const api = {
  authState: () => http<{ authEnabled: boolean }>('auth/state'),
  serverStatus: () => http<ServerStatus>('status'),
  getConfig: () => http<ImporterConfig>('config'),
  saveConfig: (payload: UpdateConfigPayload) =>
    http<ImporterConfig>('config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  testConfig: (payload: { mode: 'alacarte' | 'subsonic'; alacarte?: any; subsonic?: any }) =>
    http<TestConfigResult>('config/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
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
    chosen: {
      songId: string
      albumId?: string | null
      name: string
      artistName: string
      details?: SongCandidate
    },
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
