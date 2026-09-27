import { userAgentFor } from '../../lib/userAgent.mjs'

const HOST_RE = /(^|\.)holiday\.com\.tw$/i
const MAX_PAGES = 5

export function matchesHoliday(url) {
  try {
    const u = new URL(url)
    return HOST_RE.test(u.hostname) && /\/SongInfo\/SongList\.aspx/i.test(u.pathname)
  } catch {
    return false
  }
}

// HOLIDAY KTV's chart page renders client-side from a JSON AJAX endpoint
// (no HTML scraping needed) — POST /Ashx/SongInfo.ashx with the same
// {m, ltype, page} the page's own JS sends. songname/singer come back
// percent-encoded UTF-8. This is a chart, not a user playlist, so there's no
// inherent title — the importer falls back to a user-supplied one.
export async function parseHoliday(url) {
  const u = new URL(url)
  const mode = u.searchParams.get('st') === 'new' ? 'new' : 'top'
  const lang = u.searchParams.get('lt') || 'tc'

  const tracks = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetch('https://www.holiday.com.tw/Ashx/SongInfo.ashx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'User-Agent': userAgentFor('HOLIDAY_USER_AGENT'),
      },
      body: JSON.stringify([{ m: mode, ltype: lang, page }]),
    })
    if (!res.ok) break
    const data = await res.json().catch(() => null)
    const entry = data?.[0]
    if (!entry || entry.Ok !== '1' || !Array.isArray(entry.DataList)) break

    for (const row of entry.DataList) {
      const name = safeDecode(row.songname)
      const singer = safeDecode(row.singer)
      if (!name) continue
      tracks.push({
        raw: `${name} - ${singer}`,
        title: name,
        artists: singer.split(/[、,，]/).map((a) => a.trim()).filter(Boolean),
      })
    }

    const pageInfo = entry.Page?.[0]
    if (!pageInfo || page >= pageInfo.MaxPage || pageInfo.NextPage === pageInfo.ThisPage) break
  }

  if (tracks.length === 0) {
    const err = new Error('could not load the HOLIDAY KTV chart (layout may have changed)')
    err.status = 502
    throw err
  }
  return { title: null, tracks }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || '')
  } catch {
    return String(value || '')
  }
}
