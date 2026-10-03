import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const { convertDirToFlac, convertToFlac } = await import('../lib/flacConvert.mjs')

async function withFakeFfmpeg(body, fn) {
  const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-fake-ffmpeg-'))
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const prev = process.env.PATH
  process.env.PATH = `${bin}:${prev}`
  try {
    return await fn()
  } finally {
    process.env.PATH = prev
  }
}

test('a hung ffmpeg is killed after the timeout instead of blocking forever', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-convert-'))
  await fsp.writeFile(path.join(dir, '01. A.m4a'), 'x')
  await fsp.writeFile(path.join(dir, '02. B.m4a'), 'x')
  await withFakeFfmpeg('exec sleep 30', async () => {
    const started = Date.now()
    await assert.rejects(convertToFlac(path.join(dir, '01. A.m4a'), { timeoutMs: 200 }), /timed out/)
    const r = await convertDirToFlac(dir, { timeoutMs: 200 })
    assert.deepEqual(r, { converted: 0, failed: 2, total: 2 })
    assert.ok(Date.now() - started < 5000)
  })
})

test('a cancelled conversion stops instead of counting the rest as failed', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-convert-'))
  await fsp.writeFile(path.join(dir, '01. A.m4a'), 'x')
  await fsp.writeFile(path.join(dir, '02. B.m4a'), 'x')
  await withFakeFfmpeg('exec sleep 30', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 100)
    const started = Date.now()
    await assert.rejects(convertDirToFlac(dir, { signal: ctl.signal }), { name: 'AbortError' })
    assert.ok(Date.now() - started < 5000)
  })
})

test('a real ALAC file still converts to FLAC', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-convert-'))
  const input = path.join(dir, '01. Tone.m4a')
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'alac', input])
  const r = await convertDirToFlac(dir)
  assert.deepEqual(r, { converted: 1, failed: 0, total: 1 })
  assert.deepEqual(await fsp.readdir(dir), ['01. Tone.flac'])
})

test('a failed conversion leaves no partial flac behind', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-convert-'))
  await fsp.writeFile(path.join(dir, '01. A.m4a'), 'x')
  // Writes half a file to its output path (the last argument), then fails.
  const body = 'for last; do :; done\nprintf partial > "$last"\nexit 1'
  await withFakeFfmpeg(body, async () => {
    const r = await convertDirToFlac(dir)
    assert.deepEqual(r, { converted: 0, failed: 1, total: 1 })
  })
  assert.deepEqual(await fsp.readdir(dir), ['01. A.m4a'])
})

test('a killed conversion leaves no partial flac behind', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-convert-'))
  await fsp.writeFile(path.join(dir, '01. A.m4a'), 'x')
  const body = 'for last; do :; done\nprintf partial > "$last"\nexec sleep 30'
  await withFakeFfmpeg(body, async () => {
    await assert.rejects(convertToFlac(path.join(dir, '01. A.m4a'), { timeoutMs: 300 }))
  })
  assert.deepEqual(await fsp.readdir(dir), ['01. A.m4a'])
})
