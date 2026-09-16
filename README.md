# ALACarte

Self-hosted Apple Music downloader with a polished web UI.

<div align="center">
  <img src="./assets/hero-album.png" alt="ALACarte Album Detail View" width="100%" />
</div>

## What it is

ALACarte is a browser-based tool that downloads lossless audio from Apple Music, converts it to FLAC, and organizes it into a clean library structure you can point any media server at.

- **Search & Discover:** Full access to the Apple Music catalog (albums, artists, songs, playlists).
- **Lossless & Hi-Res:** Download ALAC streams and auto-convert to FLAC with embedded artwork and metadata.
- **Lyrics Support:** Fetch embedded lyrics and sidecar `.lrc` files (requires `media-user-token`).
- **Smart Queuing:** Queue individual tracks, whole albums, playlists, or bulk-select entire artist discographies (filtered by LPs/EPs/Singles).
- **Library Awareness:** Duplicate prevention visually flags what is already in your library so you don't re-download.
- **Explicit / clean filtering:** Apple lists explicit and clean masters as separate albums. Pick your preference in Settings (or show both) to keep search results tidy.
- **Follow Artists:** Follow an artist to auto-download new releases as they drop. Choose to grab their current discography on follow or only watch for future releases. ALACarte checks on a self-tuning schedule (configurable in Settings) that scales with your roster size to stay well under Apple's daily API limits.

Output lands in `/music/<Artist>/<Album>/01. Track.flac` (or `/music/<Artist>/Singles/` for individual songs). Playlist downloads are merged into the same artist/album library structure and also emit `/music/Playlists/<Playlist>.m3u8` with relative paths so Jellyfin/Navidrome can import playlist order.

---

## Beautiful and functional. Not just on the desktop.

<table style="border: none;">
  <tr>
    <td width="50%" align="center">
      <img src="./assets/mobile-showcase.png" alt="Mobile UI Showcase" />
      <br />
      <b>Fully responsive design</b><br />
      Search, queue, and manage your library effortlessly from your phone.
    </td>
    <td width="50%" align="center">
      <img src="./assets/status-dashboard.png" alt="Status Dashboard" />
      <br />
      <b>Complete system visibility</b><br />
      Watch your server work in real-time with an SSE-backed console, live job tracking, and granular health metrics.
    </td>
  </tr>
</table>

---

## Disclaimer
**This tool is for personal archival use only.** Downloading music you do not have a valid subscription/license for violates Apple's Terms of Service. You are responsible for ensuring your use complies with applicable terms and laws in your jurisdiction.

---

## Requirements

- **`linux/amd64` (x86_64)** — the FairPlay wrapper binary and the upstream downloader image are amd64-only. On Apple Silicon Macs, Docker Desktop transparently emulates amd64 via Rosetta. On native arm64 Linux (Raspberry Pi, ARM cloud VPS), enable `qemu-user-static` / `binfmt_misc` to run amd64 containers, or use an x86_64 host.
- Docker & Docker Compose (or standalone Docker engine)
- An **Apple Music paid subscription**

## Pre-built Container Images

Official automated builds are published to GitHub Container Registry (GHCR) on every push to `main` and release tag:

- **Web UI & Backend**: `ghcr.io/hereisderek/alacarte-web:latest` (or pinned by tag/commit sha, e.g. `:sha-dc0eecf`)
- **Decryption Wrapper**: `ghcr.io/hereisderek/alacarte-wrapper:latest` (or pinned by tag/commit sha)

---

## Hosting & Deployment

You can run ALACarte either using **Docker Compose** (recommended) or standalone **Docker CLI (`docker run`)**.

### Option 1: Docker Compose (Recommended)

You don't need to clone the full repository to deploy. You can create a new folder with just `docker-compose.yml` and `.env`:

1. Create a project directory:
   ```bash
   mkdir alacarte && cd alacarte
   ```

2. Create `.env`:
   ```env
   # Required: Path to your host music library folder
   MUSIC_PATH=/path/to/your/music/library

   # Optional port (default 7373)
   WEB_PORT=7373

   # Optional: set to 127.0.0.1 to restrict access to localhost only (behind reverse proxy)
   WEB_BIND=0.0.0.0

   # Optional: disable built-in password gate if using external auth (Authelia, Cloudflare Access)
   AUTH_DISABLED=false
   ```

