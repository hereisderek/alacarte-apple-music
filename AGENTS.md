# AGENTS.md

Operational and development guidelines for this repository.

## 1. Fork Architecture & Upstream Synchronization

- **Minimal Core Changes**: Keep changes in `frontend/` and `backend/` strictly minimal to allow clean, painless rebases and merges from upstream (`sosjalapeno/alacarte`).
- **Self-Contained Importer**: The batch music importer lives in its own directory (`importer/`) with its own frontend and Express backend.
  - Integration with the main application is restricted to a minimal, isolated internal API router:
    - `backend/routes/internal.mjs` (mounted under `/api/internal`)
    - `backend/lib/requireInternalKey.mjs` (API key authentication)
    - `backend/lib/requestSpacer.mjs` (request pacer)
  - `backend/server.mjs` only adds the mount for `/api/internal`. Do not modify other core backend routes or the main React frontend for importer features.

## 2. Apple Music API & Rate-Limiting Constraints (429 Prevention)

Apple's Fastly edge CDN (`daiquiri/5`) rate-limits per individual IP address (including individual `/128` IPv6 addresses). Once tripped, Apple issues `HTTP 429 Too Many Requests (42900: Request is forbidden)`, which invalidates all search and catalog calls for 15–60 minutes.

To guarantee zero 429 bans:
- **Minimize API Requests to the Absolute Minimum**: Never make unnecessary, speculative, or redundant calls to Apple Music's catalog API (`amp-api.music.apple.com`).
- **No Upfront Batch Lookups**: Never resolve catalog artist or album IDs synchronously across an entire library during page loads or snapshots (e.g. `GET /api/library`). Local library scanning must remain purely local (reading disk/SQLite in under 50ms).
- **Mandatory Pacing**: Any batch, automated, or importer search queries against Apple's catalog API must be serialized through a pacer (e.g. `requestSpacer.mjs`) with a minimum interval of at least **1500ms** between dispatch times.
- **Persistent Caching**: Never store resolved catalog IDs or metadata exclusively in memory where restarts will trigger re-query storms. Any catalog lookups must be persisted on disk or in SQLite (`library.db`).
- **Graceful Fallbacks**: Frontend components must handle missing catalog IDs gracefully by linking to `/search?q=...` or performing on-demand resolution upon direct user interaction, rather than pre-fetching in bulk.

See [docs/apple-rate-limits.md](docs/apple-rate-limits.md) for the incident history, the list of Apple callers, and the plan for a shared rate-limited gateway.

## 3. Testing & CI

- Run backend tests: `npm test` inside `backend/`
- Run importer tests: `npm test` inside `importer/`
- CI builds all 3 Docker images (`web`, `wrapper`, `importer`) via `.github/workflows/docker-build.yml`.
