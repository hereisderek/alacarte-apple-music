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

## Who calls Apple

Pacing exists only for the importer's search (`routes/internal.mjs`, 1.5 s FIFO spacer).

| Caller | Trigger | Calls | Paced | Persisted cache |
|---|---|---|---|---|
| `routes/library.mjs` `resolveArtistId` | every `GET /api/library` | 1 search per library artist (252) | no, concurrency 4 | memory only, 24 h |
| `routes/search.mjs` | user search | 1 | no | no |
| `routes/album.mjs`, `artist.mjs`, `playlist.mjs` | page views | 1 each | no | partial (`originalMetadataCache`) |
| `routes/internal.mjs` `/search` | importer | 1 per query, up to 3 queries per track | yes, 1.5 s | no |
| `routes/integration.mjs` | external clients (Octo/Navidrome) | 1 per request | no | no |
| `lib/queue.mjs` | each download job | `getSong` + `getAlbum`, per song | no | `originalMetadataCache` for some |
| `lib/autoDownloads.mjs` | startup, then every 5 min | up to 6 artists per tick, paged | no | memory only |
| `lib/playlistSync.mjs` | startup, then every 5 min | up to 6 playlists, 100 tracks per page | no | no |
| `lib/artistCredits.mjs`, `lyricsBackfill.mjs`, `tagBackfill.mjs` | per downloaded item | ISRC/UPC lookups, lyrics, search | no | no |
| Downloader / wrapper | per track | unknown | no | n/a |

The importer additionally retries every 429 up to 6 times (`importer/lib/backendClient.mjs`).

## Strategy

Goal: stay under Apple's limit without a fixed, pessimistic delay, so that throughput
adapts to what the address will actually tolerate.

### 1. One gateway for all Apple calls (`lib/appleApi.mjs`)

All callers already funnel through `apiGet`. Put the control there so no caller can
bypass it.

- **Priority lanes.** `interactive` (UI search, album/artist/playlist views) goes first.
  `batch` (importer, download jobs) is next. `background` (schedulers, backfills,
  artist-ID resolution) only runs when the other lanes are idle. A UI click never waits
  behind a 252-item backlog.
- **Adaptive rate (AIMD).** Start at one dispatch per 1000 ms. After 100 consecutive
  successes shorten the interval by 10%, down to a configurable floor (default 500 ms).
  On a 429, double it (cap 5 s) and remember the interval that caused it. This finds the
  fastest rate the address tolerates instead of guessing a constant.
- **Small interactive burst.** A token bucket of about 4 lets a user open a few pages at
  once without waiting, while sustained load stays at the adaptive rate.
- **Cooldown with escalation.** First 429 blocks all calls for 15 min, a repeat within
  24 h for 30 min, then 60 min. After the cooldown send one probe call; only a success
  reopens the gateway. (A flat 15 min cooldown is already implemented on this branch.)
- **Persist the state** in `/config/apple-rate.json` (cooldown end, strike count,
  learned interval), so a restart neither forgets a ban nor resets the learned rate.
- **In-flight dedupe.** Identical concurrent requests share one Apple call.

### 2. Make fewer calls

Pacing limits the damage; removing calls raises throughput.

- **`/api/library` must not resolve artists on page load.** Return the library from disk
  only (as `AGENTS.md` already requires). Resolve artist IDs on demand when the user
  opens an artist, or in the `background` lane a few per minute, writing results to
  `library.db` so they survive restarts. Unresolved artists link to `/search?q=…`.
- **Persistent response cache** in `library.db`: search results (24 h to 7 d), album,
  artist and song metadata (30 d, these rarely change). A restart or a repeated import
  then costs zero Apple calls.
- **Importer matching.** Today a track costs 1–3 searches (forward, reversed, title
  only). Skip the reversed query when the forward query returned a confident match
  candidate list, and de-duplicate identical queries across a session. When a source
  supplies an ISRC (Spotify does), look tracks up with `filter[isrc]` in batches
  instead of searching one by one. Verify the maximum batch size before relying on it.
- **Download jobs.** One `getSong` with `include=albums` instead of `getSong` plus
  `getAlbum`, and reuse the album already cached for other songs of the same album.
  Check whether Apple's `ids=` multi-fetch can cover a whole album's songs in one call.
- **Importer retries.** Stop blind retries. On 429 the backend now returns
  `Retry-After` (the cooldown); the importer pauses the session until then and resumes,
  instead of failing items or retrying every few seconds.
- **Schedulers.** Keep as they are for now. Their calls go through the `background`
  lane and show in the logs, so their share of the budget is visible. Candidate later
  change: delay the startup run by a few minutes so a restart plus page load does not
  stack bursts.

### 3. Visibility

- `[apple]` log line per call: status, path, duration, caller, egress IP (done).
- `/api/internal/health` reports `appleCooldownSeconds` (done). Extend with current
  interval, queue depth per lane, and 429 count in the last 24 h.
- The UI should show "Apple is rate limiting this server, retry in N min" on 429
  instead of `Search failed` (return 429, not 502, from `routes/search.mjs`).

### Considered and not planned

- **Switching between IPv4 and IPv6 when one is banned.** It would double the budget,
  but it works around the limit instead of respecting it, and a flagged server tends
  to get both addresses flagged. Not planned.
- **Fixed slower spacing everywhere.** Safe but wastes capacity when nothing else is
  running; the adaptive gateway gets the same safety with better throughput.

## Rollout order

1. Done on `fix/apple-request-logging`: per-call logging, flat 15 min cooldown,
   `Retry-After`, egress IP logging.
2. Stop `/api/library` page-load lookups (removes the likeliest trigger).
3. Gateway: priority lanes, adaptive interval, escalating cooldown, persisted state,
   in-flight dedupe, with unit tests using a fake clock and mocked `fetch`.
4. Persistent response cache in `library.db`.
5. Importer: no blind retry, fewer queries, ISRC batching.
6. Download-job call reduction.

After step 3 run an importer batch and read the `[apple]` logs; the learned interval
and any 429 summaries show where the real limit is, and the defaults above get tuned
from that.
