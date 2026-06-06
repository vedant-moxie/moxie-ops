import "server-only";
import { getDocumentProxy, extractText } from "unpdf";
import type { PurchaseOrder } from "@prisma/client";
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
