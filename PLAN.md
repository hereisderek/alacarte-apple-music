# Goal: Automate Upstream Sync, Build GHCR Docker Artifacts, and Eliminate Docker Socket Dependency in ALACarte

We are working in the forked repository `https://github.com/hereisderek/alacarte-apple-music` (forked from `https://github.com/sosjalapeno/alacarte`).

Implement the following three key enhancements:

---

## 1. Eliminate the `/var/run/docker.sock` Dependency

### Root Cause Analysis in Upstream:
In upstream `sosjalapeno/alacarte`:
- The backend (`backend/lib/wrapperLogin.mjs`) imports `dockerode` and connects to `/var/run/docker.sock`.
- When an Apple ID login occurs via the Web UI, it uses Docker Engine on the host to stop the `alacarte-wrapper` container, create a temporary container `alacarte-wrapper-login` running `wrapper -L <email>:<password> -F -H 0.0.0.0`, and then recreate/restart `alacarte-wrapper`.
- This exposes root-equivalent host access, breaks unprivileged/hardened environments (e.g. Kubernetes, Saltbox, rootless Docker), and tightly couples the web backend to Docker engine internals.

### Objective:
Optimize and refactor this flow so the web backend **no longer requires `/var/run/docker.sock`**.

### Recommended Approaches (Choose or Implement Option A or B):

#### Option A: Wrapper-Side Process Supervisor (Maintains Dual-Container Architecture)
1. In the `wrapper` container:
   - Instead of running `wrapper` directly as PID 1, run a lightweight supervisor (e.g. a small Node/Python/Go daemon or bash script with a tiny Unix socket or internal HTTP control endpoint, e.g. on internal port `40020`, or watching an IPC trigger in the shared `/app/rootfs/data` volume).
   - The supervisor starts `wrapper -H 0.0.0.0`.
   - When a login is triggered, the web container calls `http://alacarte-wrapper:40020/login` (or writes a login payload to `/wrapper-data/.login_pending`).
   - The supervisor stops `wrapper`, executes `/app/wrapper -L "$EMAIL:$PASS" -F -H 0.0.0.0`, waits for completion / 2FA, and restarts the persistent daemon.
2. In `backend/lib/wrapperLogin.mjs`:
   - Replace the `dockerode` container manipulation with direct HTTP/IPC calls to the wrapper supervisor.
   - Remove `import Docker from 'dockerode'` and delete the `/var/run/docker.sock` volume requirement from `docker-compose.yml`.

#### Option B: Unified Single Container (Cleanest & Most Portable)
1. Combine the `backend/Dockerfile` and `wrapper/Dockerfile` into a single, multi-stage image.
2. Place the wrapper chroot runtime inside `/app/wrapper` and use an init/supervisor system (like `s6-overlay`, `supervisord`, or `tini` + process runner).
3. The Node backend can directly spawn, stop, and restart the wrapper binary as a local child process.
4. Deployment becomes a single container (`ghcr.io/hereisderek/alacarte:latest`) exposing port `7373`, needing only `/config` and `/music` volumes.

---

## 2. GitHub Actions: Automated Upstream Sync Workflow

Create `.github/workflows/sync-upstream.yml`:
- **Trigger**:
  - Scheduled cron (e.g., daily at 03:00 UTC: `cron: '0 3 * * *'`).
  - Manual trigger (`workflow_dispatch`).
- **Functionality**:
  - Clones the repository with full history (`fetch-depth: 0`).
  - Configures git remote for upstream: `https://github.com/sosjalapeno/alacarte.git`.
  - Fetches upstream `main`.
  - Merges or rebases upstream `main` onto the fork's `main` branch.
  - Automatically pushes updates to `origin main` using `GITHUB_TOKEN`.
  - If merge conflicts occur, fail gracefully and create a GitHub Issue alerting about the conflict.

---

## 3. GitHub Actions: Container Build & GHCR Publish Workflow

Create `.github/workflows/docker-build.yml`:
- **Trigger**:
  - On push to `main` (including after an upstream sync).
  - On git release/tag creation (`v*`).
  - Manual trigger (`workflow_dispatch`).
- **Functionality**:
  - Target architecture: `linux/amd64` (Upstream notes the FairPlay wrapper binary and base Amdp image are amd64-only).
  - Authenticate to GitHub Container Registry (`ghcr.io`) using `GITHUB_TOKEN`.
  - Build and publish:
    - If dual-container:
      - `ghcr.io/hereisderek/alacarte-web:latest` (and `:sha-<commit>`)
      - `ghcr.io/hereisderek/alacarte-wrapper:latest` (and `:sha-<commit>`)
    - If unified single container:
      - `ghcr.io/hereisderek/alacarte:latest` (and `:sha-<commit>`)
  - Use GitHub Actions Docker layer caching (`type=gha`) for fast builds.

---

## 4. Updates to Docker Compose & Documentation

1. Update `docker-compose.yml` and `.env.example` in the repository to use the newly published `ghcr.io/hereisderek/...` images instead of local build contexts.
2. Remove all references to `/var/run/docker.sock` in `docker-compose.yml` and `README.md`.
3. Document the new security posture (fully unprivileged, no docker socket required).
