/**
 * Probe: determine exact response shape from partnersbiz PO doc endpoints.
 * Usage: npx tsx scripts/probe-blinkit-doc-endpoint.ts [po_number]
 */
import { prisma } from "@/lib/db.js";
import { env } from "@/lib/env.js";
import { getTokens } from "@/lib/integrations/blinkit/auth.js";
import { extractPoId } from "@/lib/services/po-documents-helpers.js";

const BASE_URL = env.BLINKIT_BASE_URL;

function headers(tokens: { accessToken: string; entityId?: string; entityType?: string }): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    app_client: "partnersbiz-web",
    "content-type": "application/json",
    origin: BASE_URL,
    referer: `${BASE_URL}/`,
    service: "partnersbiz",
    "user-agent": "Mozilla/5.0 (compatible; moxie-ops/1.0)",
    access_token: tokens.accessToken,
    token: tokens.accessToken,
  };
  if (env.BLINKIT_API_KEY) h["x-api-key"] = env.BLINKIT_API_KEY;
  const entityId = env.BLINKIT_ENTITY_ID || tokens.entityId;
  const entityType = tokens.entityType;
  if (entityId) h["X-Entity-Id"] = entityId;
  if (entityType) h["X-Entity-Type"] = entityType;
  return h;
}

async function probe(label: string, url: string, hdrs: Record<string, string>) {
  console.log(`\n── ${label} ──`);
  console.log(`GET ${url}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, { method: "GET", headers: hdrs, signal: controller.signal });
    clearTimeout(timer);
    const contentType = res.headers.get("content-type") ?? "";
    console.log(`HTTP ${res.status}  Content-Type: ${contentType}`);
    if (
      contentType.includes("application/json") ||
      contentType.includes("text/plain") ||
      contentType.includes("text/html")
    ) {
      const text = await res.text();
      console.log(`Body (first 1200 chars):\n${text.slice(0, 1200)}`);
    } else {
      const buf = await res.arrayBuffer();
      console.log(`Binary: ${buf.byteLength} bytes`);
    }
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  const tokens = await getTokens();
  console.log(`Token loaded. access_token[:8]=${tokens.accessToken.slice(0, 8)}...`);
  console.log(`entityId=${tokens.entityId ?? "(none)"}  entityType=${tokens.entityType ?? "(none)"}`);

  let poNumber = process.argv[2] ?? null;
  if (!poNumber) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { source: "BLINKIT" },
      orderBy: { createdAt: "desc" },
    });
    if (!po) throw new Error("No BLINKIT POs in DB");
    poNumber = extractPoId(po);
    console.log(`\nUsing PO: channelPoNumber=${po.channelPoNumber}  →  poId=${poNumber}`);
  }

  if (!poNumber) throw new Error("Could not derive poId");
  console.log(`\nProbing with id=${poNumber}`);

  const hdrs = headers(tokens);

  // Probe doc endpoints with po_number as-is
  await probe("PDF (po_number as id)", `${BASE_URL}/v1/client-po-details/${poNumber}/pdf/`, hdrs);
  await probe("Excel (po_number as id)", `${BASE_URL}/v1/client-po-details/${poNumber}/excel/`, hdrs);

  // Probe list to see if it returns internal_id + po_number
  await probe("List endpoint (limit=3)", `${BASE_URL}/v1/client-po-details/?offset=0&limit=3`, hdrs);
  await probe(
    "List endpoint (filter by po_number)",
    `${BASE_URL}/v1/client-po-details/?po_number=${poNumber}&limit=3`,
    hdrs,
  );
  await probe(
    "List endpoint (search param)",
    `${BASE_URL}/v1/client-po-details/?search=${poNumber}&limit=3`,
    hdrs,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
