# Deployment

Primary target: **Coolify** (Docker Compose). The app needs a real, persistent
container — it drives a headless Chromium (Tira + GRN-portal scrapers) and runs
in-process schedulers — so a container host is the right fit.

---

## Coolify (recommended — this is what we deploy on)

**New Application → Docker Compose build pack:**
- **Repository:** `moxie-ops`
- **Branch:** `main`
- **Build Pack:** Docker Compose
- **Base Directory:** `/`
- **Docker Compose Location:** `/docker-compose.yaml`

`docker-compose.yaml` builds the app image from `Dockerfile` (Playwright base →
Chromium included) and brings up Postgres alongside it. The entrypoint runs
`prisma migrate deploy` on every boot.

### Environment variables (Coolify → app → Environment Variables)
Add **everything from `.env.local`** (it's not in the repo by design). At minimum:
- `CRON_SECRET` — not strictly required here (schedulers are in-process), but set it
  if you want the `/api/cron/*` routes locked down.
- `NEXT_PUBLIC_APP_URL` — your public URL (e.g. `https://ops.moxiebeauty.in`). The
  schedulers use it to call their own cron endpoints.
- `RESEND_*`, `PO_TEST_EMAIL_SMTP_*`, `WMS_*`, `TIRA_USER_ID` / `TIRA_PASSWORD`,
  `NYKAA_*`, `ZEPTO_*`, `BLINKIT_*`, etc.
- **Database:** the bundled `db` service is used by default (internal-only). To use a
  managed Postgres instead, set `DATABASE_URL` and it overrides the bundle.

### Domain
Set a domain on the **app** service in Coolify; its Traefik proxy routes the domain
(with SSL) to the exposed port 3000.

### Scheduling
Runs **in-process** (`instrumentation.ts`): Tira at 09:00 IST, the other channels +
WMS every 3h. **Keep it a single replica** — scaling would double-fire the timers.
(`vercel.json` is ignored on Coolify; it's only for a Vercel deploy.)

### Resources
The Playwright base image is ~1.7 GB; give the build host enough disk + RAM for
`next build` and `npx playwright install chromium`.

---

## Local (same image)

```bash
docker compose up -d --build      # add a `ports: ["3000:3000"]` to the app service for host access
```

Or plain dev: `npm install && npx prisma generate && npm run dev`.

---

## The Playwright caveat (only matters off-Coolify)

Two features need a real browser: **Tira** scrape (`lib/integrations/tira/browser.ts`)
and the **GRN portal** scrape (`lib/integrations/playwright.ts`). They work on any
container host (Coolify, Render, Railway, Fly, a VM) because Chromium is in the image.
They **do not** work on serverless (Vercel) — no Chromium, ephemeral read-only FS.

If you ever move the web app to **Vercel**: it would host everything *except* those
two. `vercel.json` already has Vercel Cron for the fetch-based channel syncs, and the
in-process timers auto-disable there (`process.env.VERCEL`). You'd run Tira on a small
always-on container (this image) against the same `DATABASE_URL`, with only
`TIRA_AUTO_SYNC=true` and the other `*_AUTO_SYNC=false`. Vercel needs the Pro plan
(sub-daily cron + 300s functions); cron times are UTC (9 AM IST = `30 3 * * *`).

---

## Notes
- `next build` runs ESLint and fails on lint errors — keep it clean.
- Secrets live only in the host's env / Coolify UI; never commit them.
