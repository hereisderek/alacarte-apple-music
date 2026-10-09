// Creates N fake artists (one album, one file each) under dev/music/library/apple.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const n = Number(process.argv[2] || 252)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'music/library/apple')
for (let i = 0; i < n; i++) {
  const dir = path.join(root, `Artist ${i}`, `Album ${i} (2020)`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '01. Song.flac'), 'x')
}
console.log(`created ${n} artists in ${root}`)