3. Create `docker-compose.yml`:
   ```yaml
   services:
     wrapper:
       image: ghcr.io/hereisderek/alacarte-wrapper:latest
       container_name: alacarte-wrapper
       platform: linux/amd64
       volumes:
         - ./data/wrapper:/app/rootfs/data
         # Android chroot device nodes required by FairPlay decryptor
         - /dev/null:/app/rootfs/dev/null
         - /dev/urandom:/app/rootfs/dev/urandom
         - /dev/random:/app/rootfs/dev/random
         - /dev/zero:/app/rootfs/dev/zero
       expose:
         - "10020"
         - "20020"
         - "30020"
         - "40020"
       networks:
         - alacarte-net
       restart: on-failure

     web:
       image: ghcr.io/hereisderek/alacarte-web:latest
       container_name: alacarte-web
       platform: linux/amd64
       depends_on:
         - wrapper
       environment:
         - PORT=7373
         - AMDL_WRAPPER_HOST=alacarte-wrapper
         - AMDL_WRAPPER_DECRYPT_PORT=10020
         - AMDL_WRAPPER_M3U8_PORT=20020
         - AMDL_WRAPPER_ACCOUNT_PORT=30020
         - AMDL_WRAPPER_SUPERVISOR_PORT=40020
         - AMDL_MUSIC_PATH=/music
         - AMDL_CONFIG_DIR=/config
         - AMDL_SECRET_KEY=${AMDL_SECRET_KEY:-}
         - AUTH_DISABLED=${AUTH_DISABLED:-false}
         - TRUST_PROXY=${TRUST_PROXY:-loopback}
       volumes:
         - ./data/web:/config
         - ${MUSIC_PATH:?Set MUSIC_PATH in .env}:/music
         - ./data/wrapper:/wrapper-data
       ports:
         - "${WEB_BIND:-0.0.0.0}:${WEB_PORT:-7373}:7373"
       networks:
         - alacarte-net
       restart: unless-stopped

   networks:
     alacarte-net:
       name: ${DOCKER_NETWORK:-alacarte-net}
       external: ${DOCKER_NETWORK_EXTERNAL:-false}
   ```

4. Start the stack:
   ```bash
   docker compose up -d
   ```

5. Retrieve the first-time setup token:
   ```bash
   docker compose logs alacarte-web
   ```
   Open `http://<your-host-ip>:7373`, paste the token from the logs, set up your admin credentials, and go to **Settings → Apple Account** to log in.

---

### Option 2: Docker CLI (`docker run`)

If you prefer running standalone `docker run` commands without Docker Compose:

1. **Create the shared network:**
   ```bash
   docker network create alacarte-net
   ```

2. **Create local storage directories:**
   ```bash
   mkdir -p ./data/wrapper ./data/web
   ```

3. **Start the FairPlay decryption wrapper:**
   ```bash
   docker run -d \
     --name alacarte-wrapper \
     --platform linux/amd64 \
     --network alacarte-net \
     --restart on-failure \
     -v "$(pwd)/data/wrapper:/app/rootfs/data" \
     -v /dev/null:/app/rootfs/dev/null \
     -v /dev/urandom:/app/rootfs/dev/urandom \
     -v /dev/random:/app/rootfs/dev/random \
     -v /dev/zero:/app/rootfs/dev/zero \
     ghcr.io/hereisderek/alacarte-wrapper:latest
   ```

4. **Start the web backend & downloader:**
   ```bash
   docker run -d \
     --name alacarte-web \
     --platform linux/amd64 \
     --network alacarte-net \
     --restart unless-stopped \
     -p 7373:7373 \
     -e PORT=7373 \
     -e AMDL_WRAPPER_HOST=alacarte-wrapper \
     -e AMDL_WRAPPER_DECRYPT_PORT=10020 \
     -e AMDL_WRAPPER_M3U8_PORT=20020 \
     -e AMDL_WRAPPER_ACCOUNT_PORT=30020 \
     -e AMDL_WRAPPER_SUPERVISOR_PORT=40020 \
     -e AMDL_MUSIC_PATH=/music \
     -e AMDL_CONFIG_DIR=/config \
     -e AUTH_DISABLED=false \
     -e TRUST_PROXY=loopback \
     -v "$(pwd)/data/web:/config" \
     -v "/path/to/your/music/library:/music" \
     -v "$(pwd)/data/wrapper:/wrapper-data" \
     ghcr.io/hereisderek/alacarte-web:latest
   ```

5. **Complete initial setup:**
   ```bash
   docker logs alacarte-web
   ```
   Copy the one-time token and navigate to `http://localhost:7373`.

---

## Volume & Persistence Reference

