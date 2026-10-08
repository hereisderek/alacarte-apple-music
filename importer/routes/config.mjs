import express from 'express'
import { getPublicConfig, getInternalConfig, updateConfig, isLocked } from '../lib/configStore.mjs'
import { pingSubsonic } from '../lib/subsonicClient.mjs'

export const configRouter = express.Router()

configRouter.get('/', (_req, res) => {
  res.json(getPublicConfig())
})

configRouter.post('/', (req, res) => {
  try {
    const updated = updateConfig(req.body || {})
    res.json(updated)
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message })
  }
})

configRouter.post('/test', async (req, res) => {
  try {
    const { mode, subsonic, alacarte } = req.body || {}
    if (mode === 'subsonic') {
      const result = await pingSubsonic(subsonic || {})
      return res.json(result)
    }

    if (mode === 'alacarte') {
      const internalCfg = getInternalConfig().alacarte
      const backendUrl = (alacarte?.backendUrl && alacarte.backendUrl.trim()
        ? alacarte.backendUrl.trim()
        : (internalCfg.backendUrl || 'http://web:7373')
      ).replace(/\/+$/, '')
      const internalApiKey = (alacarte?.internalApiKey !== undefined && alacarte.internalApiKey.trim() !== '')
        ? alacarte.internalApiKey.trim()
        : (internalCfg.internalApiKey || '')

      if (!internalApiKey) {
        return res.json({
          connected: false,
          ok: false,
          error: 'Internal API Key is not configured',
        })
      }

      try {
        const fetchRes = await fetch(`${backendUrl}/api/internal/health`, {
          headers: { 'X-Internal-Key': internalApiKey },
          signal: AbortSignal.timeout(5000),
        })
        const data = await fetchRes.json().catch(() => null)
        if (!fetchRes.ok) {
          return res.json({
            connected: true,
            ok: false,
            error: data?.error || `Backend returned HTTP ${fetchRes.status}`,
          })
        }
        return res.json({
          connected: true,
          ok: Boolean(data?.ok),
          wrapper: data?.wrapper,
          appleToken: data?.appleToken,
        })
      } catch (err) {
        return res.json({
          connected: false,
          ok: false,
          error: err.message || 'Main backend unreachable',
        })
      }
    }

    res.status(400).json({ error: `Unknown mode: ${mode}` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
