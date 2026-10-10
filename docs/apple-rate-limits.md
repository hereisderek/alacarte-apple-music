# Apple Music API rate limits (429)

Everything alacarte does against the Apple Music catalog goes out from one IP address
(IPv4 and IPv6 are limited separately). When Apple decides that address is too noisy it
answers every catalog call with:

```
HTTP 429  {"errors":[{"title":"Too Many Requests","detail":"Request is forbidden","status":"429","code":"42900"}]}
server: daiquiri/5   x-cdn: fsly   (no Retry-After header)
```

The ban covers all catalog calls, not just search, and lasts 15–60 minutes. Retrying
during a ban does not help and probably extends it. The web UI then shows a bare
`502 Search failed`, because `routes/search.mjs` turns any Apple error into a 502.

## What is known and what is not

Known (observed):

- The limit is per source IP, applies to the anonymous web token alacarte scrapes from
  music.apple.com, and is shared by every caller in the process.
- 1 search per 1.5 s from the importer, plus occasional manual searches, has been fine.
- 24 unpaced importer searches produced twelve 429s; one 429 happened at a 300 ms pace.
- 252 artist searches at 4 concurrent (about 8 req/s) is enough to trip it.

Not known:

- The real threshold (requests per second, per minute, or per hour) and whether it is a
  token bucket or a fixed window. The 1.5 s spacing in `requestSpacer.mjs` was found by
  trial, not from Apple documentation.
- Whether calls made by the downloader/wrapper (decrypt, m3u8, account) count against
  the same budget. They go out from the same container network.

The `[apple]` log lines added on `fix/apple-request-logging` exist to answer the first
question: each 429 logs how many calls were made in the previous 60 seconds and by whom.

## Incidents

| When | Address | Likely trigger |
|---|---|---|
| 2026-09-29 01:38–01:39 | IPv4 | Two concurrent `/api/integration/v1/search` calls at the same millisecond, repeated about a minute later (an external client of the integration API, no pacing). |
| 2026-10-09 13:40 | IPv6 `2404:4400:4172:e900:…` | UI page loads right after a container restart. `GET /api/library` resolves an Apple artist ID for every artist in the library (252 on saltbox), 4 at a time, unpaced, with a memory-only cache. The importer's first search at 13:40:32 was already rejected; its retries (1, 2, 4, 8, 16, 20 s) show in the log. By 2026-10-10 the ban had cleared (both families returned 200). |

The 10-09 cause is inferred from code and timing. The logging above will confirm it.

## Reproducing locally

`docker-compose.dev.yml` runs the backend from `./backend` in a plain `node:22` container
(no image build, no CI) with `dev/mock-apple.mjs` standing in for Apple, so nothing
touches the real rate limit. `MOCK_APPLE_LIMIT_RPS` makes the mock answer 429 above that
many requests per second.

```
mkdir -p dev/config && node dev/make-library.mjs 252
docker compose -f docker-compose.dev.yml up -d
curl localhost:7374/api/library
docker compose -f docker-compose.dev.yml logs | grep -E "\[apple\]|mock-apple"
```

Measured with 252 fake artists and the mock at 80 ms latency, limit off:

- the first `GET /api/library` sends 252 Apple searches in 5.3 s (about 47 req/s)
- a second call sends 0 (memory cache), but after a container restart it sends 252 again
- with the mock limit at 5 req/s the 6th call is rejected; with this branch's cooldown
  the other 246 calls are blocked locally instead of being sent

## Who calls Apple

Every call goes through `lib/appleApi.mjs` and the gateway (see below). The lane decides
how it is treated.

