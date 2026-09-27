import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

import { authRouter } from './routes/auth.mjs'
import { importRouter } from './routes/import.mjs'
import { requireImporterAuth, isAuthEnabled } from './lib/auth.mjs'
import { createRateLimiter } from './lib/rateLimiter.mjs'

const PORT = Number(process.env.PORT || 8080)

function normalizeBasePath(value) {
  let v = String(value || '/').trim()
  if (!v.startsWith('/')) v = `/${v}`
  if (v.length > 1 && v.endsWith('/')) v = v.slice(0, -1)
  return v
}
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH)

if (!process.env.INTERNAL_API_KEY) {
  console.warn('[importer] INTERNAL_API_KEY not set — calls to the main backend will fail with 503.')
}
if (isAuthEnabled() && !process.env.IMPORTER_PASSWORD) {
  console.warn('[importer] AUTH_ENABLED=true but IMPORTER_PASSWORD is not set — login will always fail.')
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback')
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'https://*.mzstatic.com', 'data:'],
        connectSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  }),
)
app.use(express.json({ limit: '256kb' }))
app.use(cookieParser())

const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 })
const importLimiter = createRateLimiter({ windowMs: 60_000, max: 5 })

const root = express.Router()
root.use('/api/auth/login', loginLimiter)
root.use('/api/auth', authRouter)
root.use(requireImporterAuth())
root.use('/api/import', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/') return importLimiter(req, res, next)
  next()
})
root.use('/api/import', importRouter)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(__dirname, 'public')
if (fs.existsSync(publicDir)) {
  root.use(express.static(publicDir, { index: false, maxAge: '1h' }))
  root.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })
} else {
  root.get('/', (_req, res) => {
    res.status(200).type('text/plain').send('alacarte importer running (frontend not bundled)')
  })
}

app.use(BASE_PATH === '/' ? '/' : BASE_PATH, root)

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: String(err?.message || err) })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`alacarte importer listening on :${PORT} (basePath=${BASE_PATH})`)
})
