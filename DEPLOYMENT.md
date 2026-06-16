# Deployment

Two supported targets. **Read the Playwright caveat before choosing Vercel.**

---

## ⚠️ The one hard constraint: Playwright / Chromium

Two features drive a **real headless browser** server-side and therefore **cannot run on Vercel** (serverless functions have no Chromium and an ephemeral, size-limited, read-only filesystem):

| Feature | Code | Vercel? |
|---|---|---|
| **Tira** scrape (`/api/tira/sync`, daily cron, the "Sync from Tira" button) | `lib/integrations/tira/browser.ts` (Playwright) | ❌ |
| **GRN portal scrape** (`/api/cron/scrape-portals`) | `lib/integrations/playwright.ts` | ❌ |

Everything else (Blinkit / Zepto / Instamart / Nykaa syncs, WMS stock, email polling, the whole UI/API) is plain HTTP/IMAP and **works fine on Vercel**.

So pick:

- **Option A — one container host (simplest, everything works).** Deploy the Docker image to an always-on host (Render / Railway / Fly.io / a VM). Tira + GRN scrape + all schedulers work. No Vercel.
- **Option B — Vercel + a small Tira worker (hybrid).** Vercel runs the app and the fetch-based crons; one cheap always-on container runs **only** Tira against the same database.

---

## Option A — Docker (container host)

```bash
docker compose up -d --build
```

- `Dockerfile` (Playwright base → Chromium included) + `docker-compose.yml` (Postgres + app).
- Entrypoint runs `prisma migrate deploy` on boot.
- Put all secrets in `.env.local` (gitignored); compose overrides `DATABASE_URL`/`NEXT_PUBLIC_APP_URL` to point at the `db` service.
- **Run a single app instance** — the in-process schedulers (`instrumentation.ts`) use timers that would double-fire if scaled. (They auto-disable on Vercel.)
- Tira PDFs persist in the `podoc` volume.

This is the recommended path for a browser-dependent app.

---

## Option B — Vercel (+ Tira worker)

### Vercel app
1. Import the repo. Framework auto-detected (Next.js 14).
2. **Env vars** (Project → Settings → Environment Variables): everything from `.env.local` — `DATABASE_URL` (a hosted Postgres: Neon / Supabase / Vercel Postgres), `RESEND_*`, `PO_TEST_EMAIL_SMTP_*`, `WMS_*`, channel creds, etc. Plus **`CRON_SECRET`** (any strong random string) — Vercel automatically sends it as `Authorization: Bearer <CRON_SECRET>` on cron calls, which `lib/cron.ts` checks.
3. **Plan**: cron in `vercel.json` runs sub-daily and several sync routes set `maxDuration = 300` → these need the **Pro plan** (Hobby caps crons at once/day and functions at 60s).
4. Run migrations against the hosted DB once: `DATABASE_URL=<prod> npx prisma migrate deploy`.

### Scheduling
`vercel.json` already declares the crons (blinkit / zepto / instamart / nykaa / wms-stock / poll-emails). The in-process timers self-disable on Vercel (`process.env.VERCEL`), so there's no double-firing — Vercel Cron is the single scheduler.

- **Times are UTC.** Adjust schedules accordingly (e.g. 9 AM IST = `30 3 * * *`).
- `scrape-portals` is still listed but **no-ops on Vercel** (needs Chromium) — remove it or ignore the empty runs.
- **No Tira cron is configured** on purpose (see below).

### Tira on Vercel = the worker
Run the **Docker image** on one small always-on host, pointed at the **same `DATABASE_URL`** as Vercel, with only Tira's scheduler active:

```
TIRA_AUTO_SYNC=true
BLINKIT_AUTO_SYNC=false
ZEPTO_AUTO_SYNC=false
INSTAMART_AUTO_SYNC=false
NYKAA_AUTO_SYNC=false
WMS_STOCK_AUTO_SYNC=false   # if present
```

The worker's instrumentation then starts only the Tira 09:00 IST scrape; it writes POs + caches PDFs to the shared DB/volume, and Vercel reads them. (The "Sync from Tira" button only works when hit on the worker's URL, not the Vercel one.)

---

## Notes
- `next build` runs ESLint and fails on lint errors — keep it clean.
- Secrets live only in env / `.env.local`; never commit them.
