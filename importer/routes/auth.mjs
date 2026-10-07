import express from 'express'

import { isAuthEnabled, issueSessionToken, verifyCredentials, SESSION_COOKIE } from '../lib/auth.mjs'

export const authRouter = express.Router()

authRouter.get('/state', (_req, res) => {
  res.json({ authEnabled: isAuthEnabled() })
})

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'invalid credentials' })
  }
  res.cookie(SESSION_COOKIE, issueSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
  res.json({ ok: true })
})

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})
