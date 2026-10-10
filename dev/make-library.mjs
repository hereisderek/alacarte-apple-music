// Creates N fake artists under dev/music/library/apple.
//   node dev/make-library.mjs 252          one placeholder file per artist (no tags)
//   node dev/make-library.mjs 6 --tags     3 real tagged FLACs per artist (needs ffmpeg on the host);
//                                          title/album/artist match dev/mock-apple.mjs
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const n = Number(process.argv[2] || 252)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'music/library/apple')
const tags = process.argv.includes('--tags')
for (let i = 0; i < n; i++) {
  const dir = path.join(root, `Artist ${i}`, `Album ${i}`)
  fs.mkdirSync(dir, { recursive: true })
  if (!tags) {
    fs.writeFileSync(path.join(dir, '01. Song.flac'), 'x')
    continue
  }
  for (const t of [1, 2, 3]) {
    const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.05', '-c:a', 'flac',
      '-metadata', `TITLE=Song ${t}`, '-metadata', `ARTIST=Artist ${i}`, '-metadata', `ALBUM=Album ${i}`,
      '-metadata', `track=${t}`, path.join(dir, `0${t}. Song ${t}.flac`)], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr)
  }
}
console.log(`created ${n} artists in ${root}`)
