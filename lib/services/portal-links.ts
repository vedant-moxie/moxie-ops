import "server-only";

/**
 * Best-effort deep link to the EXACT PO/GRN page on the source channel's portal.
 * Returns null when we don't have a per-PO URL for that channel — we deliberately
 * do NOT fall back to a generic portal landing page (the link must point at the
 * specific PO/GRN or not exist at all).
 *
 * - NYKAA: the scraped PO carries a `documents` print-document URL
 *   (…/PrintDocument/download?PrintDocId=…) — the exact PO/GRN document.
 *   Opening it requires an active Nykaa portal login in the same browser.
 * - Blinkit / Zepto / Instamart expose only internal IDs, not their portals'
 *   per-PO URL patterns → null until those patterns are known. Add a case here
 *   (using poRawData ids) once the exact URL shape is confirmed.
 */
export function grnPortalUrl(poSource: string | null | undefined, poRawData: unknown): string | null {
  const raw = (poRawData ?? {}) as Record<string, unknown>;
  switch (String(poSource ?? "").toUpperCase()) {
    case "NYKAA": {
      const docs = raw.documents;
      return typeof docs === "string" && /^https?:\/\//i.test(docs) ? docs : null;
    }
    default:
      return null;
  }
}
