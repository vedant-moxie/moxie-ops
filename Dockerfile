# syntax=docker/dockerfile:1
#
# Moxie Ops — production image.
#
# Base = Microsoft Playwright (Ubuntu 22.04 "jammy"). It ships Chromium + all the
# system libraries the Tira / Nykaa headless scrapers need, and bundles Node 20.
# Pinned to the same Playwright version as package.json (^1.49.1) so the bundled
# browser revision matches the npm package.

FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS base
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NEXT_TELEMETRY_DISABLED=1

# ---------- deps: install ALL node modules (dev deps are needed to build) ----------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder: prisma generate (in `npm run build`) + next build ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# lib/env.ts validates DATABASE_URL at import; a dummy satisfies the build — no DB
# connection is made during `prisma generate` or `next build`.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

# ---------- runner ----------
FROM base AS runner
# PORT is read by `next start`; 3003 avoids clashing with other apps on the host.
ENV NODE_ENV=production \
    PORT=3003
# node_modules carries the generated Prisma client AND the prisma CLI (a dev dep)
# used by the entrypoint to run migrations at startup.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Ensure the Chromium revision matches the installed playwright package, and make
# the entrypoint executable.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && npx playwright install chromium
EXPOSE 3003
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
