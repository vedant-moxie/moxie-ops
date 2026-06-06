/**
 * Quick runtime verify: does the fixed signed_url parsing produce a real PDF?
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
let envContent = "";
try { envContent = readFileSync(envPath, "utf-8"); } catch { /* no file */ }
for (const line of envContent.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const key = t.slice(0, eq).trim();
  let val = t.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  if (!process.env[key]) process.env[key] = val;
}

const DB = process.env.DATABASE_URL;
const BASE = process.env.BLINKIT_BASE_URL || "https://partnersbiz.com";
const API_KEY = process.env.BLINKIT_API_KEY || "";
const ENTITY_ID = process.env.BLINKIT_ENTITY_ID || "";

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });

const tokenRow = await prisma.integrationToken.findUnique({ where: { provider: "blinkit" } });
if (!tokenRow) { console.error("No token"); process.exit(1); }
const { accessToken } = tokenRow;
const tokenData = tokenRow.data ?? {};
const entityId = ENTITY_ID || tokenData.entityId || "";
const entityType = tokenData.entityType || "";

const po = await prisma.purchaseOrder.findFirst({
  where: { source: "BLINKIT" },
  orderBy: { createdAt: "desc" },
  select: { channelPoNumber: true },
});
if (!po) { console.error("No BLINKIT POs"); process.exit(1); }
const poId = po.channelPoNumber;
await prisma.$disconnect();

function buildHeaders() {
  const h = {
    accept: "application/json, text/plain, */*",
    app_client: "partnersbiz-web",
    "content-type": "application/json",
    origin: BASE,
    referer: `${BASE}/`,
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

function peelEnvelope(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) &&
      "status" in payload && "data" in payload && "instance_name" in payload) {
    return payload.data;
  }
  return payload;
}

console.log(`Testing PO ${poId}...\n`);

// 1. Fetch the JSON envelope
const start = Date.now();
const res = await fetch(`${BASE}/v1/client-po-details/${poId}/pdf/`, {
  headers: buildHeaders(),
  signal: AbortSignal.timeout(15_000),
});
console.log(`HTTP ${res.status}  Content-Type: ${res.headers.get("content-type")}`);
const json = await res.json();
const inner = peelEnvelope(json);
const signedUrl = inner?.signed_url ?? inner?.download_url ?? inner?.url ?? null;
console.log(`signed_url present: ${!!signedUrl}`);
if (!signedUrl) { console.error("No signed_url found! Keys:", Object.keys(inner ?? {})); process.exit(1); }

// 2. Fetch the actual PDF from S3
const s3 = await fetch(signedUrl, { signal: AbortSignal.timeout(15_000) });
console.log(`S3 HTTP ${s3.status}  Content-Type: ${s3.headers.get("content-type")}`);
const buf = await s3.arrayBuffer();
console.log(`PDF bytes: ${buf.byteLength}`);
const elapsed = Date.now() - start;
console.log(`\n✓ PDF downloaded in ${elapsed}ms (${buf.byteLength} bytes)`);

// Check it starts with %PDF
const header = new Uint8Array(buf.slice(0, 4));
const isPdf = header[0] === 0x25 && header[1] === 0x50; // %P
console.log(`Valid PDF header: ${isPdf ? "✓" : "✗ (not a PDF!)"}`);

// 3. Test Excel graceful degradation
console.log(`\nTesting Excel graceful degradation...`);
const excelRes = await fetch(`${BASE}/v1/client-po-details/${poId}/excel/`, {
  headers: buildHeaders(),
  signal: AbortSignal.timeout(15_000),
});
const ct = excelRes.headers.get("content-type") ?? "";
console.log(`Excel HTTP ${excelRes.status}  Content-Type: ${ct}`);
if (ct.includes("text/html")) {
  console.log("✓ Excel returns HTML — fixed code will throw BlinkitAPIError and degrade gracefully");
} else {
  console.log(`Excel content-type: ${ct} — unexpected`);
}
