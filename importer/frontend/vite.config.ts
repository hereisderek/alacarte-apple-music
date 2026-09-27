import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built into importer/public so importer/server.mjs can serve it. `base`
// must match the BASE_PATH the server (and any reverse proxy in front of
// it) is configured with — see importer/README.md.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
