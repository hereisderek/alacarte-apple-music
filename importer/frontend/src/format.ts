import type { SongCandidate, ImportItem } from './api'

export function formatDuration(ms?: number | null): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatSize(bytes?: number | null): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const CHANNELS: Record<number, string> = { 1: 'mono', 2: 'stereo' }

// "FLAC · 1411 kbps · 44.1 kHz · 16-bit · stereo": only what the source reported.
export function formatAudio(c?: Partial<SongCandidate> | null): string | null {
  if (!c) return null
  const parts: string[] = []
  const format = c.suffix || (c.contentType ? c.contentType.replace(/^audio\//, '') : '')
  if (format) parts.push(format.toUpperCase())
  if (c.bitRate) parts.push(`${c.bitRate} kbps`)
  if (c.samplingRate) parts.push(`${(c.samplingRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`)
  if (c.bitDepth) parts.push(`${c.bitDepth}-bit`)
  if (c.channelCount) parts.push(CHANNELS[c.channelCount] || `${c.channelCount} ch`)
  return parts.length ? parts.join(' · ') : null
}

// Apple's catalog has no bit rate, only which quality tiers exist for a track. What each
// tier means is Apple's published spec ("up to"), not a measurement of the downloaded file.
export type QualityTier = { label: string; title: string }

export function appleQualityTiers(traits?: string[] | null): QualityTier[] {
  if (!traits || traits.length === 0) return []
  const tiers: QualityTier[] = []
  if (traits.includes('hi-res-lossless')) {
    tiers.push({ label: 'Hi-Res Lossless', title: 'ALAC, up to 24-bit / 192 kHz' })
  } else if (traits.includes('lossless')) {
    tiers.push({ label: 'Lossless', title: 'ALAC, 16-bit / 44.1 kHz up to 24-bit / 48 kHz' })
  } else {
    tiers.push({ label: 'AAC 256 kbps', title: 'Lossy AAC, the only stereo tier for this track' })
  }
  if (traits.includes('atmos') || traits.includes('spatial')) {
    tiers.push({ label: 'Dolby Atmos', title: 'Spatial audio (Dolby Atmos)' })
  }
  return tiers
}

export function releaseYear(c?: Partial<SongCandidate> | null): string | null {
  if (c?.year) return String(c.year)
  const m = /^(\d{4})/.exec(c?.releaseDate || '')
  return m ? m[1] : null
}

// Everything known about a track other than its title and artist, in reading order.
export function trackDetails(c?: Partial<SongCandidate> | null): string[] {
  if (!c) return []
  return [
    c.albumName || null,
    formatDuration(c.durationMs),
    formatAudio(c),
    formatSize(c.sizeBytes),
    releaseYear(c),
    c.genre || c.genreNames?.[0] || null,
  ].filter((v): v is string => Boolean(v))
}

// Apple artwork is a URL template; anything else (e.g. an unauthenticated Subsonic URL) is not shown.
export function artworkUrl(template?: string | null, size = 80): string | null {
  if (!template || !template.includes('{w}')) return null
  return template.replace('{w}', String(size)).replace('{h}', String(size)).replace('{f}', 'jpg')
}

export const MATCHED_BY_LABEL: Record<NonNullable<ImportItem['matchedBy']>, string> = {
  isrc: 'Matched by ISRC',
  search: 'Matched by search',
  'search-swapped': 'Matched by search (artist and title swapped)',
  'title-only': 'Matched by title only, check it',
  manual: 'Picked by hand',
}
