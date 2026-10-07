import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-outbound-'))
process.env.AMDL_CONFIG_DIR = tmpDir
process.env.AMDL_SECRET_KEY = crypto.randomBytes(32).toString('hex')

const { ensureConfigDir, writeSettings, encryptSecret } = await import('../lib/settingsStore.mjs')
const { loadSecretsAtBoot } = await import('../lib/secretKey.mjs')
await ensureConfigDir(tmpDir)
loadSecretsAtBoot(tmpDir)
const { triggerNavidromeScan } = await import('../lib/navidromeApi.mjs')
const { searchCatalog } = await import('../lib/appleApi.mjs')

const hits = []
const navidrome = http.createServer((req, res) => {
  hits.push(new URL(req.url, 'http://x').pathname)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok' } }))
})
await new Promise((r) => navidrome.listen(0, '127.0.0.1', r))
const navBase = `http://127.0.0.1:${navidrome.address().port}`
test.after(() => navidrome.close())

for (const [configured, expected] of [
  [`${navBase}/navidrome`, '/navidrome/rest/startScan'],
  [`${navBase}/navidrome/`, '/navidrome/rest/startScan'],
  [navBase, '/rest/startScan'],
]) {
  test(`navidrome at ${configured.replace(navBase, '<host>') || '<host>'} is asked to scan at ${expected}`, async () => {
    await writeSettings({
      navidromeEnabled: true,
      navidromeUrl: configured,
      navidromeUser: 'nd',
      navidromePassword: encryptSecret('pw'),
    })
    hits.length = 0
    await triggerNavidromeScan()
    assert.deepEqual(hits, [expected])
  })
}

test('apple requests always carry a time limit and still honour the caller signal', async () => {
  const realFetch = globalThis.fetch
  const signals = []
  globalThis.fetch = async (url, opts = {}) => {
    signals.push({ url: String(url), signal: opts.signal })
    if (String(url) === 'https://music.apple.com') {
      return new Response('<script src="/assets/index~a.js"></script>')
    }
    if (String(url).includes('/assets/index~')) return new Response('x="eyJa.eyJb.sig"')
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(opts.signal.reason))
    })
  }
  try {
    const ctl = new AbortController()
    const pending = searchCatalog({ storefront: 'us', term: 'x', signal: ctl.signal })
    await new Promise((r) => setTimeout(r, 50))
    ctl.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    assert.ok(signals.length >= 3)
    for (const { url, signal } of signals) {
      assert.ok(signal instanceof AbortSignal, `${url} has a time limit`)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})
