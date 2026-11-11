# GT-ADS-001 – API-Image (Dev/Test). Kein latest-Tag.
FROM node:22.23.4-bookworm-slim AS deps

WORKDIR /app

# Nur Manifeste kopieren, damit die Abhaengigkeitsschicht cachebar bleibt.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json

RUN npm ci --workspace @gt-ads/api --include-workspace-root

FROM node:22.23.4-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api ./apps/api

USER node

EXPOSE 8080

CMD ["node", "apps/api/dist/index.js"]