| Container Path | Host Recommended | Purpose |
|----------------|------------------|---------|
| `alacarte-web:/config` | `./data/web` | Web settings (`settings.json`), auth state, encryption key (`.secret`), sync history |
| `alacarte-web:/music` | `/path/to/music` | Destination music library where organized folders and tracks land |
| `alacarte-web:/wrapper-data` | `./data/wrapper` | Shared data mount with wrapper (allows fast file drops for 2FA) |
| `alacarte-wrapper:/app/rootfs/data` | `./data/wrapper` | Stores cached Apple account credentials and decryption tokens |
| `alacarte-wrapper:/app/rootfs/dev/*` | `/dev/*` | Android chroot device nodes needed for crypto/random generation |

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7373` | Internal listening port for the web service |
| `WEB_PORT` | `7373` | Exposed host port in `docker-compose.yml` |
| `WEB_BIND` | `0.0.0.0` | Host IP to bind to (`127.0.0.1` locks UI to local host only) |
| `AMDL_MUSIC_PATH` | `/music` | Path to music library inside web container |
| `AMDL_CONFIG_DIR` | `/config` | Path to persistent configuration inside web container |
| `AMDL_WRAPPER_HOST` | `alacarte-wrapper` | Hostname or IP of the wrapper container |
| `AMDL_WRAPPER_DECRYPT_PORT` | `10020` | Port for wrapper decrypt service |
| `AMDL_WRAPPER_M3U8_PORT` | `20020` | Port for wrapper M3U8 stream service |
| `AMDL_WRAPPER_ACCOUNT_PORT` | `30020` | Port for wrapper account info service |
| `AMDL_WRAPPER_SUPERVISOR_PORT` | `40020` | Port for wrapper supervisor HTTP control API |
| `AUTH_DISABLED` | `false` | Set to `true` to disable built-in password authentication |
| `TRUST_PROXY` | `loopback` | Express trust proxy setting for reverse proxies |
| `AMDL_SECRET_KEY` | *(auto-generated)* | 64-hex char key for encrypting credentials at rest |

---

## Upgrade Notes

To update an existing deployment to the latest build:

- **With Docker Compose**:
  ```bash
  docker compose pull
  docker compose up -d
  ```
- **With Docker CLI**:
  ```bash
  docker pull ghcr.io/hereisderek/alacarte-wrapper:latest
  docker pull ghcr.io/hereisderek/alacarte-web:latest
  docker stop alacarte-web alacarte-wrapper
  docker rm alacarte-web alacarte-wrapper
  # Re-run the docker run commands above
  ```

No manual data migration is required. Existing settings, auth credentials, and cached Apple login tokens persist seamlessly in `./data`.

## Security

ALACarte ships with a built-in single-password gate. The first time you visit the UI, you'll be prompted to set a username/password and the one-time setup token from server logs — every API endpoint and page is then locked behind it.

A few things to keep in mind:

- **Don't expose this directly to the public internet.** Several cloud providers ship hosts with permissive default firewalls. Verify your firewall, and put a reverse proxy / VPN / mesh network in front of the UI before opening it up to anything beyond your LAN.
- **Fully unprivileged containers (No Docker socket):** ALACarte operates without any access to the host Docker socket (`/var/run/docker.sock` is not required or mounted). The web backend coordinates with an internal supervisor daemon in the wrapper container over the isolated Docker bridge network, eliminating root-equivalent host access and enabling safe deployment on hardened setups, Kubernetes, and rootless container engines.
- **Tighten the bind to localhost only:** set `WEB_BIND=127.0.0.1` in `.env` if you front the app with a reverse proxy on the same machine and don't want the UI reachable on your LAN.
- **Already running your own auth?** Set `AUTH_DISABLED=true` in `.env` to skip the built-in password gate (e.g. when fronting with Authelia, Cloudflare Access, Tailscale, etc).
- **Rate limiting and lockouts are built in** for setup/login/password-change routes (429 + Retry-After + temporary lockouts).
- **Sessions support revoke-all** from Settings → Account ("Sign out on all devices").
- **Password hashing uses memory-hard scrypt** (`N=131072, r=8, p=1`).
- **Trust proxy and secure cookies:** set `TRUST_PROXY` correctly when running behind a reverse proxy so HTTPS detection and cookie security are accurate.
- **Existing users are preserved:** current encrypted Apple credentials in `data/web/settings.json` continue to decrypt after upgrading.
- **Change or reset:** the password lives at `data/web/auth.json`. Change it from Settings → Account, or reset by deleting that file and restarting the container — the next visit will prompt for a new one.

## First login flow

ALACarte needs to authenticate with Apple to obtain decryption tokens. This happens once, then the session persists across container restarts.

1. Enter your credentials in Settings and click Save.
2. If Apple requires 2FA, you'll see a prompt asking for the 6-digit code. If a trusted device only shows Allow / Not Me, generate a code from Settings → Apple ID → Sign-In & Security → Get Verification Code.
3. Enter the code within ~2 minutes.
4. When you see "Ready", you're good to search and download.

### Sign-in troubleshooting

If Apple sign-in fails, check these first:

1. Confirm the Apple ID has an active Apple Music subscription on `music.apple.com`.
2. Confirm the Apple ID has signed into Apple Music at least once on a real Apple device or on the web app.
3. Confirm DNS, firewall, VPN, and proxy rules allow the host to reach Apple's services.
4. Confirm the storefront in Settings matches the Apple ID's region.
5. Confirm you're running the latest image/build (newer builds include login parser fixes and richer wrapper diagnostics).

Wrapper response type 4 is a generic StoreServices failure, not a credential diagnosis. Use the server message and StoreServices error in the failure log to narrow it down before retrying; repeated attempts can trigger an Apple account lockout. If the failure log shows a `StoreServices error` with a very large negative number, that came from an older wrapper build — rebuild with `docker compose build --no-cache wrapper` to get the real error code.

## How downloads behave

- Jobs run **one at a time** — queuing many items won't speed things up, it just lines them up.
- Download speed is throttled by Apple and varies by time of day.
- After a download completes, each track is converted from ALAC to FLAC and moved into your library (although you can disable this in the settings).
- The queue survives page refreshes but not container restarts.
- If a job fails (network hiccup, decryption glitch), you can re-queue it manually.

## Notes and limits

**IP rate-limiting and proxies** Apple appears to rate-limit by IP if you query huge amounts of data at once. In my experience, this isn't a permanent ban, I got soft-blocked for about a day after downloading ~1500 songs. If you plan to archive massive collections, consider:
- Spreading large jobs across multiple days
- Running behind a VPN or proxy
- Using a container with separate networking

**Storage** - Lossless albums are ~300–600 MB each.
- By default, temporary staging is written to `/tmp/alacarte-staging` while jobs run.
- You can switch staging location in Settings → Library output.
- Stale job staging folders older than 24 hours are pruned on app boot and every 6 hours afterwards.
- If your host's `/tmp` is tmpfs (RAM-backed), large downloads can exhaust memory. Either bind-mount a disk path to `/tmp/alacarte-staging` in your compose override, or toggle "Store temp staging inside music library" on.
- If you intentionally point staging inside your music library, configure your scanner to ignore hidden directories.

**Sharing a network with Jellyfin/Plex/etc.** By default ALACarte creates its own `alacarte-net` Docker network. If you'd rather attach to an existing network (e.g. the one your media server already uses), set `DOCKER_NETWORK=<name>` and `DOCKER_NETWORK_EXTERNAL=true` in `.env`.

**Local compose tweaks** If you need to change things the `.env` variables don't cover (extra volumes, additional environment, etc.), drop a `docker-compose.override.yml` next to the main compose file. Docker Compose auto-merges it and it's gitignored, so you can run `docker compose up` normally without polluting the committed config.

**Navidrome Integration** ALACarte includes built-in support for triggering Subsonic API scans in Navidrome. Once you configure your Navidrome credentials in the Settings panel, ALACarte will instantly instruct your server to quick-scan the library the exact moment a download completes. No more waiting for hourly cron jobs!

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|--------------|-----|
| "Sign in required" health warning | Wrapper isn't authenticated | Go to Settings and complete the login flow |
| "Wrapper supervisor not reachable" | Wrapper container down or still starting | Verify the wrapper container is healthy via `docker compose ps` and `docker compose logs alacarte-wrapper` |
| Downloads stuck at 0% | Apple token expired or wrapper down | Wait a moment; it will auto-retry. If still stuck, restart the stack |
| Tracks show "failed" | Temporary Apple/server hiccup | Re-queue the album; transient failures usually clear |
| FLAC files are truncated | MP4Box runtime issue | Rebuild the container image and redeploy |

## Architecture

ALACarte runs on a shared Docker network with three primary components:
- **web:** This repository. It wraps the downloader CLI as a child process and serves the React SPA on port `7373`.
- **amdp:** The underlying downloader binary, included at build time.
- **wrapper:** A FairPlay decryption daemon that handles the DRM removal, included at build time.

## Credits

Built upon:
- [zhaarey/apple-music-downloader](https://github.com/zhaarey/apple-music-downloader)
- [WorldObservationLog/wrapper](https://github.com/WorldObservationLog/wrapper)

The UI design was heavily inspired by the beautiful [Abyss theme](https://github.com/AumGupta/abyss-jellyfin), which was then customized and expanded from the ground up for this project.

## License

AGPL-3.0 — see LICENSE

This tool interacts with Apple Music services. You are responsible for ensuring your use complies with Apple's Terms of Service and applicable laws in your jurisdiction.
