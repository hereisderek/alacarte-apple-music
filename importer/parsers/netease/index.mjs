import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)(music\.163\.com|y\.music\.163\.com|163cn\.tv)$/i

export function matchesNetease(url) {
  try {
    const u = new URL(url)
    return (
      HOST_RE.test(u.hostname) &&
      (/\/playlist/.test(u.pathname) ||
        /\/playlist/.test(u.hash) ||
        u.searchParams.has('id') ||
        HOST_RE.test(u.hostname))
    )
  } catch {
    return false
  }
}

export function extractNeteaseId(url) {
  try {
    const u = new URL(url)
    if (u.searchParams.has('id')) return u.searchParams.get('id')
    const hashMatch = u.hash.match(/[?&]id=(\d+)/)
    if (hashMatch) return hashMatch[1]
    const pathMatch = u.pathname.match(/\/playlist\/(\d+)/)
    if (pathMatch) return pathMatch[1]
  } catch {
    // fallback regex on raw string
  }
  const match = String(url).match(/[?&#]id=(\d+)/)
  return match ? match[1] : null
}

export async function parseNeteasePlaylist(url) {
  let targetUrl = url
  let id = extractNeteaseId(targetUrl)

  // If short link or no id found directly, follow redirects
  if (!id) {
    try {
      const headRes = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': userAgentFor('NETEASE_USER_AGENT') },
      })
      targetUrl = headRes.url || url
      id = extractNeteaseId(targetUrl)
    } catch {
      // ignore redirect fetch errors, will check id below
    }
  }

  if (!id) {
    const err = new Error('could not find a playlist id in this NetEase (163.com) URL')
    err.status = 400
    throw err
  }

  const userAgent = userAgentFor('NETEASE_USER_AGENT')
  const defaultHeaders = {
    'User-Agent': userAgent,
    Referer: 'https://music.163.com/',
    Cookie: 'os=pc; appver=8.9.70',
  }

  // 1. Try playlist/detail API with os=pc cookie (bypasses mobile/unauth truncation)
  try {
    const res = await fetch(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, {
      headers: defaultHeaders,
    })

    if (res.ok) {
      const data = await res.json()
      if (data?.code === 200 && data.result) {
        const pl = data.result
        const title = pl.name || null
        const totalCount = pl.trackCount || pl.tracks?.length || 0
        let songs = Array.isArray(pl.tracks) ? [...pl.tracks] : []

        // If trackIds has more tracks, fetch details in batches
        const existingIds = new Set(songs.map((s) => s.id))
        const missingIds = (pl.trackIds || []).map((t) => (typeof t === 'object' ? t.id : t)).filter((tid) => !existingIds.has(tid))

        if (missingIds.length > 0) {
          const CHUNK_SIZE = 400
          for (let i = 0; i < missingIds.length; i += CHUNK_SIZE) {
            const chunk = missingIds.slice(i, i + CHUNK_SIZE)
            try {
              const cParam = JSON.stringify(chunk.map((tid) => ({ id: tid })))
              const detailRes = await fetch('https://music.163.com/api/v3/song/detail', {
                method: 'POST',
                headers: {
                  ...defaultHeaders,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ c: cParam }).toString(),
              })
              if (detailRes.ok) {
                const detailData = await detailRes.json()
                if (Array.isArray(detailData?.songs)) {
                  songs.push(...detailData.songs)
                }
              }
            } catch {
              break
            }
          }
        }

        const tracks = songs.map((s) => {
          const songTitle = s.name?.trim() || ''
          const artists = (s.artists || s.ar || []).map((a) => a.name?.trim()).filter(Boolean)
          return {
            raw: `${songTitle} - ${artists.join(', ')}`,
            title: songTitle,
            artists,
          }
        })

        let warning = null
        if (totalCount > tracks.length) {
          warning = `NetEase Cloud Music share link only returned ${tracks.length} of ${totalCount} tracks due to NetEase platform API limitations.`
        }

        return { title, tracks, warning }
      }
    }
  } catch (err) {
    console.warn('[netease] /api/playlist/detail fetch failed, trying v6 API:', err.message)
  }

  // 2. Try official v6 playlist detail API
  try {
    const res = await fetch(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}`, {
      headers: defaultHeaders,
    })

    if (res.ok) {
      const data = await res.json()
      if (data?.code === 200 && data.playlist) {
        const pl = data.playlist
        const title = pl.name || null
        const totalCount = pl.trackCount || pl.trackIds?.length || 0
        let songs = Array.isArray(pl.tracks) ? [...pl.tracks] : []

        const existingIds = new Set(songs.map((s) => s.id))
        const missingIds = (pl.trackIds || []).map((t) => t.id).filter((tid) => !existingIds.has(tid))

        if (missingIds.length > 0) {
          const CHUNK_SIZE = 400
          for (let i = 0; i < missingIds.length; i += CHUNK_SIZE) {
            const chunk = missingIds.slice(i, i + CHUNK_SIZE)
            try {
              const cParam = JSON.stringify(chunk.map((tid) => ({ id: tid })))
              const detailRes = await fetch('https://music.163.com/api/v3/song/detail', {
                method: 'POST',
                headers: {
                  ...defaultHeaders,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ c: cParam }).toString(),
              })
              if (detailRes.ok) {
                const detailData = await detailRes.json()
                if (Array.isArray(detailData?.songs)) {
                  songs.push(...detailData.songs)
                }
              }
            } catch {
              break
            }
          }
        }

        const tracks = songs.map((s) => {
          const songTitle = s.name?.trim() || ''
          const artists = (s.ar || s.artists || []).map((a) => a.name?.trim()).filter(Boolean)
          return {
            raw: `${songTitle} - ${artists.join(', ')}`,
            title: songTitle,
            artists,
          }
        })

        let warning = null
        if (totalCount > tracks.length) {
          warning = `NetEase Cloud Music share link only returned ${tracks.length} of ${totalCount} tracks due to NetEase platform API limitations.`
        }

        return { title, tracks, warning }
      }
    }
  } catch (err) {
    console.warn('[netease] v6 API fetch failed, falling back to mobile HTML:', err.message)
  }

  // 3. Fallback: fetch mobile HTML page and extract REDUX_STATE
  const mobileRes = await fetch(`https://music.163.com/m/playlist?id=${encodeURIComponent(id)}`, {
    headers: {
      ...defaultHeaders,
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
  })

  if (!mobileRes.ok) {
    const err = new Error(`NetEase playlist fetch failed (${mobileRes.status})`)
    err.status = 502
    throw err
  }

  const html = await mobileRes.text()
  const reduxMarker = 'REDUX_STATE = '
  const reduxIdx = html.indexOf(reduxMarker)
  if (reduxIdx !== -1) {
    const endIdx = html.indexOf(';</script>', reduxIdx)
    if (endIdx !== -1) {
      try {
        const json = JSON.parse(html.slice(reduxIdx + reduxMarker.length, endIdx))
        const pl = json?.Playlist
        const items = Array.isArray(pl?.data) ? pl.data : []
        const title = pl?.info?.name || null
        const totalCount = pl?.trackCount || items.length

        const tracks = items.map((item) => {
          const songTitle = item.songName || ''
          const artist = item.singerName || ''
          const artists = artist
            ? artist.split(/[,，、]/).map((a) => a.trim()).filter(Boolean)
            : []
          return {
            raw: `${songTitle} - ${artists.join(', ')}`,
            title: songTitle,
            artists,
          }
        })

        let warning = null
        if (totalCount > tracks.length) {
          warning = `NetEase Cloud Music share link only returned ${tracks.length} of ${totalCount} tracks due to NetEase platform API limitations.`
        }

        return { title, tracks, warning }
      } catch (e) {
        console.warn('[netease] failed to parse REDUX_STATE:', e.message)
      }
    }
  }

  const err = new Error('could not parse NetEase playlist page (layout may have changed)')
  err.status = 502
  throw err
}
