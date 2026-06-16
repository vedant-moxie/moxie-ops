import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/tira/collector
 *
 * Serves the Tira browser-collector script as text, with CORS open so it can be
 * loaded cross-origin from the portal's console in one line:
 *
 *   fetch('http://localhost:3000/api/tira/collector').then(r=>r.text()).then(eval)
 *
 * This avoids pasting the full ~150-line script (which the console truncates).
 *
 * The portal (https://srm-rrscm.ril.com) is a *public* origin and localhost is a
 * *private* address, so Chrome gates this with a Private Network Access preflight.
 * We must answer that preflight (OPTIONS) with `access-control-allow-private-network`
 * — otherwise the script never loads over localhost and you'd need an HTTPS tunnel
 * (ngrok) just to fetch it. Mirrors the CORS on /api/tira/ingest.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};

export async function GET() {
  let script = "";
  try {
    script = await readFile(join(process.cwd(), "scripts/tira-collector.js"), "utf8");
  } catch (err) {
    return new Response(`console.error("collector script not found: ${String(err)}")`, {
      status: 500,
      headers: { "content-type": "application/javascript", ...CORS },
    });
  }
  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
