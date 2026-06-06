import "server-only";
import { getDocumentProxy, extractText } from "unpdf";
import type { PurchaseOrder } from "@prisma/client";
import { BlinkitClient, BlinkitAuthExpired } from "@/lib/integrations/blinkit/client";
import { getTokensIfCached as getBlinkitTokensIfCached } from "@/lib/integrations/blinkit/auth";
import { ZeptoClient, ZeptoAuthExpired } from "@/lib/integrations/zepto/client";
import { getTokensIfCached as getZeptoTokensIfCached } from "@/lib/integrations/zepto/auth";
import { InstamartClient, InstamartAuthExpired } from "@/lib/integrations/instamart/client";
import { getTokensIfCached as getInstamartTokensIfCached } from "@/lib/integrations/instamart/auth";
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
 * Download the PDF and Excel for a PO, dispatching to the correct channel client
 * based on po.source ('BLINKIT' | 'ZEPTO' | 'INSTAMART' | anything else).
 *
 * Gracefully degrades: if one format fails it is returned as null with a warning.
 * Never throws — auth failures and missing tokens are returned as warnings so the
 * allocate email always sends (possibly without attachments).
 *
 * Uses only the cached token; never triggers a new OTP login so this is safe to
 * call in the hot path of an HTTP request handler.
 */
export async function getPoDocuments(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData" | "source">,
): Promise<PoDocumentResult> {
  const source = po.source ?? "EMAIL";

  if (source === "ZEPTO") {
    return getZeptoPoDocuments(po);
  }
  if (source === "INSTAMART") {
    return getInstamartPoDocuments(po);
  }
  // Default: Blinkit / EMAIL / PORTAL / MANUAL — all use the partnersbiz client.
  return getBlinkitPoDocuments(po);
}

// ── Blinkit (original path, unchanged) ─────────────────────────────────────

async function getBlinkitPoDocuments(
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

  const tokens = await getBlinkitTokensIfCached();
  if (!tokens) {
    return {
      pdf: null,
      excel: null,
      warnings: ["No cached Blinkit token — PO docs skipped (run a sync to re-authenticate)"],
    };
  }

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

  const hasAuthErr = [pdfResult, excelResult].some(
    (r) => r.status === "rejected" && r.reason instanceof BlinkitAuthExpired,
  );
  if (hasAuthErr) {
    warnings.push("Blinkit token expired — PO docs skipped (re-login needed)");
  }

  return { pdf, excel, warnings };
}

// ── Zepto ──────────────────────────────────────────────────────────────────

async function getZeptoPoDocuments(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): Promise<PoDocumentResult> {
  const poId = po.channelPoNumber?.trim() || null;
  if (!poId) {
    return {
      pdf: null,
      excel: null,
      warnings: ["Cannot derive Zepto PO id — channelPoNumber is empty"],
    };
  }

  const tokens = await getZeptoTokensIfCached();
  if (!tokens) {
    return {
      pdf: null,
      excel: null,
      warnings: [
        "No cached Zepto token — PO docs skipped (run a Zepto sync to re-authenticate). " +
          `To get PDF/Excel: open brands.zepto.co.in → PO ${poId} → Download PO → Copy as cURL ` +
          "and set ZEPTO_PO_DOC_PATH to the endpoint path.",
      ],
    };
  }

  const client = new ZeptoClient(tokens);
  const warnings: string[] = [];

  const [pdfResult, excelResult] = await Promise.allSettled([
    client.downloadPoPdf(poId),
    client.downloadPoExcel(poId),
  ]);

  const pdf =
    pdfResult.status === "fulfilled"
      ? pdfResult.value
      : (warnings.push(`Zepto PDF download failed for PO ${poId}: ${pdfResult.reason}`), null);

  const excel =
    excelResult.status === "fulfilled"
      ? excelResult.value
      : (warnings.push(`Zepto Excel download failed for PO ${poId}: ${excelResult.reason}`), null);

  const hasAuthErr = [pdfResult, excelResult].some(
    (r) => r.status === "rejected" && r.reason instanceof ZeptoAuthExpired,
  );
  if (hasAuthErr) {
    warnings.push("Zepto token expired — PO docs skipped (re-login needed)");
  }

  return { pdf, excel, warnings };
}

// ── Instamart ──────────────────────────────────────────────────────────────

async function getInstamartPoDocuments(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): Promise<PoDocumentResult> {
  const poId = po.channelPoNumber?.trim() || null;
  if (!poId) {
    return {
      pdf: null,
      excel: null,
      warnings: ["Cannot derive Instamart PO id — channelPoNumber is empty"],
    };
  }

  const tokens = await getInstamartTokensIfCached();
  if (!tokens) {
    return {
      pdf: null,
      excel: null,
      warnings: [
        "No cached Instamart token — PO docs skipped (run an Instamart sync to re-authenticate). " +
          `To get PDF/Excel: open partner.instamart.in → PO ${poId} → Download PO → Copy as cURL ` +
          "and set INSTAMART_PO_DOC_PATH to the endpoint path.",
      ],
    };
  }

  const client = new InstamartClient(tokens);
  const warnings: string[] = [];

  const [pdfResult, excelResult] = await Promise.allSettled([
    client.downloadPoPdf(poId),
    client.downloadPoExcel(poId),
  ]);

  const pdf =
    pdfResult.status === "fulfilled"
      ? pdfResult.value
      : (warnings.push(`Instamart PDF download failed for PO ${poId}: ${pdfResult.reason}`), null);

  const excel =
    excelResult.status === "fulfilled"
      ? excelResult.value
      : (warnings.push(`Instamart Excel download failed for PO ${poId}: ${excelResult.reason}`), null);

  const hasAuthErr = [pdfResult, excelResult].some(
    (r) => r.status === "rejected" && r.reason instanceof InstamartAuthExpired,
  );
  if (hasAuthErr) {
    warnings.push("Instamart token expired — PO docs skipped (re-login needed)");
  }

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
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData" | "source">,
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
  const poId = po.channelPoNumber?.trim() || extractPoId(po) || null;
  if (!poId) {
    return { dispatchFrom: null, gstin: null, warnings: ["No PO id on this order"] };
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
