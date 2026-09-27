import { matchesHoliday, parseHoliday } from './holiday.mjs'
import { matchesSilverbox, parseSilverbox } from './silverbox.mjs'

// One profile per arbitrary chart/listing site the user has pointed us at —
// each site needs its own scraping strategy, so this stays a lookup table
// rather than a generic scraper. Add a new file + entry here per site.
const PROFILES = [
  { matches: matchesHoliday, parse: parseHoliday },
  { matches: matchesSilverbox, parse: parseSilverbox },
]

export function matchesGenericSite(url) {
  return PROFILES.some((p) => p.matches(url))
}

export async function parseGenericSite(url) {
  const profile = PROFILES.find((p) => p.matches(url))
  if (!profile) {
    const err = new Error('no site profile registered for this URL')
    err.status = 400
    throw err
  }
  return profile.parse(url)
}