| Caller | Trigger | Lane | Calls | Persisted cache |
|---|---|---|---|---|
| `routes/search.mjs`, `album.mjs`, `artist.mjs`, `playlist.mjs`, cloud library | a person using the UI | interactive | 1 each | partial (`originalMetadataCache`) |
| `routes/internal.mjs` `/search` | importer | batch | 1 per query, up to 3 queries per track | no |
| `routes/integration.mjs` | external clients (octo-fiesta) | batch | 1 per request | no |
| `lib/queue.mjs` | each download job | batch | `getSong` + `getAlbum` per song | `originalMetadataCache` for some |
| `routes/library.mjs` artist resolver | `GET /api/library` (queues, does not wait) | background | 1 search per unresolved artist, one every 4 s, stops on 429 | `library.db` `artist_ids`, 90 d (7 d no match) |
| `lib/autoDownloads.mjs`, `playlistSync.mjs` | startup, then every 5 min | background | up to 6 artists / playlists per tick, paged | memory only |
| `lib/tagBackfill.mjs` | Settings, "Library tags" | background | 2 per album folder (album search + album fetch); per-file search only for files the album did not explain | no |
| `lib/lyricsBackfill.mjs`, `artistCredits.mjs` | Settings | background | ISRC/UPC batches of 25, one lyrics call per track | no |
| Downloader / wrapper | per track | not covered | unknown | n/a |

The downloader (`apple-music-dl`) and the wrapper make their own requests from the same
IP. They are not counted by the gateway; only the number of concurrent download jobs
limits them.

## The gateway (`lib/appleGateway.mjs`)

All Apple calls are admitted by one gateway. The importer's old fixed 1.5 s spacer
(`requestSpacer.mjs`) is gone; the gateway does that job for every caller.

- **Lanes.** The lane of a call follows the async context (`AsyncLocalStorage`):
  `server.mjs` puts every request to `/api/internal` and `/api/integration` in `batch` and
  all other API requests in `interactive`; download jobs run in `batch`; schedulers,
  backfills and the artist resolver explicitly run in `background`. Code that sets
  nothing is `background`, so it cannot crowd out a person.
- **Order.** Interactive first, but while interactive calls keep arriving every 4th
  dispatch is a batch one. Background only runs when the other lanes are empty.
- **Rate.** One dispatch per gap. Interactive calls may burst (4 saved up while idle);
  batch and background are strictly spaced. At most 2 calls in flight.
- **Adaptive gap.** Starts at `APPLE_GATEWAY_INTERVAL_MS` (1500). After 100 successes in
  a row it shrinks 10%, down to the floor (`APPLE_GATEWAY_MIN_INTERVAL_MS`, 600). On a 429
  it doubles (cap 8 s) and the floor rises to 125% of the pace that failed, so the gateway
  never goes back to a rate that is known to be too fast.
- **Cooldown.** After a 429 every call fails locally, with no request to Apple, for
  `APPLE_429_COOLDOWN_MS` (15 min). A repeat within 24 h doubles it, then doubles again
  (15, 30, 60 min). Queued calls are rejected at once. When the time is up one probe call
  goes out; only a success reopens the gateway. `APPLE_429_COOLDOWN_MS=0` disables the block.
- **Persistence.** Gap, floor, cooldown end, strike count and the last 20 rate limits are
  kept in `/config/apple-rate.json`, so a restart neither forgets a ban nor the learned rate.
- **Sharing.** Identical requests made at the same time (same lane, URL and language) share
  one call.
- **Errors.** `AppleRateLimitedError` (message `Apple API 429 on ...`, `retryAfterSec`) is
  what callers see. Routes answer 429 with `Retry-After` and a readable message instead of
  502; `/api/internal` sends `Retry-After` to the importer.
- **Long jobs wait, they do not fail.** `lib/appleWait.mjs` pauses a backfill until Apple
  should accept calls again and reports `waitingUntil`, which the Settings card shows as a
  countdown. A rate limit is never counted as "unmatched".

