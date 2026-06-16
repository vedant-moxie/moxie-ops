import "server-only";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { getDocumentProxy, extractText } from "unpdf";
import type { PurchaseOrder } from "@prisma/client";
import { prisma } from "@/lib/db";
import { tiraPdfPath } from "@/lib/integrations/tira/doc-cache";
import { BlinkitClient, BlinkitAuthExpired } from "@/lib/integrations/blinkit/client";
import {
  getTokensIfCached as getBlinkitTokensIfCached,
  getTokens as getBlinkitTokens,
  type BlinkitTokens,
} from "@/lib/integrations/blinkit/auth";
import { ZeptoClient, ZeptoAuthExpired } from "@/lib/integrations/zepto/client";
import {
  getTokensIfCached as getZeptoTokensIfCached,
  getTokens as getZeptoTokens,
  type ZeptoTokens,
} from "@/lib/integrations/zepto/auth";
import { InstamartClient, InstamartAuthExpired } from "@/lib/integrations/instamart/client";
import {
  getTokensIfCached as getInstamartTokensIfCached,
  getTokens as getInstamartTokens,
  type InstamartTokens,
} from "@/lib/integrations/instamart/auth";
import { NykaaClient, NykaaAuthExpired } from "@/lib/integrations/nykaa/client";
import {
  getTokensIfCached as getNykaaTokensIfCached,
  getTokens as getNykaaTokens,
  type NykaaTokens,
} from "@/lib/integrations/nykaa/auth";
import { refreshTokenOnce, looksLikeAuthError } from "@/lib/services/token-refresh";
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

function looksLikePdf(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}
function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // PK
}

/** Pull the first PDF entry out of a ZIP buffer (Nykaa's doc is a zip of PDF+CSV). */
function extractPdfFromZip(zip: Buffer): Buffer | null {
  try {
    const files = unzipSync(new Uint8Array(zip));
    for (const [name, bytes] of Object.entries(files)) {
      if (name.toLowerCase().endsWith(".pdf")) return Buffer.from(bytes);
    }
  } catch { /* not a readable zip */ }
  return null;
}

/**
 * GSTINs from a PO document that may be a PDF *or* a ZIP-of-PDF (Nykaa). Unzips
 * when needed and reads the GSTINs off the inner PDF — used to resolve the
 * supplier (Moxie) GSTIN → dispatch-from warehouse.
 */
export async function extractGstinsFromDoc(content: Buffer, filename: string): Promise<string[]> {
  const lower = (filename || "").toLowerCase();
  let pdfBytes: Buffer | null = null;
  if (lower.endsWith(".zip") || looksLikeZip(content)) pdfBytes = extractPdfFromZip(content);
  else if (lower.endsWith(".pdf") || looksLikePdf(content)) pdfBytes = content;
  if (!pdfBytes) return [];
  return extractGstinFromPdf(pdfBytes);
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
 * Self-healing: the happy path uses the cached token (fast, no OTP). If a download
 * fails with an expired/401 auth error, it mints a fresh token ONCE via the
 * channel's OTP login (bounded ≤60s, deduped per channel), persists it, and retries
 * the download a single time. If the retry still fails it degrades to a warning.
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
  if (source === "NYKAA") {
    return getNykaaPoDocuments(po);
  }
  if (source === "TIRA") {
    return getTiraPoDocuments(po);
  }
  // Default: Blinkit / EMAIL / PORTAL / MANUAL — all use the partnersbiz client.
  return getBlinkitPoDocuments(po);
}

// ── Self-healing download orchestration (shared by all 3 channels) ──────────

/** One PDF+Excel download attempt for a given set of tokens. */
interface DownloadAttempt {
  pdf: { content: Buffer; filename: string } | null;
  excel: { content: Buffer; filename: string } | null;
  warnings: string[];
  /** True when a PDF/Excel failure was an expired/401 auth error. */
  authErr: boolean;
}

/**
 * Run PDF + Excel downloads concurrently with the supplied token-bound client,
 * collecting per-format warnings and flagging whether any failure was auth-related.
 * Channel clients return `null` (Instamart) or throw on failure — both are handled.
 */
async function runDownloads(
  poId: string,
  label: string,
  downloadPdf: () => Promise<{ content: Buffer; filename: string } | null>,
  downloadExcel: () => Promise<{ content: Buffer; filename: string } | null>,
  ...authErrorTypes: Array<new (...a: never[]) => Error>
): Promise<DownloadAttempt> {
  const warnings: string[] = [];
  const [pdfResult, excelResult] = await Promise.allSettled([downloadPdf(), downloadExcel()]);

  const pdf =
    pdfResult.status === "fulfilled"
      ? pdfResult.value
      : (warnings.push(`${label} PDF download failed for PO ${poId}: ${pdfResult.reason}`), null);

  const excel =
    excelResult.status === "fulfilled"
      ? excelResult.value
      : (warnings.push(`${label} Excel download failed for PO ${poId}: ${excelResult.reason}`), null);

  const authErr = [pdfResult, excelResult].some(
    (r) => r.status === "rejected" && looksLikeAuthError(r.reason, ...authErrorTypes),
  );

  return { pdf, excel, warnings, authErr };
}

