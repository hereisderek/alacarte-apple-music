import crypto from 'node:crypto'
import { readNavidromeCreds } from './settingsStore.mjs'

export async function triggerNavidromeScan({ fullScan = false } = {}) {
  const creds = await readNavidromeCreds()
  if (!creds.enabled || !creds.url || !creds.user || !creds.password) {
    return
  }

  try {
    const salt = crypto.randomBytes(6).toString('hex')
    const token = crypto.createHash('md5').update(creds.password + salt).digest('hex')
    
    // Relative to the configured URL so a Navidrome served under a path
    // (https://host/navidrome) keeps it.
    const base = creds.url.endsWith('/') ? creds.url : `${creds.url}/`
    const url = new URL('rest/startScan', base)
    url.searchParams.set('u', creds.user)
    url.searchParams.set('t', token)
    url.searchParams.set('s', salt)
    url.searchParams.set('v', '1.16.1')
    url.searchParams.set('c', 'alacarte')
    url.searchParams.set('f', 'json')
    if (fullScan) url.searchParams.set('fullScan', 'true')

    const response = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      console.error(`Navidrome API error: ${response.status} ${response.statusText}`)
      return
    }

    const data = await response.json()
    if (data['subsonic-response'] && data['subsonic-response'].status === 'failed') {
      console.error('Navidrome API failed:', data['subsonic-response'].error)
    } else {
      console.log('Successfully triggered Navidrome scan.')
    }
  } catch (err) {
    console.error('Failed to trigger Navidrome scan:', err.message)
  }
}