Pacing can be changed in Settings → "Apple Music API" (starting gap, fastest gap, adaptive
on/off, pause after a rate limit; stored in `settings.json` as `appleGatewayIntervalMs`,
`appleGatewayMinIntervalMs`, `appleGatewayAdaptive`, `appleGatewayCooldownMinutes`, empty =
default; the env variables are the defaults). "Forget this limit" clears the floor learned from
past 429s. The floor learned from 429s is kept apart from the configured minimum: lowering the
minimum does not undo what a 429 taught.

Visibility: every call logs `[apple] <status> <lane> <path> <ms> (+queued ms) via <caller>
egress=<ipv4>/<ipv6>`, a 429 logs the previous 60 s of calls per lane and caller,
`GET /api/settings/apple-status` (also `apple` in `/api/internal/health`) reports state,
gap, queue depth per lane and 429 count, and Settings has an "Apple Music API" card.

Verified in the local Docker stack against the mock (`docker-compose.dev.yml`), with a
UI burst, a 12-search import and the artist resolver at the same time and a fake limit of
5 req/s: no 429; UI calls were answered immediately, import calls were spaced 1.5 s apart,
the resolver ran only in the gaps. With the mock banning after 5 calls, the tag backfill
paused ("Paused: Apple is rate limiting this server..."), resumed when the block ended and
stamped all 18 files with none counted as unmatched.

## Fewer calls

- **Importer** (`importer/lib/importSession.mjs`): a track costs at most two searches
  instead of three. The reversed-order query is gone (Apple's search ignores word order and
  the matcher already handles swapped title/artist on the same results); the title-only
  fallback is skipped when it equals the first query; identical queries are answered from a
  30-minute in-memory cache, so repeated titles and re-imports cost nothing.
- **ISRC batches**: a track that carries an `isrc` (a parser can set it; plain-text lines may
  contain one, e.g. `Song - Artist [USAAA0000001]`) is looked up with
  `GET /api/internal/songs-by-isrc` (up to 25 ISRCs, one Apple `filter[isrc]` call). Whatever
  Apple does not return falls back to the text search. No current URL parser supplies ISRCs.
- **Download jobs**: `getAlbum` keeps its answer for 10 minutes (`fresh: true` skips it), so
  enqueueing a song and every other song of the same album share one lookup. Songs that come
  with their album id (importer, search results) need no `getSong` call at all.
- **Rate limit visibility in the importer**: while the backend waits out a 429 the affected
  item shows "Apple is rate limiting this server, retrying in about N min…".

## Downloader and wrapper

Checked against the upstream `zhaarey/apple-music-downloader` source (`main`; the image is
pinned to an older commit, so this is not a guarantee about that exact build):

- The downloader has no pacing, retry or 429 handling at all (the only timer is a download
  idle timeout). Per run it scrapes `music.apple.com` for a token, calls the amp-api for the
  album (and the song manifest for the folder-format quality), and per track asks the wrapper
  for the best m3u8, the decryption keys and the lyrics (`lite-server`). It is only limited by
  how many download jobs alacarte runs at once.
- The wrapper is not only login. Its ports are 10020 decrypt (FairPlay key requests per
  track), 20020 M3U8 and 30020 account/storefront; the login is one use of the account port.
  These requests go to Apple's store/playback services through the Android Apple Music stack,
  not the catalog API, and leave from the same IP. How strict Apple is about them is not known.

Neither is covered by the gateway; the concurrency of download jobs is the only brake.

## Still open

- Persistent response cache in `library.db` (search results, album/artist metadata); the
  importer query cache and the album cache are in memory only.
- Parsers that can supply ISRCs (none of the URL parsers does today).
- `getSong` + `getAlbum` when a song arrives without an album id (needs the album's track
  list for naming, so it stays two calls for now).
- Calls made by the downloader and wrapper are not paced by the gateway.
- Schedulers keep their startup run; a restart plus page load can still stack bursts
  (bounded by the gateway, and visible in the logs).
- The real threshold is still unknown. After a few real imports the `[apple]` 429
  summaries and the learned floor in `apple-rate.json` show where it is, and the defaults
  above should be tuned from that.
