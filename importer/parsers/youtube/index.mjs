import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)(youtube\.com|youtu\.be)$/i

export function matchesYoutube(url) {
  try {
    const u = new URL(url)
    return (
      HOST_RE.test(u.hostname) &&
      (u.searchParams.has('list') || /\/playlist/.test(u.pathname))
    )
  } catch {
    return false
  }
}

export function extractYoutubeListId(url) {
  try {
    const u = new URL(url)
    if (u.searchParams.has('list')) return u.searchParams.get('list')
    const match = u.pathname.match(/\/playlist\/([^/?#]+)/)
    if (match) return match[1]
  } catch {
    // fallback regex
  }
  const match = String(url).match(/[?&]list=([^&#]+)/)
  return match ? match[1] : null
}

function unescapeHex(str) {
  return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

function extractTitleFromHtml(html) {
  const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i)
  if (ogMatch && ogMatch[1]) {
    return ogMatch[1].replace(/\s*-\s*YouTube(\s*Music)?\s*$/i, '').trim()
  }
  const titleMatch = html.match(/<title>(.*?)<\/title>/i)
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].replace(/\s*-\s*YouTube(\s*Music)?\s*$/i, '').trim()
  }
  return null
}

function collectRenderers(obj, key, list = []) {
  if (!obj || typeof obj !== 'object') return list
  if (obj[key]) {
    list.push(obj[key])
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectRenderers(item, key, list)
  } else {
    for (const k of Object.keys(obj)) collectRenderers(obj[k], key, list)
  }
  return list
}

export async function parseYoutubePlaylist(url) {
  const listId = extractYoutubeListId(url)
  if (!listId) {
    const err = new Error('could not find a playlist id (?list=...) in this YouTube URL')
    err.status = 400
    throw err
  }

  const userAgent = userAgentFor('YOUTUBE_USER_AGENT')

  // 1. Fetch from music.youtube.com
  let html = ''
  try {
    const res = await fetch(`https://music.youtube.com/playlist?list=${encodeURIComponent(listId)}`, {
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (res.ok) {
      html = await res.text()
    }
  } catch (err) {
    console.warn('[youtube] music.youtube.com fetch failed:', err.message)
  }

  let title = html ? extractTitleFromHtml(html) : null
  const tracks = []

  if (html) {
    // Try to extract browse payload from music.youtube.com
    const browseIdx = html.indexOf("path: '\\/browse'")
    if (browseIdx !== -1) {
      const dataMarker = "data: '"
      const dataIdx = html.indexOf(dataMarker, browseIdx)
      if (dataIdx !== -1) {
        const start = dataIdx + dataMarker.length
        const end = html.indexOf("'});", start)
        if (end !== -1) {
          try {
            const raw = html.slice(start, end)
            const unescaped = unescapeHex(raw)
            const json = JSON.parse(unescaped)

            const items = collectRenderers(json, 'musicResponsiveListItemRenderer')
            for (const item of items) {
              const cols = item.flexColumns || []
              const titleRuns = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
              const songTitle = titleRuns.map((r) => r.text).join('').trim()
              if (!songTitle) continue

              const subtitleRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
              const artists = []

              for (const run of subtitleRuns) {
                const pageType = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
                const browseId = run.navigationEndpoint?.browseEndpoint?.browseId
                if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || browseId?.startsWith('UC')) {
                  const name = run.text?.trim()
                  if (name && name !== '•') artists.push(name)
                }
              }

              // Fallback for artist: take first text run before separator
              if (artists.length === 0 && subtitleRuns.length > 0) {
                const firstText = subtitleRuns[0]?.text?.trim()
                if (firstText && firstText !== '•') artists.push(firstText)
              }

              tracks.push({
                raw: artists.length > 0 ? `${songTitle} - ${artists.join(', ')}` : songTitle,
                title: songTitle,
                artists,
              })
            }
          } catch (e) {
            console.warn('[youtube] error parsing music.youtube.com JSON:', e.message)
          }
        }
      }
    }
  }

  // 2. If no tracks found from music.youtube.com, fallback to www.youtube.com
  if (tracks.length === 0) {
    try {
      const ytRes = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`, {
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (ytRes.ok) {
        const ytHtml = await ytRes.text()
        if (!title) title = extractTitleFromHtml(ytHtml)

        const marker = 'var ytInitialData = '
        const idx = ytHtml.indexOf(marker)
        if (idx !== -1) {
          const end = ytHtml.indexOf(';</script>', idx)
          if (end !== -1) {
            const json = JSON.parse(ytHtml.slice(idx + marker.length, end))
            if (!title) {
              title = json.metadata?.playlistMetadataRenderer?.title || null
            }

            // Check for playlistVideoRenderer
            const videoRenderers = collectRenderers(json, 'playlistVideoRenderer')
            for (const v of videoRenderers) {
              const videoTitle = v.title?.runs?.map((r) => r.text).join('').trim() || ''
              const byline = v.shortBylineText?.runs?.map((r) => r.text).join('').trim()
              if (!videoTitle) continue
              const artists = byline ? [byline] : []
              tracks.push({
                raw: artists.length > 0 ? `${videoTitle} - ${artists.join(', ')}` : videoTitle,
                title: videoTitle,
                artists,
              })
            }

            // Check for lockupViewModel
            if (tracks.length === 0) {
              const lockups = collectRenderers(json, 'lockupViewModel')
              for (const l of lockups) {
                const lTitle = l.metadata?.lockupMetadataViewModel?.title?.content?.trim()
                if (lTitle) {
                  tracks.push({
                    raw: lTitle,
                    title: lTitle,
                    artists: [],
                  })
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[youtube] fallback to www.youtube.com failed:', e.message)
    }
  }

  if (tracks.length === 0) {
    const err = new Error('could not find any tracks in this YouTube playlist (it may be private or empty)')
    err.status = 502
    throw err
  }

  return { title: title || 'YouTube playlist', tracks }
}