/**
 * Generic self-healing wrapper: load the cached token, attempt the downloads, and
 * on an auth-expired/401 error mint a fresh token once and retry a single time.
 *
 * Exported so the self-heal control flow (refresh-once-and-retry, dedup, graceful
 * degradation) can be exercised in isolation by tests/probes with injected token
 * loaders and attempt functions.
 */
export async function getDocsWithRefresh<T>(opts: {
  channel: string;
  noTokenWarnings: string[];
  getCached: () => Promise<T | null>;
  refresh: () => Promise<T>;
  attempt: (tokens: T) => Promise<DownloadAttempt>;
}): Promise<PoDocumentResult> {
  const { channel } = opts;

  let tokens = await opts.getCached();

  // No cached token at all → self-heal by minting one (still bounded + deduped).
  if (!tokens) {
    try {
      tokens = await refreshTokenOnce(channel, opts.refresh);
      console.log(`[po-docs] ${channel}: no cached token — minted a fresh one`);
    } catch (err) {
      return { pdf: null, excel: null, warnings: opts.noTokenWarnings };
    }
  }

  const first = await opts.attempt(tokens);
  if (!first.authErr) {
    return { pdf: first.pdf, excel: first.excel, warnings: first.warnings };
  }

  // Auth expired on the cached token → refresh once and retry.
  console.log(`[po-docs] ${channel}: token expired — refreshing via OTP login and retrying once`);
  let fresh: T;
  try {
    fresh = await refreshTokenOnce(channel, opts.refresh);
  } catch (err) {
    return {
      pdf: first.pdf,
      excel: first.excel,
      warnings: [
        ...first.warnings,
        `${channel} token refresh failed (${err instanceof Error ? err.message : err}) — PO docs skipped`,
      ],
    };
  }

  const second = await opts.attempt(fresh);
  if (second.authErr) {
    return {
      pdf: second.pdf,
      excel: second.excel,
      warnings: [...second.warnings, `${channel} auth still failing after token refresh — PO docs skipped`],
    };
  }
  console.log(`[po-docs] ${channel}: recovered after token refresh`);
  return { pdf: second.pdf, excel: second.excel, warnings: second.warnings };
}

// ── Blinkit ─────────────────────────────────────────────────────────────────

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

  return getDocsWithRefresh<BlinkitTokens>({
    channel: "blinkit",
    noTokenWarnings: ["No cached Blinkit token — PO docs skipped (re-authenticate unavailable)"],
    getCached: getBlinkitTokensIfCached,
    refresh: () => getBlinkitTokens(true),
    attempt: (tokens) => {
      const client = new BlinkitClient(tokens);
      return runDownloads(
        poId,
        "Blinkit",
        () => client.downloadPoPdf(poId),
        () => client.downloadPoExcel(poId),
        BlinkitAuthExpired,
      );
    },
  });
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

  return getDocsWithRefresh<ZeptoTokens>({
    channel: "zepto",
    noTokenWarnings: [
      "No cached Zepto token — PO docs skipped (re-authenticate unavailable). " +
        `To get PDF/Excel: open brands.zepto.co.in → PO ${poId} → Download PO → Copy as cURL ` +
        "and set ZEPTO_PO_DOC_PATH to the endpoint path.",
    ],
    getCached: getZeptoTokensIfCached,
    refresh: () => getZeptoTokens(true),
    attempt: (tokens) => {
      const client = new ZeptoClient(tokens);
      return runDownloads(
        poId,
        "Zepto",
        () => client.downloadPoPdf(poId),
        () => client.downloadPoExcel(poId),
        ZeptoAuthExpired,
      );
    },
  });
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

  return getDocsWithRefresh<InstamartTokens>({
    channel: "instamart",
    noTokenWarnings: [
      "No cached Instamart token — PO docs skipped (re-authenticate unavailable). " +
        `To get PDF/Excel: open partner.instamart.in → PO ${poId} → Download PO → Copy as cURL ` +
        "and set INSTAMART_PO_DOC_PATH to the endpoint path.",
    ],
    getCached: getInstamartTokensIfCached,
    refresh: () => getInstamartTokens(true),
    attempt: (tokens) => {
      const client = new InstamartClient(tokens);
      return runDownloads(
        poId,
        "Instamart",
        () => client.downloadPoPdf(poId),
        () => client.downloadPoExcel(poId),
        InstamartAuthExpired,
      );
    },
  });
}

// ── Nykaa ────────────────────────────────────────────────────────────────────

