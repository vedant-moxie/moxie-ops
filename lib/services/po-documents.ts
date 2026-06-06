import "server-only";
import { getDocumentProxy, extractText } from "unpdf";
import type { PurchaseOrder } from "@prisma/client";
import { BlinkitClient, BlinkitAuthExpired } from "@/lib/integrations/blinkit/client";
import { getTokens } from "@/lib/integrations/blinkit/auth";
import {
  GSTIN_DISPATCH_TABLE,
  extractPoId,
  findGstinsInText,
  resolveDispatchFrom,
  resolveDispatchFromGstins,
  type DispatchFromResult,
} from "@/lib/services/po-documents-helpers";

// Re-export so callers only need to import from this module
export {
  GSTIN_DISPATCH_TABLE,
  extractPoId,
  resolveDispatchFrom,
  resolveDispatchFromGstins,
  type DispatchFromResult,
};

// ── PDF text extraction ─────────────────────────────────────────────────────

/** Extract all GSTINs from a PDF buffer. Returns unique matches, deduped. */
export async function extractGstinFromPdf(pdfBuffer: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return findGstinsInText(text);
}

// ── PO document bundle ──────────────────────────────────────────────────────

export interface PoDocumentResult {
  pdf: { content: Buffer; filename: string } | null;
  excel: { content: Buffer; filename: string } | null;
  warnings: string[];
}

/**
 * Download the PDF and Excel for a Blinkit PO.
 * Gracefully degrades: if one format fails it is returned as null with a warning.
 * Only throws if there is an auth error (BlinkitAuthExpired) or no resolvable PO id.
 *
 * The partnersbiz PO id is read from po.channelPoNumber (preferred) or
 * po.rawData.po_number (fallback) — both hold the same numeric id from the bulk report.
 */
export async function getPoDocuments(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): Promise<PoDocumentResult> {
  const poId = extractPoId(po);
  if (!poId) {
    return {
      pdf: null,
      excel: null,
      warnings: ["Cannot derive partnersbiz PO id — not a numeric channelPoNumber"],
    };
  }

  const tokens = await getTokens();
  const client = new BlinkitClient(tokens);
  const warnings: string[] = [];

  const [pdfResult, excelResult] = await Promise.allSettled([
    client.downloadPoPdf(poId),
    client.downloadPoExcel(poId),
  ]);

  const pdf =
    pdfResult.status === "fulfilled"
      ? pdfResult.value
      : (warnings.push(`PDF download failed for PO ${poId}: ${pdfResult.reason}`), null);

  const excel =
    excelResult.status === "fulfilled"
      ? excelResult.value
      : (warnings.push(`Excel download failed for PO ${poId}: ${excelResult.reason}`), null);

  // Surface auth errors so the caller knows to re-authenticate
  const authErr = [pdfResult, excelResult].find(
    (r) => r.status === "rejected" && r.reason instanceof BlinkitAuthExpired,
  );
  if (authErr && authErr.status === "rejected") throw authErr.reason;

  return { pdf, excel, warnings };
}

// ── Convenience: full pipeline for a single PO ─────────────────────────────

export interface ResolvedDispatch {
  dispatchFrom: string | null;
  gstin: string | null;
  warnings: string[];
}

/**
 * Derive poId → download PDF → extract GSTINs → map to dispatch-from.
 * Computed on the fly at send time — no DB column required.
 *
 * Optionally caches the resolved value into po.rawData (in-memory only, no DB write)
 * under `_resolvedDispatchFrom` so repeat calls in the same request are cheap.
 */
export async function resolveDispatchFromForPo(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): Promise<ResolvedDispatch> {
  // In-memory cache hit
  if (
    po.rawData &&
    typeof po.rawData === "object" &&
    !Array.isArray(po.rawData) &&
    "_resolvedDispatchFrom" in (po.rawData as object)
  ) {
    const cached = (po.rawData as Record<string, unknown>)["_resolvedDispatchFrom"];
    if (typeof cached === "string") return { dispatchFrom: cached, gstin: null, warnings: [] };
  }

  const warnings: string[] = [];
  const poId = extractPoId(po);
  if (!poId) {
    return { dispatchFrom: null, gstin: null, warnings: ["No numeric PO id on this order"] };
  }

  let pdfContent: Buffer;
  try {
    const { pdf } = await getPoDocuments(po);
    if (!pdf) {
      return { dispatchFrom: null, gstin: null, warnings: [`PDF unavailable for PO ${poId}`] };
    }
    pdfContent = pdf.content;
  } catch (err) {
    return {
      dispatchFrom: null,
      gstin: null,
      warnings: [`Failed to download PDF for PO ${poId}: ${err instanceof Error ? err.message : err}`],
    };
  }

  let gstins: string[];
  try {
    gstins = await extractGstinFromPdf(pdfContent);
  } catch (err) {
    return {
      dispatchFrom: null,
      gstin: null,
      warnings: [`Failed to parse PDF for PO ${poId}: ${err instanceof Error ? err.message : err}`],
    };
  }

  const result = resolveDispatchFromGstins(gstins);

  // Cache in memory (no DB write)
  if (result.dispatchFrom && po.rawData && typeof po.rawData === "object" && !Array.isArray(po.rawData)) {
    (po.rawData as Record<string, unknown>)["_resolvedDispatchFrom"] = result.dispatchFrom;
  }

  if (result.warning) warnings.push(result.warning);
  return { dispatchFrom: result.dispatchFrom, gstin: result.gstin, warnings };
}
