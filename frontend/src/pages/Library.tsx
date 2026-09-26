import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookAudio,
  FileText,
  Music2,
  Disc3,
  RefreshCw,
  Trash2,
  AlertCircle,
  Search,
  ListFilter,
  ListOrdered,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api, type LibraryAlbum, type LibraryPlaylist, type LibrarySingle } from '../api/client'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { ResolvedMediaLink } from '../components/ResolvedMediaLink'
import { cx } from '../lib/cx'
import { StaggeredList } from '../components/StaggeredList'
import { useLibraryPresence } from '../hooks/useLibraryPresence'
import { motion, AnimatePresence } from 'framer-motion'

type BusyMap = Record<string, boolean>
type DeleteTarget =
  | { kind: 'album'; item: LibraryAlbum }
  | { kind: 'song'; item: LibrarySingle }
  | { kind: 'playlist'; item: LibraryPlaylist }
  | null

type LibrarySort = 'date-desc' | 'date-asc' | 'name' | 'artist'

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function matchesQuery(query: string, ...fields: Array<string | undefined>) {
  if (!query) return true
  return fields.some((field) => String(field || '').toLowerCase().includes(query))
}

function compareLibraryItems(
  sortBy: LibrarySort,
  a: { name: string; artist: string; addedAt?: number },
  b: { name: string; artist: string; addedAt?: number },
) {
  if (sortBy === 'date-desc') {
    return (
      (b.addedAt || 0) - (a.addedAt || 0) ||
      compareText(a.artist, b.artist) ||
      compareText(a.name, b.name)
    )
  }
  if (sortBy === 'date-asc') {
    return (
      (a.addedAt || 0) - (b.addedAt || 0) ||
      compareText(a.artist, b.artist) ||
      compareText(a.name, b.name)
    )
  }
  if (sortBy === 'artist') {
    return compareText(a.artist, b.artist) || compareText(a.name, b.name)
  }
  return compareText(a.name, b.name) || compareText(a.artist, b.artist)
}

function SkeletonCard() {
  return (
    <Card className="flex items-center gap-3 p-3">
      <motion.div
        className="h-10 w-10 rounded-lg bg-white/10"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="flex-1 min-w-0">
        <motion.div
          className="h-4 bg-white/10 rounded w-2/3 mb-2"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
        />
        <motion.div
          className="h-3 bg-white/10 rounded w-1/2"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
        />
      </div>
    </Card>
  )
}

