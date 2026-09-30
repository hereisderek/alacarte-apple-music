import path from 'node:path'

import {
  artworkUrl,
  getAlbum,
  getArtist,
  getPlaylist,
  getSong,
  isReleasedTrack,
  iterateCatalogPlaylistTracks,
  searchCatalog,
} from './appleApi.mjs'
import {
  findSongPathInLibrary,
  getMusicRoot,
  hasAlbumInLibrary,
  invalidateLibraryCache,
  scanLibraryOnce,
} from './libraryIndex.mjs'
import { enqueueSong, getJob, notReleasedError } from './queue.mjs'
import { readSettings } from './settingsStore.mjs'

// Flat shapes for the octo-fiesta Apple Music provider. Artwork is returned
// as ready URLs so the provider never deals with Apple's {w}x{h} templates.

function art(template) {
  return template
    ? { artworkUrl: artworkUrl(template, 600), artworkUrlLarge: artworkUrl(template, 1400) }
    : { artworkUrl: null, artworkUrlLarge: null }
}

function albumIdFromUrl(url) {
  const m = String(url || '').match(/\/album\/[^/]*\/(\d+)/)
  return m ? m[1] : null
}

function year(date) {
  return date ? Number(String(date).slice(0, 4)) || null : null
}

export function mapSong(raw, album = null) {
  const a = raw?.attributes || {}
  const albumRel = raw?.relationships?.albums?.data?.[0]
  const artistRel = raw?.relationships?.artists?.data?.[0]
  return {
    id: String(raw.id),
    title: a.name || '',
    artist: a.artistName || '',
    artistId: artistRel?.id ? String(artistRel.id) : null,
    album: album?.title || a.albumName || '',
    albumId: album?.id || (albumRel?.id ? String(albumRel.id) : albumIdFromUrl(a.url)),
    albumArtist: album?.artist || albumRel?.attributes?.artistName || null,
    track: a.trackNumber ?? null,
    disc: a.discNumber ?? null,
    durationMs: a.durationInMillis ?? null,
    isrc: a.isrc || null,
    year: year(a.releaseDate),
    releaseDate: a.releaseDate || null,
    genre: (a.genreNames || []).find((g) => g !== 'Music') || null,
    composer: a.composerName || null,
    explicit: a.contentRating === 'explicit',
    ...(album ? { artworkUrl: album.artworkUrl, artworkUrlLarge: album.artworkUrlLarge } : art(a.artwork?.url)),
  }
}

export function mapAlbum(raw) {
  const a = raw?.attributes || {}
  const artistRel = raw?.relationships?.artists?.data?.[0]
  return {
    id: String(raw.id),
    title: a.name || '',
    artist: a.artistName || '',
    artistId: artistRel?.id ? String(artistRel.id) : null,
    year: year(a.releaseDate),
    trackCount: a.trackCount ?? null,
    genre: (a.genreNames || []).find((g) => g !== 'Music') || null,
    releaseType: a.isSingle ? 'single' : a.isCompilation ? 'compilation' : 'album',
    upc: a.upc || null,
    label: a.recordLabel || null,
    copyright: a.copyright || null,
    ...art(a.artwork?.url),
  }
}

export function mapArtist(raw) {
  const a = raw?.attributes || {}
  return { id: String(raw.id), name: a.name || '', ...art(a.artwork?.url) }
}

export function mapPlaylist(raw) {
  const a = raw?.attributes || {}
  return {
    id: String(raw.id),
    name: a.name || '',
    curator: a.curatorName || null,
    description: a.description?.standard || a.description?.short || null,
    trackCount: a.trackCount ?? null,
    ...art(a.artwork?.url),
  }
}

async function context() {
  const settings = await readSettings()
  return { storefront: settings.storefront || 'us', language: settings.language || 'en-US', settings }
}

export async function searchAll(term, { songs = 20, albums = 20, artists = 20, playlists = 0 } = {}) {
  const { storefront, language } = await context()
  const clamp = (n) => Math.max(0, Math.min(25, Number(n) || 0))
  const types = [
    clamp(songs) && 'songs',
    clamp(albums) && 'albums',
    clamp(artists) && 'artists',
    clamp(playlists) && 'playlists',
  ].filter(Boolean)
  if (!term || types.length === 0) return { songs: [], albums: [], artists: [], playlists: [] }
  const limit = Math.max(clamp(songs), clamp(albums), clamp(artists), clamp(playlists))
  const json = await searchCatalog({ storefront, term, types: types.join(','), limit, language, withRelationships: true })
  const r = json?.results || {}
  const index = await scanLibraryOnce()
  const songResults = await Promise.all(
    (r.songs?.data || []).filter(isReleasedTrack).slice(0, clamp(songs)).map(async (x) => {
      const song = mapSong(x)
      return { ...song, inLibrary: Boolean(await findInLibrary(song, index)) }
    }),
  )
  return {
    songs: songResults,
    albums: await Promise.all(
      (r.albums?.data || []).slice(0, clamp(albums)).map(async (x) => {
        const album = mapAlbum(x)
        return { ...album, inLibrary: await hasAlbumInLibrary(album.artist, album.title, index, album.upc) }
      }),
    ),
    artists: (r.artists?.data || []).slice(0, clamp(artists)).map(mapArtist),
    playlists: (r.playlists?.data || []).slice(0, clamp(playlists)).map(mapPlaylist),
  }
}

