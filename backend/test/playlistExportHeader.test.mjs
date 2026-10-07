import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const music = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-m3u-header-'))
process.env.AMDL_MUSIC_PATH = music
process.env.AMDL_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-m3u-header-cfg-'))

const { writePlaylistM3U } = await import('../lib/playlistExport.mjs')
const { parsePlaylistM3uText } = await import('../lib/libraryIndex.mjs')

test('a line break in a playlist name cannot add entries to the m3u8', async () => {
  const track = path.join(music, 'Artist', 'Album', '01. Song.flac')
  const file = await writePlaylistM3U({
    playlistName: 'Road trip\n../../../etc/passwd\r\n#EXTINF:1,x',
    playlistId: 'pl.1\nevil.flac',
    tracks: [track],
  })
  const text = await fsp.readFile(file, 'utf8')
  const lines = text.trim().split('\n')
  assert.deepEqual(lines, [
    '#EXTM3U',
    '#PLAYLIST:Road trip ../../../etc/passwd #EXTINF:1,x',
    '#ALACARTE_PLAYLIST_ID:pl.1 evil.flac',
    '../Artist/Album/01. Song.flac',
  ])
  assert.equal(parsePlaylistM3uText(text).trackCount, 1)
})

test('an empty or control-only name falls back to Playlist', async () => {
  const file = await writePlaylistM3U({ playlistName: '\n\t', tracks: [] })
  assert.match(await fsp.readFile(file, 'utf8'), /^#EXTM3U\n#PLAYLIST:Playlist\n$/)
})
