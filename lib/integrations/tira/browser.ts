import "server-only";
import { chromium, type Browser, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { env, requireEnv } from "@/lib/env";
import { TIRA_DOC_DIR, tiraPdfPath, tiraPdfExists } from "@/lib/integrations/tira/doc-cache";

/**
 * Tira (Reliance Retail SRM) collection via a real headless browser.
 *
 * Raw server-to-server requests are rejected by the portal's F5/SAP SSO
 * ("Unauthorized session 403") because the session is bound to a live browser.
 * A real Chromium satisfies that binding. The proven flow (see scripts/tira-probe-*):
 *
 *   1. Log on at the SAP BSP form (sap-user/sap-password) on retsrm.ril.com.
 *      SAP enforces ~one session per user, so login can need a retry.
 *   2. The authenticated BSP dashboard exposes a "New (N)" PO tile whose onclick
 *      is RaiseEventOpenSrc('PoOpenSrcClick','NEW'). Clicking it does the SSO
 *      handoff and lands on the SPA at srm-rrscm.ril.com/purchase-order/new.
 *      (Navigating to that URL directly just bounces back to the BSP login.)
 *   3. The SPA caches the PO list in IndexedDB (srm → store_data →
 *      purchaseOrderNew → allPOList) and holds a Bearer JWT in storage.
 *   4. Read the list, find the JWT, fetch per-PO line items — same as the manual
 *      console collector, but in-process. Output `{ pos, items }` → ingestTiraPayload.
 */

const BASE = "https://srm-rrscm.ril.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class TiraBrowserError extends Error {}

export interface TiraBrowserPayload {
  pos: Record<string, unknown>[];
  items: Record<string, unknown>;
}

/** Drive the SAP BSP logon, retrying for the single-session/timing flakiness. */
async function logIn(page: Page, userId: string, password: string, timeout: number): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout }).catch(() => {});
    await page.waitForSelector('input[name="sap-user"]', { timeout }).catch(() => {});
    // Already authenticated (BSP session URL carries a sap(...) segment).
    if (!(await page.locator('input[name="sap-user"]').count()) && /sap\(/.test(page.url())) return true;

    await page.fill('input[name="sap-user"]', userId).catch(() => {});
    await page.fill('input[name="sap-password"]', password).catch(() => {});
    await page
      .getByRole("button", { name: /log\s*on/i })
      .click()
      .catch(() => page.keyboard.press("Enter"));
    await page.waitForURL(/sap\(/, { timeout }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1_500);

    if (/sap\(/.test(page.url()) && !(await page.locator('input[name="sap-password"]').count())) return true;
    await page.waitForTimeout(2_000);
  }
  return false;
}

/** Collect the Tira PO list + per-PO line items by driving a headless browser. */
export async function collectTiraViaBrowser(opts: { timeoutMs?: number } = {}): Promise<TiraBrowserPayload> {
  requireEnv("tira", ["TIRA_USER_ID", "TIRA_PASSWORD"]);
  const userId = env.TIRA_USER_ID!;
  const password = env.TIRA_PASSWORD!;
  const timeout = opts.timeoutMs ?? 45_000;

  let browser: Browser | null = null;
  let page: Page | null = null;
  let logoffUrl: string | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, locale: "en-GB" });
    page = await ctx.newPage();
    page.setDefaultTimeout(timeout);

    // ── 1. Log on ───────────────────────────────────────────────────────────
    if (!(await logIn(page, userId, password, timeout))) {
      const msg = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new TiraBrowserError(
        `Tira logon failed after retries — check TIRA_USER_ID/TIRA_PASSWORD (a stale SAP session can also block login). Portal said: ${msg.trim()}`,
      );
    }
    // Remember the logoff link so we release the single-session slot afterwards.
    logoffUrl = await page.evaluate(
      () => [...document.querySelectorAll("a")].find((a) => /logoff|logout/i.test((a as HTMLAnchorElement).href))?.getAttribute("href") ?? null,
    );

    // ── 2. Click the "New (N)" PO tile → SSO handoff into the SPA ───────────
    const popupPromise = ctx.waitForEvent("page", { timeout: 25_000 }).catch(() => null);
    const tiles = page.locator('a[onclick*="PoOpenSrcClick"]');
    const n = await tiles.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const oc = await tiles.nth(i).getAttribute("onclick");
      if (oc && /['"]NEW['"]/.test(oc)) {
        await tiles.nth(i).click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      throw new TiraBrowserError("Could not find the 'New' PO tile on the SRM dashboard (RaiseEventOpenSrc/PoOpenSrcClick/NEW).");
    }

    // The tile usually navigates the same tab; occasionally a popup. Handle both.
    const popup = await popupPromise;
    const target = popup ?? page;
    await target.waitForLoadState("networkidle", { timeout }).catch(() => {});
    await target.waitForTimeout(3_000);

    // ── 3. Wait for the SPA to cache the PO list in IndexedDB ───────────────
    const deadline = Date.now() + timeout;
    let poCount = 0;
    while (Date.now() < deadline) {
      poCount = await target.evaluate(readPoCount).catch(() => 0);
      if (poCount > 0) break;
      await target.waitForTimeout(1_500);
    }
    if (poCount === 0) {
      throw new TiraBrowserError(
        `Reached the SPA (${target.url()}) but no POs are cached in IndexedDB (srm → store_data → purchaseOrderNew). The PO-list route may have changed.`,
      );
    }

    // ── 4. Collect PO list + per-PO line items (live session) ───────────────
    const payload = (await target.evaluate(collectInPage)) as TiraBrowserPayload;

    // ── 5. Cache each PO's PDF to disk (best-effort; only the uncached ones) ──
    await cacheTiraPdfs(target, payload.pos).catch((e) =>
      console.warn("[tira] PDF caching failed (non-fatal):", e instanceof Error ? e.message : e),
    );

    return payload;
  } finally {
    // Release the SAP single-session slot so humans / the next run can log in.
    if (page && logoffUrl) {
      const abs = logoffUrl.startsWith("http") ? logoffUrl : new URL(logoffUrl, page.url()).toString();
      await page.goto(abs).catch(() => {});
    }
    if (browser) await browser.close();
  }
}

