// Dev-only preload (node --import): replaces fetch for Apple hosts with a local
// fake so call patterns can be reproduced without touching Apple's real rate limit.
//   MOCK_APPLE_LATENCY_MS   fake response time (default 80)
//   MOCK_APPLE_LIMIT_RPS    answer 429 once more than this many requests land in
//                           one second (default 0 = never); the "ban" then lasts
//                           MOCK_APPLE_BAN_MS (default 60000)
const realFetch = globalThis.fetch
const latency = Number(process.env.MOCK_APPLE_LATENCY_MS ?? 80)
const limitRps = Number(process.env.MOCK_APPLE_LIMIT_RPS ?? 0)
const banMs = Number(process.env.MOCK_APPLE_BAN_MS ?? 60_000)
const hits = []
let bannedUntil = 0
let total = 0
let inFlight = 0

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
  if (url.hostname === 'music.apple.com') {
    if (url.pathname === '/') return new Response('<script src="/assets/index~mock.js"></script>')
    return new Response('t="eyJmock.eyJmock.mock"')
  }
  if (url.hostname !== 'amp-api.music.apple.com') return realFetch(input, init)

  const now = Date.now()
  hits.push(now)
  while (hits.length && now - hits[0] > 1000) hits.shift()
  total++
  inFlight++
  const label = `${url.pathname}${url.search.slice(0, 60)}`
  let status = 200
  if (now < bannedUntil) status = 429
  else if (limitRps > 0 && hits.length > limitRps) {
    bannedUntil = now + banMs
    status = 429
  }
  console.log(`[mock-apple] #${total} ${status} in-flight=${inFlight} rps=${hits.length} ${label}`)
  await new Promise((r) => setTimeout(r, latency))
  inFlight--
  if (status === 429) {
    return new Response(
      JSON.stringify({ errors: [{ title: 'Too Many Requests', detail: 'Request is forbidden', status: '429', code: '42900' }] }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )
  }
  const term = url.searchParams.get('term') || 'x'
  return Response.json({
    results: { artists: { data: [{ id: `id-${term}`, type: 'artists', attributes: { name: term } }] } },
  })
}
console.log(`[mock-apple] active latency=${latency}ms limitRps=${limitRps || 'off'}`)
