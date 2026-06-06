/**
 * Standalone Blinkit doc-endpoint probe.
 * Reads .env.local manually, fetches DB token via Prisma, then hits partnersbiz.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Parse .env.local
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

if (!DB) { console.error("DATABASE_URL not set in .env.local"); process.exit(1); }

// Load Prisma Client
const prismaModule = await import("@prisma/client");
const { PrismaClient } = prismaModule;
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });

// Get cached token
const tokenRow = await prisma.integrationToken.findUnique({ where: { provider: "blinkit" } });
if (!tokenRow) {
  console.error("No cached Blinkit token in DB");
  await prisma.$disconnect();
  process.exit(1);
}
const accessToken = tokenRow.accessToken;
const tokenData = (tokenRow.data ?? {});
const entityId = ENTITY_ID || tokenData.entityId || "";
const entityType = tokenData.entityType || "";

console.log(`Token: ${accessToken.slice(0, 8)}...`);
console.log(`entityId=${entityId}  entityType=${entityType}\n`);

// Get a real PO
let poNumber = process.argv[2] ?? null;
if (!poNumber) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { source: "BLINKIT" },
    orderBy: { createdAt: "desc" },
    select: { channelPoNumber: true, rawData: true },
  });
  if (!po) { console.error("No BLINKIT POs in DB"); await prisma.$disconnect(); process.exit(1); }
  const raw = po.rawData;
  poNumber = po.channelPoNumber || (raw && typeof raw === "object" ? raw.po_number : null);
  console.log(`PO: channelPoNumber=${po.channelPoNumber}  rawData.po_number=${raw?.po_number}`);
}
console.log(`\nProbing po_number=${poNumber}\n`);
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

async function probe(label, url) {
  console.log(`── ${label}`);
  console.log(`   GET ${url}`);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    const ct = res.headers.get("content-type") ?? "";
    console.log(`   HTTP ${res.status}  Content-Type: ${ct}`);
    if (ct.includes("json") || ct.includes("text")) {
      const text = await res.text();
      console.log(`   Body: ${text.slice(0, 1500)}`);
    } else {
      const buf = await res.arrayBuffer();
      console.log(`   Binary: ${buf.byteLength} bytes`);
    }
  } catch (e) {
    console.error(`   ERROR: ${e.message}`);
  }
  console.log();
}

await probe("PDF (po_number as id)",    `${BASE}/v1/client-po-details/${poNumber}/pdf/`);
await probe("Excel (po_number as id)",  `${BASE}/v1/client-po-details/${poNumber}/excel/`);
await probe("xlsx (po_number as id)",   `${BASE}/v1/client-po-details/${poNumber}/xlsx/`);
await probe("List ?limit=3",            `${BASE}/v1/client-po-details/?offset=0&limit=3`);
await probe("List ?po_number=...",      `${BASE}/v1/client-po-details/?po_number=${poNumber}&limit=3`);
await probe("List ?search=...",         `${BASE}/v1/client-po-details/?search=${poNumber}&limit=3`);

console.log("Probe complete.");