/**
 * Download each PO's PDF (in the live session) and write it to the disk cache.
 * Only fetches POs not already cached, with small concurrency. Best-effort —
 * a failed PDF never fails the scrape.
 */
async function cacheTiraPdfs(page: Page, pos: Record<string, unknown>[]): Promise<void> {
  await mkdir(TIRA_DOC_DIR, { recursive: true });
  const poNumberOf = (p: Record<string, unknown>) =>
    (p.poNumber || p.purchaseOrderNumber || p.poNo || p.poId) as string | undefined;

  const queue = pos.map(poNumberOf).filter((n): n is string => !!n);
  let cached = 0;
  const worker = async () => {
    while (queue.length) {
      const poNum = queue.shift()!;
      const path = tiraPdfPath(poNum);
      if (await tiraPdfExists(path)) continue;
      try {
        const b64 = await page.evaluate(fetchPdfBase64, poNum);
        if (b64) { await writeFile(path, Buffer.from(b64, "base64")); cached++; }
      } catch { /* skip this PO's PDF */ }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`[tira] cached ${cached} new PO PDF(s) → ${TIRA_DOC_DIR}`);
}

/**
 * Runs in the browser: POST the PO-print endpoint with the live Bearer JWT and
 * return the PDF as base64 (null on any failure). Endpoint confirmed:
 * POST /srm/po-data/api/v1/purchase-orders/print  body {"purchaseOrders":["<po>"]}.
 */
function fetchPdfBase64(poNumber: string): Promise<string | null> {
  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
  let jwt: string | null = null;
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const m = (storage.getItem(storage.key(i) as string) || "").match(JWT_RE);
      if (m) { jwt = m[0]; break; }
    }
    if (jwt) break;
  }
  if (!jwt) return Promise.resolve(null);
  return (async () => {
    const res = await fetch("/srm/po-data/api/v1/purchase-orders/print", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      credentials: "include",
      body: JSON.stringify({ purchaseOrders: [poNumber] }),
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) return null;
    // The endpoint returns the PDF ALREADY base64-encoded as the body (starts with
    // "JV" = base64 of "%PDF"). If it's ever a raw PDF (%PDF = 0x25 0x50), encode it.
    const isRawPdf = buf[0] === 0x25 && buf[1] === 0x50;
    if (!isRawPdf) {
      // body is already base64 text of the PDF — hand it back verbatim
      return new TextDecoder().decode(buf);
    }
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
    }
    return btoa(bin);
  })();
}

/** Runs in the browser: count POs cached in IndexedDB. */
function readPoCount(): Promise<number> {
  return new Promise((resolve) => {
    const req = indexedDB.open("srm");
    req.onerror = () => resolve(0);
    req.onsuccess = (e) => {
      const conn = (e.target as IDBOpenDBRequest).result;
      if (!conn.objectStoreNames.contains("store_data")) return resolve(0);
      const get = conn.transaction("store_data", "readonly").objectStore("store_data").get("purchaseOrderNew");
      get.onsuccess = () => {
        const c = get.result as { allPOList?: unknown[]; purchaseOrder?: unknown[] } | null;
        const list = c?.allPOList || c?.purchaseOrder || [];
        resolve(Array.isArray(list) ? list.length : 0);
      };
      get.onerror = () => resolve(0);
    };
  });
}

/**
 * Runs in the browser (live, authenticated SPA session): read the PO list from
 * IndexedDB, find the Bearer JWT, fetch per-PO line items, and return
 * `{ pos, items }`. Mirrors scripts/tira-collector.js but returns the payload.
 */
function collectInPage(): Promise<{ pos: Record<string, unknown>[]; items: Record<string, unknown> }> {
  const ITEMS_URL = "/srm/po-data/api/v1/purchase-order/items";
  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

  const readIDB = (db: string, store: string, key: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(db);
      req.onerror = () => reject(req.error);
      req.onsuccess = (e) => {
        const conn = (e.target as IDBOpenDBRequest).result;
        if (!conn.objectStoreNames.contains(store)) return resolve(null);
        const get = conn.transaction(store, "readonly").objectStore(store).get(key);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
    });

  return (async () => {
    const cache = await readIDB("srm", "store_data", "purchaseOrderNew");
    const pos: Record<string, unknown>[] = (cache && (cache.allPOList || cache.purchaseOrder)) || [];

    let jwt: string | null = null;
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const v = storage.getItem(storage.key(i) as string) || "";
        const m = v.match(JWT_RE);
        if (m) { jwt = m[0]; break; }
      }
      if (jwt) break;
    }

    const items: Record<string, unknown> = {};
    if (jwt && pos.length) {
      const poNumberOf = (p: any) => p.poNumber || p.purchaseOrderNumber || p.poNo || p.poId;
      const headers = { "content-type": "application/json", authorization: `Bearer ${jwt}` };
      const queue = [...pos];
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          const poNum = poNumberOf(p);
          if (!poNum) continue;
          try {
            const res = await fetch(ITEMS_URL, {
              method: "POST",
              headers,
              credentials: "include",
              body: JSON.stringify({ purchaseOrders: [poNum], action: "SCREEN" }),
            });
            if (res.ok) items[poNum] = await res.json();
          } catch { /* non-fatal: ingest falls back to inline lines */ }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    }

    return { pos, items };
  })();
}
