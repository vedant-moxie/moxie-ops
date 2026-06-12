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
 */
export async function GET() {
  let script = "";
  try {
    script = await readFile(join(process.cwd(), "scripts/tira-collector.js"), "utf8");
  } catch (err) {
    return new Response(`console.error("collector script not found: ${String(err)}")`, {
      status: 500,
      headers: { "content-type": "application/javascript" },
    });
  }
  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
