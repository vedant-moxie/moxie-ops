import "server-only";
import { access } from "node:fs/promises";
import { join } from "node:path";

/**
 * On-disk cache for Tira PO PDFs. They can only be fetched inside the live
 * browser session (F5/SAP binds the session to the browser), so the scrape
 * fetches + caches them here and the allocate page / email read them instantly.
 *
 * Kept in its own module (no Playwright import) so the read side — po-documents,
 * the allocate page — doesn't pull the heavy browser dep into its bundle.
 */
export const TIRA_DOC_DIR = join(process.cwd(), ".po-doc-cache", "tira");

export function tiraPdfPath(poNumber: string): string {
  return join(TIRA_DOC_DIR, `${poNumber.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`);
}

export async function tiraPdfExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