/** Build a simple picking-list CSV from the Nykaa PO's raw items. */
function buildNykaaCsv(po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">): { content: Buffer; filename: string } | null {
  const raw = po.rawData as Record<string, unknown> | null;
  const items = raw && Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["SKU Code", "Product", "Ordered Qty", "Unit Price", "EAN"];
  const rows = items.map((it) =>
    [
      it.skuCode ?? it.sku_code ?? it.code ?? "",
      it.skuName ?? it.name ?? it.productName ?? "",
      it.poQty ?? it.qty ?? it.quantity ?? it.orderQty ?? "",
      it.unitPrice ?? it.price ?? "",
      it.eanNo ?? it.ean ?? "",
    ].map(esc).join(","),
  );
  const csv = [header.map(esc).join(","), ...rows].join("\r\n");
  return { content: Buffer.from(csv, "utf8"), filename: `${po.channelPoNumber ?? "nykaa-po"}.csv` };
}

async function getNykaaPoDocuments(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): Promise<PoDocumentResult> {
  const poId = po.channelPoNumber?.trim() || null;
  if (!poId) {
    return { pdf: null, excel: null, warnings: ["Cannot derive Nykaa PO id — channelPoNumber is empty"] };
  }
  // CSV is generated from our own data, so it's always available even if the
  // ZIP download fails (auth/expired).
  const excel = buildNykaaCsv(po);

  const result = await getDocsWithRefresh<NykaaTokens>({
    channel: "nykaa",
    noTokenWarnings: [
      `No cached Nykaa token — PO ZIP skipped for ${poId} (re-authenticate via OTP first).`,
    ],
    getCached: getNykaaTokensIfCached,
    refresh: () => getNykaaTokens(true),
    attempt: (tokens) => {
      const client = new NykaaClient(tokens);
      // The Nykaa "PO document" is a ZIP (PO PDF + details) from the seller portal.
      return runDownloads(
        poId,
        "Nykaa",
        () => client.downloadPoZip(poId),
        async () => null, // Excel is generated locally (below), not downloaded.
        NykaaAuthExpired,
      );
    },
  });

  // Prefer the locally-generated CSV over the (null) downloaded excel.
  return { pdf: result.pdf, excel: result.excel ?? excel, warnings: result.warnings };
}

// ── Tira (Reliance SRM) ──────────────────────────────────────────────────────

/** Build a picking-list CSV from the Tira PO's stored line items. */
async function buildTiraCsv(poId: string): Promise<{ content: Buffer; filename: string } | null> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { channelPoNumber: poId, source: "TIRA" },
    select: { lineItems: { select: { channelSkuCode: true, requestedQty: true, unitPrice: true, sku: { select: { internalCode: true, name: true } } } } },
  });
  if (!po || po.lineItems.length === 0) return null;
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["SKU Code", "Tira Code", "Product", "Ordered Qty", "Unit Price"];
  const rows = po.lineItems.map((l) =>
    [l.sku.internalCode, l.channelSkuCode ?? "", l.sku.name, l.requestedQty, l.unitPrice ?? ""].map(esc).join(","),
  );
  const csv = [header.map(esc).join(","), ...rows].join("\r\n");
  return { content: Buffer.from(csv, "utf8"), filename: `${poId}.csv` };
}

/**
 * Tira PO documents. The PDF can only be fetched inside the live browser session
 * (F5/SAP binding), so the scrape pre-downloads it to a disk cache — here we just
 * read it. The Excel is a picking-list CSV generated from our stored line items.
 * If the PDF isn't cached yet, a "Sync from Tira" will fetch it.
 */
async function getTiraPoDocuments(
  po: Pick<PurchaseOrder, "channelPoNumber" | "rawData">,
): Promise<PoDocumentResult> {
  const poId = po.channelPoNumber?.trim() || null;
  if (!poId) return { pdf: null, excel: null, warnings: ["Cannot derive Tira PO id — channelPoNumber is empty"] };

  const warnings: string[] = [];
  let pdf: { content: Buffer; filename: string } | null = null;
  try {
    const content = await readFile(tiraPdfPath(poId));
    pdf = { content, filename: `${poId}.pdf` };
  } catch {
    warnings.push(`Tira PDF not cached for PO ${poId} — run "Sync from Tira" to fetch it (it's downloaded inside the browser session).`);
  }

  const excel = await buildTiraCsv(poId).catch(() => null);
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
  let pdfFilename = "";
  try {
    const { pdf } = await getPoDocuments(po);
    if (!pdf) {
      return { dispatchFrom: null, gstin: null, warnings: [`PDF unavailable for PO ${poId}`] };
    }
    pdfContent = pdf.content;
    pdfFilename = pdf.filename;
  } catch (err) {
    return {
      dispatchFrom: null,
      gstin: null,
      warnings: [`Failed to download PDF for PO ${poId}: ${err instanceof Error ? err.message : err}`],
    };
  }

  let gstins: string[];
  try {
    // Handles a PDF or a ZIP-of-PDF (Nykaa) — unzips and reads the inner PDF.
    gstins = await extractGstinsFromDoc(pdfContent, pdfFilename);
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
