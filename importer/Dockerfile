# Build the frontend (Vite outputs to importer/public via outDir: '../public').
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY importer/frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY importer/frontend ./
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY importer/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY importer/server.mjs ./
COPY importer/lib ./lib
COPY importer/parsers ./parsers
COPY importer/routes ./routes
COPY --from=frontend-build /app/public ./public

EXPOSE 8080
CMD ["node", "server.mjs"]
