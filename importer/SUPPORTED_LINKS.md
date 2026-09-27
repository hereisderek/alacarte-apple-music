# Supported input formats

Tracking doc for what the importer can parse today, and how. Each URL-based
source lives in its own folder under [`parsers/`](parsers/) — the registry in
[`parsers/index.mjs`](parsers/index.mjs) matches a pasted URL to one of these
by hostname/path, so it's always obvious from the URL alone which parser will
handle it. Add a new platform by adding a new parser + one row here; nothing
else needs to change.

| Input | Parser | Status | Notes |
|---|---|---|---|
| Plain text list (`Title - Artist`, one per line) | [`parsers/plaintext.mjs`](parsers/plaintext.mjs) | Supported | Multiple artists separated by `,`/`，`/`、`. No inherent title — the form's "Playlist title" field is used. |
| Spotify playlist (`open.spotify.com/playlist/<id>`) | [`parsers/spotify/`](parsers/spotify/) | Supported | Reads the no-auth embed page (`open.spotify.com/embed/playlist/<id>`) — no Spotify API credentials needed. Only the first batch of tracks the embed page ships (~50-100) is read; very long playlists are truncated. |
| Qishui / 汽水音乐 playlist (`qishui.com/share/playlist?playlist_id=`) | [`parsers/qishui/`](parsers/qishui/) | Supported | Reads the share page's server-rendered `_ROUTER_DATA` blob. Same truncation caveat as Spotify (~150-200 tracks of a longer playlist). |
| KKBOX playlist (`kkbox.com/.../playlist/<id>`) | [`parsers/kkbox/`](parsers/kkbox/) | Best-effort | KKBOX fronts playlist pages with an AWS WAF bot challenge that a plain server-side request usually can't pass. Works when the challenge isn't triggered; fails with a clear message ("paste as plain text instead") otherwise. |
| HOLIDAY KTV chart (`holiday.com.tw/SongInfo/SongList.aspx`) | [`parsers/generic-site/holiday.mjs`](parsers/generic-site/holiday.mjs) | Supported | Calls the page's own JSON chart API (`/Ashx/SongInfo.ashx`) directly — no HTML scraping. A chart, not a playlist, so it has no title of its own. |
| Silverbox KTV rank (`silverbox.com.tw/rank/<n>/`) | [`parsers/generic-site/silverbox.mjs`](parsers/generic-site/silverbox.mjs) | Supported | Fully server-rendered page; parsed by matching `<li class="songItem">` rows. |
| NetEase Cloud Music (网易云音乐, `music.163.com`) | [`parsers/netease/`](parsers/netease/) | Supported | Reads official v6 playlist detail API with song detail batching; falls back to mobile `REDUX_STATE`. Large playlists without auth are limited by NetEase's API. |
| YouTube / YouTube Music (`music.youtube.com`, `youtube.com`) | [`parsers/youtube/`](parsers/youtube/) | Supported | Extracts songs and artists from YouTube Music browse payload; falls back to YouTube playlist renderers. |
| Other arbitrary chart/listing sites | [`parsers/generic-site/`](parsers/generic-site/) | Extend as needed | Each site gets its own profile file in this folder (see `holiday.mjs`/`silverbox.mjs` for the shape) — there's no generic scraper, since every site's markup is different. |

## Adding a platform

1. Create `parsers/<platform>/index.mjs` exporting `matches<Platform>(url)` and
   `parse<Platform>Playlist(url)` returning `{ title, tracks: [{ raw, title, artists }] }`.
2. Register it in `parsers/index.mjs`'s `URL_PARSERS` list.
3. Add a row to the table above.
4. If the platform needs a fetch-time trick (embedded JSON blob, an
   undocumented JSON API, bot-protection workaround), leave a comment
   explaining it — see the existing parsers for the pattern.