// Unreleased tracks of a pre-release album are left out everywhere octo-fiesta
// looks, so it never offers a song that cannot be downloaded yet.
async function releasedSong(id) {
  const { storefront, language } = await context()
  const raw = (await getSong({ storefront, id, language }))?.data?.[0]
  if (!raw) return null
  if (!isReleasedTrack(raw)) {
    const albumId = raw.relationships?.albums?.data?.[0]?.id
    const album = albumId ? (await getAlbum({ storefront, id: albumId, language }))?.data?.[0] : null
    const err = notReleasedError(album?.attributes?.releaseDate)
    err.status = 404
    throw err
  }
  return raw
}

export async function songById(id) {
  const raw = await releasedSong(id)
  return raw ? mapSong(raw) : null
}

export async function albumById(id) {
  const { storefront, language } = await context()
  const raw = (await getAlbum({ storefront, id, language }))?.data?.[0]
  if (!raw) return null
  const album = mapAlbum(raw)
  const tracks = (raw.relationships?.tracks?.data || [])
    .filter((t) => t.type === 'songs' && isReleasedTrack(t))
    .map((t) => mapSong(t, album))
  return { ...album, tracks }
}

export async function artistById(id) {
  const { storefront, language } = await context()
  const raw = (await getArtist({ storefront, id, language }))?.data?.[0]
  if (!raw) return null
  const albums = (raw.relationships?.albums?.data || [])
    .filter((x) => x.attributes)
    .map(mapAlbum)
  return { ...mapArtist(raw), albums }
}

export async function playlistById(id) {
  const { storefront, language } = await context()
  const raw = (await getPlaylist({ storefront, id, language }))?.data?.[0]
  if (!raw) return null
  const tracks = []
  for await (const t of iterateCatalogPlaylistTracks({ storefront, id, language })) {
    if (t?.type === 'songs' && t.attributes && isReleasedTrack(t)) tracks.push(mapSong(t))
  }
  return { ...mapPlaylist(raw), trackCount: tracks.length, tracks }
}

async function findInLibrary(song, index = null) {
  const abs = await findSongPathInLibrary(
    song.albumArtist || song.artist,
    song.title,
    song.isrc,
    index,
    { album: song.album },
  )
  return abs ? path.relative(getMusicRoot(), abs) : null
}

const JOB_POLL_MS = 1000

// Returns the song's library-relative path, downloading it through the
// normal queue first when it is not in the library yet.
export async function ensureSongInLibrary(id, { timeoutMs = 15 * 60_000, pollMs = JOB_POLL_MS } = {}) {
  let song
  try {
    song = await songById(id)
  } catch (err) {
    if (err.code === 'NOT_RELEASED') err.status = 409
    throw err
  }
  if (!song) {
    const err = new Error('song not found in the Apple Music catalog')
    err.status = 404
    throw err
  }
  const existing = await findInLibrary(song)
  if (existing) return { status: 'existing', path: existing, song }

  const { storefront } = await context()
  let job
  try {
    job = await enqueueSong({ songId: song.id, albumId: song.albumId, storefront })
  } catch (err) {
    if (err?.code !== 'ALREADY_IN_LIBRARY') throw err
    invalidateLibraryCache()
    const owned = await findInLibrary(song)
    if (owned) return { status: 'existing', path: owned, song }
    throw err
  }

  const deadline = Date.now() + timeoutMs
  let current = getJob(job.id)
  while (current && current.status !== 'done' && current.status !== 'failed') {
    if (Date.now() > deadline) {
      const err = new Error('timed out waiting for the download')
      err.status = 504
      throw err
    }
    await new Promise((r) => setTimeout(r, pollMs))
    current = getJob(job.id)
  }
  if (!current || current.status === 'failed') {
    const err = new Error(current?.error || 'download failed')
    err.status = 502
    throw err
  }
  invalidateLibraryCache()
  const downloaded = await findInLibrary(song)
  if (!downloaded) {
    const err = new Error('download finished but the file was not found in the library')
    err.status = 502
    throw err
  }
  return { status: 'downloaded', path: downloaded, jobId: job.id, song }
}
