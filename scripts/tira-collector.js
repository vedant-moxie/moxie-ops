/**
 * Tira browser collector — run this in the DevTools Console while logged in to
 * https://srm-rrscm.ril.com (the "New PO" / purchase-order page).
 *
 * Why: the Tira SRM portal binds its session to the browser (F5 + SAP SSO), so
 * server-side scraping is rejected with "Unauthorized session". This script runs
 * inside the authenticated page, collects the PO list + line items, and ships
 * them to the Moxie Ops app for ingestion.
 *
 * It will:
 *   1. Read the PO list from IndexedDB (srm → store_data → purchaseOrderNew).
 *   2. Find the Bearer JWT in local/session storage.
 *   3. Fetch line items for each PO (live session, cookies auto-included).
 *   4. POST everything to http://localhost:3000/api/tira/ingest.
 *      If that's blocked (mixed-content/CORS), it downloads tira-payload.json
 *      instead — then run:
 *        curl -X POST http://localhost:3000/api/tira/ingest \
 *             -H "Content-Type: application/json" -d @tira-payload.json
 *
 * Paste the whole thing and press Enter. (Type "allow pasting" first if Chrome asks.)
 */
(async () => {
  const INGEST_URL = "http://localhost:3000/api/tira/ingest";
  const ITEMS_URL = "/srm/po-data/api/v1/purchase-order/items";
  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

  // ── 1. Read PO list from IndexedDB ────────────────────────────────────────
  const readIDB = (db, store, key) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(db);
      req.onerror = () => reject(req.error);
      req.onsuccess = (e) => {
        const conn = e.target.result;
        if (!conn.objectStoreNames.contains(store)) return resolve(null);
        const tx = conn.transaction(store, "readonly");
        const get = tx.objectStore(store).get(key);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
    });

  const cache = await readIDB("srm", "store_data", "purchaseOrderNew");
  if (!cache) {
    console.error("[tira] No purchaseOrderNew in IndexedDB. Open the New-PO page first, then re-run.");
    return;
  }
  const pos = cache.allPOList || cache.purchaseOrder || [];
  console.log(`[tira] Found ${pos.length} POs in IndexedDB.`);
  if (!pos.length) return;

  // ── 2. Find the Bearer JWT ────────────────────────────────────────────────
  const findJwt = () => {
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const v = storage.getItem(storage.key(i)) || "";
        const m = v.match(JWT_RE);
        if (m) return m[0];
      }
    }
    return null;
  };
  let jwt = findJwt();
  if (!jwt) {
    // Fallback: sniff the next outgoing request's Authorization header.
    console.warn("[tira] JWT not in storage — sniffing the next request. Click any PO or refresh a panel…");
    jwt = await new Promise((resolve) => {
      const orig = window.fetch;
      const timer = setTimeout(() => { window.fetch = orig; resolve(null); }, 15000);
      window.fetch = function (...args) {
        try {
          const h = args[1] && args[1].headers;
          const auth = h && (h.authorization || h.Authorization ||
            (h.get && h.get("authorization")));
          if (auth && JWT_RE.test(auth)) {
            clearTimeout(timer);
            window.fetch = orig;
            resolve(auth.replace(/^Bearer\s+/i, ""));
          }
        } catch (_) {}
        return orig.apply(this, args);
      };
    });
  }
  if (!jwt) {
    console.error("[tira] Could not find a JWT. Aborting.");
    return;
  }
  console.log("[tira] Using JWT:", jwt.slice(0, 30) + "…");

  // ── 3. Fetch line items per PO (live session) ─────────────────────────────
  const poNumberOf = (p) => p.poNumber || p.purchaseOrderNumber || p.poNo || p.poId;
  const headers = { "content-type": "application/json", authorization: `Bearer ${jwt}` };
  const items = {};
  const conc = 6;
  let done = 0;
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
        if (res.ok) {
          const data = await res.json();
          items[poNum] = data;
        } else {
          console.warn(`[tira] items ${poNum}: HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[tira] items ${poNum} failed:`, err.message);
      }
      done++;
      if (done % 5 === 0 || done === pos.length) console.log(`[tira] items ${done}/${pos.length}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));

  // Show one sample so field names can be confirmed if ingestion misses anything.
  const sampleKey = Object.keys(items)[0];
  if (sampleKey) console.log("[tira] sample items response:", items[sampleKey]);

  const payload = { pos, items };

  // ── 4. Deliver to the app (POST, with file-download fallback) ─────────────
  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    console.log("[tira] ✅ Ingested:", out);
  } catch (err) {
    console.warn("[tira] Direct POST blocked (" + err.message + ") — downloading file instead.");
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tira-payload.json";
    a.click();
    console.log(
      "[tira] Saved tira-payload.json. Now run:\n" +
      'curl -X POST http://localhost:3000/api/tira/ingest -H "Content-Type: application/json" -d @tira-payload.json'
    );
  }
})();
