import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseSilverboxHtml } from '../parsers/generic-site/silverbox.mjs'
import { parseKkboxHtml } from '../parsers/kkbox/index.mjs'
import { extractNextData } from '../parsers/spotify/index.mjs'
import { extractAssignedJson } from '../lib/extractInlineJson.mjs'

// Fixture shapes below are trimmed excerpts of the real markup captured from
// each site on 2026-09-26 — see importer/SUPPORTED_LINKS.md for the sites
// these mirror. If a site changes its markup, these are the tests to update.

test('parseSilverboxHtml pulls title/artists out of songItem rows, including multi-artist rows', () => {
  const html = `
    <li class="songItem">
        <div class="rank"><span>1</span></div>
        <div class="songBox">
            <div class="songTitle">不愛就不愛</div>
            <div class="singer">
                艾薇		</div>
            <div class="songNumber">1</div>
        </div>
        <div class="singer">
            艾薇		</div>
        <div class="language"><span>國語</span></div>
        <div class="songNumber">1</div>
    </li>
    <li class="songItem">
        <div class="songBox"><div class="songTitle">不該</div><div class="singer">周杰倫,張惠妹</div></div>
    </li>`
  const tracks = parseSilverboxHtml(html)
  assert.equal(tracks.length, 2)
  assert.deepEqual(tracks[0], { raw: '不愛就不愛 - 艾薇', title: '不愛就不愛', artists: ['艾薇'] })
  assert.deepEqual(tracks[1].artists, ['周杰倫', '張惠妹'])
})

test('parseKkboxHtml reads the playlist title from JSON-LD and rows from the track list', () => {
  const html = `
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"MusicPlaylist","name":"那些KTV必點、聽不膩的華語情歌 ♡","track":[]}
    </script>
    <ul>
      <li><div class="text"><div class="song" title="我不難過"><a href="#">我不難過</a></div>
        <div class="artist-album"><a href="#">孫燕姿 (Yanzi Sun)</a><span class="album">- <a>未完成</a></span></div>
      </div></li>
    </ul>`
  const { title, tracks } = parseKkboxHtml(html)
  assert.equal(title, '那些KTV必點、聽不膩的華語情歌 ♡')
  assert.equal(tracks.length, 1)
  assert.deepEqual(tracks[0], { raw: '我不難過 - 孫燕姿 (Yanzi Sun)', title: '我不難過', artists: ['孫燕姿 (Yanzi Sun)'] })
})

test('extractNextData parses Spotify embed __NEXT_DATA__ script content', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity: { name: 'Test', trackList: [] } } } } },
  })}</script></body></html>`
  const data = extractNextData(html)
  assert.equal(data.props.pageProps.state.data.entity.name, 'Test')
})

test('qishui _ROUTER_DATA extraction survives trailing minified JS on the same line', () => {
  const payload = {
    loaderData: {
      playlist_page: {
        playlistInfo: { title: '老歌' },
        medias: [
          { type: 'track', entity: { track: { name: '光辉岁月', artists: [{ name: 'Beyond' }] } } },
        ],
      },
    },
  }
  const html = `window._ROUTER_DATA = ${JSON.stringify(payload)};(function(){doStuff()})();`
  const data = extractAssignedJson(html, '_ROUTER_DATA')
  assert.equal(data.loaderData.playlist_page.playlistInfo.title, '老歌')
  assert.equal(data.loaderData.playlist_page.medias[0].entity.track.name, '光辉岁月')
})
