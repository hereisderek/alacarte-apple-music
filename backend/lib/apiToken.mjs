import crypto from 'node:crypto'

import { decryptSecret, readSettings } from './settingsStore.mjs'

// Machine clients (the octo-fiesta Apple Music provider) authenticate with a
// bearer token from Settings, accepted only on the integration API.
export const INTEGRATION_PREFIX = '/api/integration/'

export function isIntegrationRequest(req) {
  return `${req.baseUrl || ''}${req.path || ''}`.startsWith(INTEGRATION_PREFIX)
}

export function generateIntegrationToken() {
  return crypto.randomBytes(24).toString('hex')
}

// True when the octo-fiesta integration is switched on in Settings and the
// request carries its token.
export async function hasValidApiToken(req) {
  if (!isIntegrationRequest(req)) return false
  const match = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i)
  if (!match) return false
  const settings = await readSettings()
  if (!settings.octoIntegrationEnabled || !settings.octoIntegrationToken) return false
  const expected = decryptSecret(settings.octoIntegrationToken)
  if (!expected) return false
  const a = Buffer.from(match[1])
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
