/**
 * End-to-end probe for PO document download + GSTIN → dispatch-from resolution.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/probe-po-documents.ts [poId]
 *
 * If no poId is given, it picks the most recent BLINKIT PO from the DB.
 * Prints the confirmed Excel URL path, extracted GSTINs, and resolved dispatch-from.
 */
import { prisma } from "@/lib/db.js";
import { getTokens } from "@/lib/integrations/blinkit/auth.js";
import { BlinkitClient, BlinkitAPIError } from "@/lib/integrations/blinkit/client.js";
import { extractPoId } from "@/lib/services/po-documents-helpers.js";
import { extractGstinFromPdf, resolveDispatchFromGstins } from "@/lib/services/po-documents.js";

async function main() {
  let poId = process.argv[2] ?? null;

  if (!poId) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { source: "BLINKIT" },
      orderBy: { createdAt: "desc" },
    });
    if (!po) throw new Error("No BLINKIT POs in the database");
    poId = extractPoId(po);
    console.log(`Using most recent BLINKIT PO: channelPoNumber=${po.channelPoNumber} → poId=${poId}`);
  }

  if (!poId) throw new Error("Could not derive poId from PO");

  const tokens = await getTokens();
  const client = new BlinkitClient(tokens);

  // ── PDF ──────────────────────────────────────────────────────────────────
  console.log(`\nDownloading PDF for poId=${poId} ...`);
  try {
    const { content: pdfBuf, filename: pdfName } = await client.downloadPoPdf(poId);
    console.log(`  ✓ PDF: filename=${pdfName}  bytes=${pdfBuf.length}`);

    const gstins = await extractGstinFromPdf(pdfBuf);
    console.log(`  GSTINs found in PDF: [${gstins.join(", ")}]`);
    const dispatch = resolveDispatchFromGstins(gstins);
    if (dispatch.dispatchFrom) {
      console.log(`  ✓ Dispatch-From resolved: ${dispatch.dispatchFrom}  (GSTIN: ${dispatch.gstin})`);
    } else {
      console.warn(`  ⚠ ${dispatch.warning}`);
    }
  } catch (e) {
    console.error(`  ✗ PDF failed: ${e instanceof Error ? e.message : e}`);
  }

  // ── Excel — probe both /excel/ and /xlsx/ ─────────────────────────────────
  console.log(`\nProbing Excel URL for poId=${poId} ...`);
  try {
    const { content, filename } = await client.downloadPoExcel(poId);
    // filename tells us which path worked (the client tries /excel/ then /xlsx/)
    console.log(`  ✓ Excel: filename=${filename}  bytes=${content.length}`);
    const guessedPath = filename?.endsWith(".xlsx")
      ? `/v1/client-po-details/${poId}/excel/  (or /xlsx/ — check Content-Disposition header)`
      : `/v1/client-po-details/${poId}/excel/`;
    console.log(`  Confirmed path: ${guessedPath}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ Excel failed: ${msg}`);
    if (e instanceof BlinkitAPIError && msg.includes("404")) {
      console.error("  Neither /excel/ nor /xlsx/ returned 200 — endpoint may not exist for this PO");
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
