/**
 * Probe script: determine the exact response from partnersbiz PO doc endpoints.
 * Run from the ops_project root with access to DATABASE_URL in env.
 *
 * Usage: DATABASE_URL=... BLINKIT_BASE_URL=... npx tsx scripts/probe-blinkit-doc-endpoint.mjs [po_number]
 */

// Load env from .env.local first
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Parse .env.local manually since we're in a script
function loadEnvLocal(path) {
  try {
    const text = readFileSync(path, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // no .env.local
  }
}

loadEnvLocal(resolve(process.cwd(), ".env.local"));

const BASE_URL = process.env.BLINKIT_BASE_URL || "https://partnersbiz.com";
const API_KEY = process.env.BLINKIT_API_KEY || "";
const ENTITY_ID = process.env.BLINKIT_ENTITY_ID || "";
const DB_URL = process.env.DATABASE_URL || "";

if (!DB_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

// Import pg dynamically
const { default: pg } = await import("pg").catch(() => {
  return { default: null };
});
if (!pg) {
  console.error("pg not available; trying @prisma/client approach");
  process.exit(1);
}

const { Client } = pg;
const db = new Client({ connectionString: DB_URL });
await db.connect();

// 1. Get cached token from DB
const tokenRow = await db.query(
  `SELECT "accessToken", "refreshToken", data FROM "IntegrationToken" WHERE provider = 'blinkit' LIMIT 1`
);
if (!tokenRow.rows.length) {
  console.error("No cached Blinkit token in DB — run the OTP login first");
  await db.end();
  process.exit(1);
}
const { accessToken } = tokenRow.rows[0];
const tokenData = tokenRow.rows[0].data || {};
const entityId = ENTITY_ID || tokenData.entityId || "";
const entityType = tokenData.entityType || "";

console.log(`Token loaded from DB. access_token[:8]=${accessToken.slice(0, 8)}...`);
console.log(`entity_id=${entityId}  entity_type=${entityType}`);

// 2. Get a real PO from DB
let poNumber = process.argv[2] || null;
if (!poNumber) {
  const poRow = await db.query(
    `SELECT "channelPoNumber", "rawData" FROM "PurchaseOrder" WHERE source = 'BLINKIT' ORDER BY "createdAt" DESC LIMIT 1`
  );
  if (!poRow.rows.length) {
    console.error("No BLINKIT POs in DB");
    await db.end();
    process.exit(1);
  }
  const row = poRow.rows[0];
  poNumber = row.channelPoNumber || row.rawData?.po_number;
  console.log(`Using PO: channelPoNumber=${row.channelPoNumber}  rawData.po_number=${row.rawData?.po_number}`);
}

console.log(`\nProbing with po_number=${poNumber}\n`);

function headers() {
  const h = {
    accept: "application/json, text/plain, */*",
    app_client: "partnersbiz-web",
    "content-type": "application/json",
    origin: BASE_URL,
    referer: `${BASE_URL}/`,
    service: "partnersbiz",
    "user-agent": "Mozilla/5.0 (compatible; moxie-ops/1.0)",
    access_token: accessToken,
    token: accessToken,
  };
  if (API_KEY) h["x-api-key"] = API_KEY;
  if (entityId) h["X-Entity-Id"] = entityId;
  if (entityType) h["X-Entity-Type"] = entityType;
  return h;
}

async function probe(label, url) {
  console.log(`\n── ${label} ──`);
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url, { method: "GET", headers: headers(), signal: AbortSignal.timeout(20000) });
    const contentType = res.headers.get("content-type") || "";
    console.log(`HTTP ${res.status}  Content-Type: ${contentType}`);
    if (contentType.includes("application/json") || contentType.includes("text/plain") || contentType.includes("text/html")) {
      const text = await res.text();
      console.log(`Response body (first 1000 chars):\n${text.slice(0, 1000)}`);
    } else {
      const buf = await res.arrayBuffer();
      console.log(`Binary response: ${buf.byteLength} bytes  (Content-Type: ${contentType})`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  }
}

// 3. Probe the doc endpoints with po_number
await probe("PDF with po_number", `${BASE_URL}/v1/client-po-details/${poNumber}/pdf/`);
await probe("Excel with po_number", `${BASE_URL}/v1/client-po-details/${poNumber}/excel/`);
await probe("xlsx with po_number", `${BASE_URL}/v1/client-po-details/${poNumber}/xlsx/`);

// 4. Probe the list endpoint (to check for internal id)
await probe("List endpoint (offset=0&limit=5)", `${BASE_URL}/v1/client-po-details/?offset=0&limit=5`);
await probe("List endpoint with po_number filter", `${BASE_URL}/v1/client-po-details/?po_number=${poNumber}&limit=5`);

await db.end();
console.log("\nProbe complete.");
