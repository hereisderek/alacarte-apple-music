// Last-resort Express error handler. Client errors raised by middleware
// (bad JSON, body too large) keep their status and safe message; anything
// else is logged in full and answered with a generic message, since it can
// carry paths or upstream responses and may reach unauthenticated callers.
export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode)
    if (status >= 400 && status < 500 && err?.expose) {
      return res.status(status).json({ error: err.message })
    }
    console.error('Unhandled error:', err)
    res.status(500).json({ error: 'internal error' })
  }
}
