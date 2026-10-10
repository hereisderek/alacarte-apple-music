# Music Import (public batch import service)

A small, separate service that lets other people paste a song list or a
playlist link and get it queued into the main alacarte backend's Apple Music
download queue — without giving them the owner-facing app's full control
surface (auth management, wrapper health, settings, etc).

It never talks to the main backend over its public port. It calls a small,
separately-guarded `/api/internal/*` surface on the main backend
(`backend/routes/internal.mjs`) over the private docker network, using a
shared secret (`INTERNAL_API_KEY`) instead of the owner's session cookie.

See [SUPPORTED_LINKS.md](SUPPORTED_LINKS.md) for what kinds of input it can
parse today.

## How it works

1. Paste a plain-text list (`Title - Artist` per line) or a playlist URL.
2. The matching parser (see `parsers/`) resolves it to a track list (+ a
   title, when the source has one).
3. Each track is searched against the Apple Music catalog and the best match
   is auto-picked (usually the first result) and queued for download — the
   import doesn't wait for the download itself to finish, only for it to be
   queued.
4. Anything ambiguous or not found is left for you to resolve manually in the
   review list (pick from the candidates shown, or search again).
5. As queued tracks finish downloading, a local `<title>.m3u8` playlist file
   is (re)written under the music library's `Playlists/` folder — there's no
   Apple Music library-playlist *write* API in this codebase yet, so this is
   the same local-file mechanism followed playlists use, not a real Apple
   Music playlist.

Known limits: the main backend downloads one thing at a time
(`MAX_CONCURRENT = 1` in `backend/lib/queue.mjs`), so a big import still
serializes through the same queue as everything else running on that
backend. Import sessions live in memory only — they don't survive a restart
of this service.

## Running it

Off by default in the root `docker-compose.yml` (it's an optional add-on):

```bash
# in the repo root .env
INTERNAL_API_KEY=some-long-random-string   # same value the web service reads
```

```bash
docker compose --profile importer up -d --build
```

This starts `alacarte-importer` alongside `web`/`wrapper`, listening on
`IMPORTER_PORT` (default `8090`) on the host.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `INTERNAL_API_KEY` | *(required)* | Shared secret with the main backend's `/api/internal/*`. Must match the `web` service's own `INTERNAL_API_KEY`. |
| `BASE_PATH` | `/` | Path prefix this service is mounted/served at — see "Serving under a subpath" below. |
| `BACKEND_URL` | `http://web:7373` | Internal URL of the main backend. The compose file points this at the `alacarte-web` container name. |
| `AUTH_ENABLED` | `false` | Turns on the username/password gate. Leave off for a link that's already access-controlled some other way (VPN, reverse-proxy auth). |
| `IMPORTER_USERNAME` | `import` | Username when `AUTH_ENABLED=true`. |
| `IMPORTER_PASSWORD` | *(empty = login always fails)* | Password when `AUTH_ENABLED=true`. |
| `IMPORTER_SESSION_SECRET` | falls back to `INTERNAL_API_KEY` | HMAC key for the login session cookie. Set your own if you'd rather not reuse the internal API key for this. |
| `TRUST_PROXY` | `loopback` | Express `trust proxy` setting; same semantics as the main backend's. |

### Pacing (rate-limit) knobs

Apple Music's catalog-search endpoint has a tight anonymous rate limit — a
batch import of a few dozen tracks can trip it in under a minute with no
pacing at all (confirmed live: a 24-track import produced twelve 429s before
this existed). Three independent layers guard against it, all tunable:

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `APPLE_GATEWAY_INTERVAL_MS` / `APPLE_GATEWAY_MIN_INTERVAL_MS` / `APPLE_429_COOLDOWN_MS` | main backend | `1500` / `600` / `900000` | Starting gap, fastest gap and block time after a 429 of the shared Apple limiter that every Apple call (including `/api/internal/search`) goes through. The gap adapts on its own. See `docs/apple-rate-limits.md`. |
| `IMPORTER_SEARCH_PACING_MS` | importer | `500` | Extra gap the importer itself waits between processing each track in a batch. |
| `IMPORTER_MAX_429_RETRIES` / `IMPORTER_MAX_BACKOFF_MS` | importer | `6` / `20000` | How hard the importer retries a single search that still gets rate-limited despite the pacing above, before giving up on that track. |

Raise `APPLE_GATEWAY_MIN_INTERVAL_MS` first if you're still seeing 429s in
practice; the importer-side knobs are secondary margin.

### How many Apple searches a track costs

At most two: `<title> <artist>`, and if that does not match, the title on its own. The
reversed-order query is no longer sent (Apple's search ignores word order and the matcher
already copes with swapped title/artist on the same results). Identical queries are answered
from a 30-minute in-memory cache, so repeated titles and re-imports cost nothing. A track
that carries an ISRC (see `SUPPORTED_LINKS.md`) is looked up with up to 24 others in one
request and only falls back to the text search if Apple does not return it.

### User-Agent overrides

Each source is fetched with a default browser-like User-Agent. Override it
per source, or set a generic fallback used by any source without its own
override:

| Variable | Applies to |
|---|---|
| `IMPORTER_USER_AGENT` | Generic fallback for any parser below that isn't set individually. |
| `SPOTIFY_USER_AGENT` | `parsers/spotify/` |
| `QISHUI_USER_AGENT` | `parsers/qishui/` |
| `KKBOX_USER_AGENT` | `parsers/kkbox/` (KKBOX's bot-protection is the most likely reason you'd need this — see SUPPORTED_LINKS.md) |
| `SILVERBOX_USER_AGENT` | `parsers/generic-site/silverbox.mjs` |
| `HOLIDAY_USER_AGENT` | `parsers/generic-site/holiday.mjs` |

See `importer/lib/userAgent.mjs` for the resolution order (parser-specific →
`IMPORTER_USER_AGENT` → built-in default).

### Serving under a subpath

If you're reverse-proxying this behind something like
`https://mydomain.com/sites/music-downloader/`, set `BASE_PATH` (and, at
build time, `VITE_BASE_PATH` — the compose file wires both to the same
`IMPORTER_BASE_PATH` value) to that path. The server mounts every route under
it and the frontend build embeds it into every asset URL and API call, so
whatever path your proxy forwards traffic to just needs to match:

```bash
IMPORTER_BASE_PATH=/sites/music-downloader
```

Rebuild after changing this (`docker compose --profile importer up -d --build`)
since the frontend bundle bakes the base path in at build time.
