#!/usr/bin/env bash
set -e

# Apply any pending Prisma migrations against the configured DATABASE_URL.
# Safe to run on every boot — `migrate deploy` only applies un-applied migrations.
echo "[entrypoint] applying database migrations (prisma migrate deploy)…"
npx prisma migrate deploy

echo "[entrypoint] starting Moxie Ops…"
exec "$@"
