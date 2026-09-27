# Task: Fix Subpath Asset Resolution & API Routing in Importer

## Problem Description
When `importer` is deployed under a reverse proxy subpath (e.g., `BASE_PATH=/import` or `IMPORTER_BASE_PATH=/import`), the Node.js server correctly mounts routes and serves static files under `${BASE_PATH}/assets/...` (e.g., `/import/assets/index-*.js`).

However, because the Docker container image is built with Vite's default build-time base (`VITE_BASE_PATH=/`), the bundled `public/index.html` hardcodes root-relative asset paths:
```html
<script type="module" crossorigin src="/assets/index-t0floFeG.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-D92IbV_x.css">
```

When a browser opens `https://<domain>/import/`:
1. The browser requests `/assets/...` instead of `/import/assets/...`. Under a reverse proxy, this hits the root application instead of the importer, causing 404s or authentication redirect errors.
2. Any frontend `fetch()` calls that use absolute paths like `/api/import/...` or `/api/auth/...` similarly bypass the subpath and fail.

---

## Required Fixes

### 1. Frontend Vite Config (`importer/frontend/vite.config.ts`)
Change the fallback base path to relative `'./'` instead of `'/'`:
```ts
base: process.env.VITE_BASE_PATH || './',
```
This ensures Vite builds asset references as `./assets/...`, allowing the frontend to load correctly regardless of whether it is hosted at `/` or any arbitrary subpath like `/import/`.

### 2. Frontend API Client Calls
Audit all frontend API requests (`fetch('/api/...')`).
Ensure API calls either:
- Use relative paths (`api/import/...`), OR
- Prepend `import.meta.env.BASE_URL` (or a window-injected base path), so they target `${BASE_PATH}/api/...` instead of root `/api/...`.

### 3. Runtime HTML Transformation in Server (`importer/server.mjs`)
As defense-in-depth for pre-built images or dynamic deployments, when serving `index.html` via Express in `server.mjs`:
```javascript
const publicDir = path.join(__dirname, 'public')
if (fs.existsSync(publicDir)) {
  root.use(express.static(publicDir, { index: false, maxAge: '1h' }))

  root.get(/^\/(?!api\/).*/, (_req, res) => {
    let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    if (BASE_PATH !== '/' && !html.includes(`"${BASE_PATH}/assets/`)) {
      html = html.replaceAll('="/assets/', `="${BASE_PATH}/assets/`)
                 .replaceAll("='/assets/", `='${BASE_PATH}/assets/`)
    }
    res.type('html').send(html)
  })
}
```

---

## Verification Checklist

- [ ] Build and test locally with `BASE_PATH=/import`:
  - `GET /import/` delivers HTML referencing `./assets/` or `/import/assets/`.
  - Static asset files resolve with HTTP 200 at `/import/assets/...`.
  - Frontend API endpoints like `/import/api/auth/session` and `/import/api/import` succeed.