export function LibraryPage() {
  const { t } = useTranslation()
  const [albums, setAlbums] = useState<LibraryAlbum[]>([])
  const [singles, setSingles] = useState<LibrarySingle[]>([])
  const [playlists, setPlaylists] = useState<LibraryPlaylist[]>([])
  const [sortBy, setSortBy] = useState<LibrarySort>('date-desc')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyMap>({})
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)
  const { refreshLibraryPresence } = useLibraryPresence()

  const load = useCallback(async (syncPresence = false) => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.library()
      setAlbums(r.albums)
      setSingles(r.singles)
      setPlaylists(r.playlists || [])
      if (syncPresence) await refreshLibraryPresence()
    } catch (err: any) {
      setError(err?.message || t('library.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [refreshLibraryPresence])

  useEffect(() => {
    load()
  }, [load])

  const totals = useMemo(
    () => ({
      albums: albums.length,
      singles: singles.length,
      playlists: playlists.length,
      lyrics: singles.filter((s) => s.hasLyrics).length,
    }),
    [albums, singles, playlists],
  )

  const normalizedQuery = useMemo(() => query.trim().toLowerCase(), [query])

  const visibleAlbums = useMemo(() => {
    const filtered = albums.filter((a) =>
      matchesQuery(normalizedQuery, a.albumName, a.artistName, a.relPath),
    )
    return [...filtered].sort((a, b) =>
      compareLibraryItems(
        sortBy,
        { name: a.albumName, artist: a.artistName, addedAt: a.addedAt },
        { name: b.albumName, artist: b.artistName, addedAt: b.addedAt },
      ),
    )
  }, [albums, normalizedQuery, sortBy])

  const visibleSingles = useMemo(() => {
    const filtered = singles.filter((s) =>
      matchesQuery(normalizedQuery, s.songName, s.artistName, s.relPath),
    )
    return [...filtered].sort((a, b) =>
      compareLibraryItems(
        sortBy,
        { name: a.songName, artist: a.artistName, addedAt: a.addedAt },
        { name: b.songName, artist: b.artistName, addedAt: b.addedAt },
      ),
    )
  }, [singles, normalizedQuery, sortBy])

  const visiblePlaylists = useMemo(() => {
    const filtered = playlists.filter((p) =>
      matchesQuery(
        normalizedQuery,
        p.playlistName,
        p.fileName,
        p.relPath,
        p.catalogPlaylistId ?? undefined,
        p.libraryPlaylistId ?? undefined,
      ),
    )
    return [...filtered].sort((a, b) =>
      compareLibraryItems(
        sortBy,
        {
          name: a.playlistName,
          artist: a.fileName,
          addedAt: a.addedAt,
        },
        {
          name: b.playlistName,
          artist: b.fileName,
          addedAt: b.addedAt,
        },
      ),
    )
  }, [playlists, normalizedQuery, sortBy])

  const removeSong = (item: LibrarySingle) => {
    setDeleteTarget({ kind: 'song', item })
  }

  const removeAlbum = (item: LibraryAlbum) => {
    setDeleteTarget({ kind: 'album', item })
  }

  const removePlaylist = (item: LibraryPlaylist) => {
    setDeleteTarget({ kind: 'playlist', item })
  }

  const closeDeleteModal = () => {
    setDeleteTarget(null)
  }

  const confirmDelete = () => {
    if (!deleteTarget) return

    const target = deleteTarget
    const targetId = target.item.id

    setError(null)
    setDeleteTarget(null)
    setBusy((prev) => ({ ...prev, [targetId]: true }))

    if (target.kind === 'album') {
      setAlbums((prev) => prev.filter((x) => x.id !== target.item.id))
    } else if (target.kind === 'song') {
      setSingles((prev) => prev.filter((x) => x.id !== target.item.id))
    } else {
      setPlaylists((prev) => prev.filter((x) => x.id !== target.item.id))
    }

    ;(async () => {
      try {
        if (target.kind === 'album') {
          await api.deleteLibraryAlbum(target.item.relPath)
        } else if (target.kind === 'song') {
          await api.deleteLibrarySong(target.item.relPath)
        } else {
          await api.deleteLibraryPlaylist(target.item.relPath)
        }
        await refreshLibraryPresence()
      } catch (err: any) {
        setError(err?.message || t('library.deleteFailed'))
        if (target.kind === 'album') {
          setAlbums((prev) =>
            prev.some((x) => x.id === target.item.id) ? prev : [...prev, target.item as LibraryAlbum],
          )
        } else if (target.kind === 'song') {
          setSingles((prev) =>
            prev.some((x) => x.id === target.item.id) ? prev : [...prev, target.item as LibrarySingle],
          )
        } else {
          setPlaylists((prev) =>
            prev.some((x) => x.id === target.item.id) ? prev : [...prev, target.item as LibraryPlaylist],
          )
        }
      } finally {
        setBusy((prev) => {
          const next = { ...prev }
          delete next[targetId]
          return next
        })
      }
    })()
  }

  return (
    <div className="mx-auto w-full max-w-6xl pt-4 md:pt-6 space-y-6">
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-white/60">
            {t('library.albumCount', { count: totals.albums })} ·{' '}
            {t('library.playlistCount', { count: totals.playlists })} ·{' '}
            {t('library.singleCount', { count: totals.singles })}
          </div>
          <Button onClick={() => load(true)}>
            <RefreshCw className="h-4 w-4" /> {t('library.refresh')}
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div>
            <label htmlFor="library-filter" className="sr-only">
              {t('library.filterLabel')}
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <input
                id="library-filter"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('library.filterPlaceholder')}
                className="h-10 w-full rounded-app border border-white/10 bg-white/[0.03] pl-9 pr-3 text-sm text-white/90 placeholder:text-white/40 transition-colors hover:border-white/20 focus:border-[rgba(var(--accent),0.45)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.2)]"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 md:justify-end md:self-start">
            <label htmlFor="library-sort" className="sr-only">
              {t('library.sortLabel')}
            </label>
            <div className="relative min-w-[210px]">
              <ListFilter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
              <select
                id="library-sort"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as LibrarySort)}
                className="h-10 w-full appearance-none rounded-app border border-white/10 bg-white/[0.03] pl-9 pr-9 text-sm text-white/90 transition-colors hover:border-white/20 focus:border-[rgba(var(--accent),0.45)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.2)]"
              >
                <option value="date-desc">{t('library.sortDateNewest')}</option>
                <option value="date-asc">{t('library.sortDateOldest')}</option>
                <option value="name">{t('library.sortName')}</option>
                <option value="artist">{t('library.sortArtist')}</option>
              </select>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <Badge variant="bad">
          <AlertCircle className="h-4 w-4" /> {error}
        </Badge>
      )}

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="flex flex-col gap-2"
          >
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-6"
          >
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50 mb-3 flex items-center gap-2">
                <Disc3 className="h-4 w-4" /> {t('library.albums')}
              </h2>
              {albums.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">{t('library.noAlbumsFound')}</Card>
              ) : visibleAlbums.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">{t('library.noAlbumsMatch')}</Card>
              ) : (
                <StaggeredList className="flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {visibleAlbums.map((a) => (
                      <motion.div
                        key={a.id}
                        layout="position"
                        initial={{ opacity: 0, scale: 0.996 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.996 }}
                        transition={{
                          layout: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
                          opacity: { duration: 0.14, ease: 'easeOut' },
                          scale: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                        }}
                      >
                      <Card hover className="flex items-center gap-3 p-3">
                        <ResolvedMediaLink
                          kind="album"
                          artistId={a.artistId}
                          artistName={a.artistName}
                          albumName={a.albumName}
                          className="h-10 w-10 rounded-lg bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors"
                        >
                          <BookAudio className="h-5 w-5 text-white/65" />
                        </ResolvedMediaLink>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">
                            <ResolvedMediaLink
                              kind="album"
                              artistId={a.artistId}
                              artistName={a.artistName}
                              albumName={a.albumName}
                              className="hover:text-accent transition-colors"
                            >
                              {a.albumName}
                            </ResolvedMediaLink>
                          </div>
                          <div className="text-xs text-white/55 truncate">
                            <ResolvedMediaLink
                              kind="artist"
                              artistId={a.artistId}
                              artistName={a.artistName}
                              className="hover:text-accent transition-colors"
                            >
                              {a.artistName}
                            </ResolvedMediaLink>{' '}
                            ·{' '}
                            {a.hasLyrics && a.lyricsCount === a.trackCount
                              ? t('library.tracksWithLyrics', { count: a.trackCount })
                              : `${t('library.tracks', { count: a.trackCount })}${a.hasLyrics ? ` · ${t('library.withLyricsCount', { count: a.lyricsCount })}` : ''}`}
                          </div>
                        </div>
                        <Button onClick={() => removeAlbum(a)} disabled={Boolean(busy[a.id])}>
                          <Trash2 className="h-4 w-4" />
                          {busy[a.id] ? t('library.deleting') : t('library.delete')}
                        </Button>
                      </Card>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </StaggeredList>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50 mb-3 flex items-center gap-2">
                <ListOrdered className="h-4 w-4" /> {t('library.playlists')}
              </h2>
              {playlists.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">{t('library.noPlaylistsFound')}</Card>
              ) : visiblePlaylists.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">{t('library.noPlaylistsMatch')}</Card>
              ) : (
                <StaggeredList className="flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {visiblePlaylists.map((p) => (
                      <motion.div
                        key={p.id}
                        layout="position"
                        initial={{ opacity: 0, scale: 0.996 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.996 }}
                        transition={{
                          layout: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
                          opacity: { duration: 0.14, ease: 'easeOut' },
                          scale: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                        }}
                      >
                        <Card hover className="flex items-center gap-3 p-3">
                          <div className="h-10 w-10 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                            <ListOrdered className="h-5 w-5 text-white/65" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{p.playlistName}</div>
                            <div className="text-xs text-white/55 truncate">
                              {t('library.entryCount', { count: p.trackCount })} · {p.fileName}
                            </div>
                          </div>
                          <Button onClick={() => removePlaylist(p)} disabled={Boolean(busy[p.id])}>
                            <Trash2 className="h-4 w-4" />
                            {busy[p.id] ? t('library.deleting') : t('library.delete')}
                          </Button>
                        </Card>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </StaggeredList>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50 mb-3 flex items-center gap-2">
                <Music2 className="h-4 w-4" /> {t('library.singles')}
              </h2>
              {singles.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">{t('library.noSinglesFound')}</Card>
              ) : visibleSingles.length === 0 ? (
                <Card className="p-6 text-sm text-white/55">{t('library.noSinglesMatch')}</Card>
              ) : (
                <StaggeredList className="flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {visibleSingles.map((s) => (
                      <motion.div
                        key={s.id}
                        layout="position"
                        initial={{ opacity: 0, scale: 0.996 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.996 }}
                        transition={{
                          layout: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
                          opacity: { duration: 0.14, ease: 'easeOut' },
                          scale: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
                        }}
                      >
                      <Card hover className="flex items-center gap-3 p-3">
                        <div className="h-10 w-10 rounded-lg bg-white/5 flex items-center justify-center">
                          <Music2 className="h-5 w-5 text-white/65" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{s.songName}</div>
                          <div className="text-xs text-white/55 truncate">
                            <ResolvedMediaLink
                              kind="artist"
                              artistId={s.artistId}
                              artistName={s.artistName}
                              className="hover:text-accent transition-colors"
                            >
                              {s.artistName}
                            </ResolvedMediaLink>
                          </div>
                        </div>
                        <div
                          className={cx(
                            'inline-flex min-h-11 shrink-0 select-none items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium',
                            s.hasLyrics ? 'text-emerald-300' : 'text-white/45',
                          )}
                          title={s.hasLyrics ? t('library.lyricsSidecarAvailable') : t('library.noLyricsSidecar')}
                        >
                          <FileText className="h-3.5 w-3.5" />
                          {s.hasLyrics ? t('library.lyrics') : t('library.noLyrics')}
                        </div>
                        <Button onClick={() => removeSong(s)} disabled={Boolean(busy[s.id])}>
                          <Trash2 className="h-4 w-4" />
                          {busy[s.id] ? t('library.deleting') : t('library.delete')}
                        </Button>
                      </Card>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </StaggeredList>
              )}
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={closeDeleteModal}
        className="max-w-md p-6"
        label={t('library.confirmDeleteLabel')}
        placement="center"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge variant="bad">
              <AlertCircle className="h-3.5 w-3.5" />
              {t('library.confirmDeleteBadge')}
            </Badge>
          </div>

          {deleteTarget?.kind === 'album' ? (
            <>
              <h3 className="text-lg font-semibold leading-tight">
                {t('library.deleteAlbumTitle', { name: deleteTarget.item.albumName })}
              </h3>
              <p className="text-sm text-white/60">
                {t('library.deleteAlbumBody', { artist: deleteTarget.item.artistName })}
              </p>
            </>
          ) : deleteTarget?.kind === 'song' ? (
            <>
              <h3 className="text-lg font-semibold leading-tight">
                {t('library.deleteSongTitle', { name: deleteTarget.item.songName })}
              </h3>
              <p className="text-sm text-white/60">
                {t('library.deleteSongBody')}
              </p>
            </>
          ) : deleteTarget?.kind === 'playlist' ? (
            <>
              <h3 className="text-lg font-semibold leading-tight">
                {t('library.deletePlaylistTitle', { name: deleteTarget.item.playlistName })}
              </h3>
              <p className="text-sm text-white/60">
                {t('library.deletePlaylistBody', { name: deleteTarget.item.playlistName })}
              </p>
            </>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button onClick={closeDeleteModal}>{t('library.cancel')}</Button>
            <Button
              onClick={confirmDelete}
              disabled={!deleteTarget}
              className="border-rose-400/35 bg-rose-500/[0.18] text-rose-300 hover:border-rose-400/50 hover:bg-rose-500/[0.28] hover:text-rose-200"
            >
              {t('library.delete')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
