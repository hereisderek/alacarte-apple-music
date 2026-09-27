import fsp from 'node:fs/promises'
import path from 'node:path'

import { artworkUrl } from './appleApi.mjs'
import { ensureDir, sanitizeSegment } from './folderLayout.mjs'
import {
    getMusicRoot,
    makeSongKey,
    purgePlaylistExportsSharingIds,
    scanLibraryOnce,
} from './libraryIndex.mjs'
import { normalizeForMatchKey } from './libraryMatchKey.mjs'


// Shared playlist export writer: m3u8 under <music>/Playlists plus an Apple
// cover image sidecar. Used by full playlist downloads and followed-playlist
// syncs alike so both produce the same file conventions.
export async function writePlaylistM3U({
    playlistName,
    playlistId,
    libraryPlaylistId,
    tracks,
    artworkTemplate,
    reuseArtwork = false,
}) {
    const playlistsDir = path.join(getMusicRoot(), 'Playlists')
    await ensureDir(playlistsDir)
    const base = sanitizeSegment(playlistName || 'Playlist')
    const filePath = path.join(playlistsDir, `${base}.m3u8`)

    await purgePlaylistExportsSharingIds(getMusicRoot(), {
        playlistId,
        libraryPlaylistId,
        keepAbsPath: filePath,
    })

    const lines = ['#EXTM3U', `#PLAYLIST:${playlistName || 'Playlist'}`]
    if (playlistId) {
        lines.push(`#ALACARTE_PLAYLIST_ID:${playlistId}`)
    }
    if (libraryPlaylistId) {
        lines.push(`#ALACARTE_LIBRARY_PLAYLIST_ID:${libraryPlaylistId}`)
    }
    for (const absPath of tracks) {
        const rel = path
            .relative(playlistsDir, absPath)
            .split(path.sep)
            .join('/')
        lines.push(rel)
    }
    await fsp.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o664 })

    // Frequent rebuilds (followed-playlist syncs) reuse an existing cover
    // instead of re-fetching the artwork on every write.
    let existingCover = null
    if (reuseArtwork) {
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
            const candidate = path.join(playlistsDir, `${base}${ext}`)
            const stat = await fsp.stat(candidate).catch(() => null)
            if (stat?.isFile()) {
                existingCover = candidate
                break
            }
        }
    }
    if (!existingCover) {
        await unlinkPlaylistImageSidecars(playlistsDir, base)
        if (artworkTemplate) {
            await writePlaylistCoverFromAppleTemplate(
                artworkTemplate,
                path.join(playlistsDir, `${base}.jpg`),
            )
        }
    }
    return filePath
}

// Resolves {name, artistName, version?} entries to on-disk file paths using
// the same version-aware matching followedPlaylistsStore.mjs's
// rebuildFollowedPlaylistM3u() uses, so callers that don't have a followed
// playlist record (e.g. the public import service) get the same behavior.
export async function resolveTracksToLocalPaths(trackIndex) {
    if (!Array.isArray(trackIndex) || trackIndex.length === 0) return []
    const index = await scanLibraryOnce()
    const musicRoot = getMusicRoot()
    const absPaths = []
    for (const track of trackIndex) {
        if (!track?.name) continue
        const wanted = track.version || null
        const key = track.artistName
            ? makeSongKey(track.artistName, track.name)
            : null

        let candidates = key
            ? (index.songVersionPaths?.get(key) || []).slice()
            : []
        if (candidates.length === 0) {
            const suffix = `::${normalizeForMatchKey(track.name).toLowerCase()}`
            for (const [songKey, versions] of index.songVersionPaths || []) {
                if (!songKey.endsWith(suffix)) continue
                for (const v of versions) candidates.push(v)
            }
        }
        const seen = new Set()
        candidates = candidates.filter((c) => {
            if (seen.has(c.rel)) return false
            seen.add(c.rel)
            return true
        })
        if (candidates.length === 0) continue

        let rel = null
        if (wanted) {
            const match = candidates.find((c) => c.group === wanted)
            if (match) rel = match.rel
        }
        if (!rel) {
            const lossless = candidates.find((c) => c.group === 'lossless')
            const primary = candidates.find((c) => c.group === 'primary')
            rel = (lossless || primary || candidates[0]).rel
        }
        absPaths.push(path.join(musicRoot, rel))
    }
    return absPaths
}

export async function unlinkPlaylistImageSidecars(playlistsDir, base) {
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        await fsp.unlink(path.join(playlistsDir, `${base}${ext}`)).catch(() => null)
    }
}

export async function writePlaylistCoverFromAppleTemplate(artworkTemplate, absImagePathHint) {
    const urlStr = artworkUrl(artworkTemplate, 1200)
    if (!urlStr) return
    try {
        const res = await fetch(urlStr, {
            redirect: 'follow',
            headers: { Accept: 'image/*', 'User-Agent': 'alacarte/playlist-artwork' },
        })
        if (!res.ok) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length < 500) return
        const dot = absImagePathHint.lastIndexOf('.')
        const basePath = dot > 0 ? absImagePathHint.slice(0, dot) : absImagePathHint
        let dest
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
            dest = `${basePath}.jpg`
        } else if (
            buf.length >= 8 &&
            buf[0] === 0x89 &&
            buf[1] === 0x50 &&
            buf[2] === 0x4e &&
            buf[3] === 0x47
        ) {
            dest = `${basePath}.png`
        } else if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') {
            dest = `${basePath}.webp`
        } else {
            return
        }
        await fsp.writeFile(dest, buf, { mode: 0o664 })
    } catch {}
}
