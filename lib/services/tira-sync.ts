import "server-only";
import { prisma } from "@/lib/db";
import { type RawTiraPo, type RawTiraItem } from "@/lib/integrations/tira/client";
import { collectTiraViaBrowser } from "@/lib/integrations/tira/browser";

const IST_OFFSET_MS = 5.5 * 3_600_000;

function istDaysAgo(n: number): string {
  return new Date(Date.now() + IST_OFFSET_MS - n * 86_400_000).toISOString().slice(0, 10);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}
/** Parse a leading number out of strings like "2.00 each" or "590.2600" or "1180.51 INR". */
function numFrom(v: unknown): number | undefined {
  if (typeof v === "number") return isNaN(v) ? undefined : v;
  if (typeof v !== "string") return undefined;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return isNaN(n) ? undefined : n;
}
function parseDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  // Tira uses DD.MM.YYYY (e.g. "25.07.2026") in line items; convert to ISO first.
  if (typeof v === "string") {
    const dmy = v.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (dmy) {
      const d = new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00Z`);
      return isNaN(d.getTime()) ? undefined : d;
    }
  }
  const d = new Date(typeof v === "string" || typeof v === "number" ? v : String(v));
  return isNaN(d.getTime()) ? undefined : d;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface TiraSyncResult {
  since: string;
  until: string;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  skusCreated: number;
  warnings: string[];
}

/** Find line items array within a raw PO. */
function findLineItems(po: RawTiraPo): Record<string, unknown>[] {
  for (const k of ["lineItems", "items", "poItems", "lines", "products", "skus", "purchaseOrderItems"]) {
    const v = po[k];
    if (Array.isArray(v) && v.some(isRecord)) return v.filter(isRecord);
  }
  return [];
}

/** Extract PO number — confirmed field: poNumber (e.g. "5000478343"). */
function extractPoNumber(po: RawTiraPo): string | undefined {
  return (
    str(po.poNumber) ?? str(po.purchaseOrderNumber) ?? str(po.po_number) ??
    str(po.poNo) ?? str(po.poId) ?? str(po.documentNumber) ?? str(po.id)
  );
}

/** Get or create a SKU keyed by internalCode. */
async function resolveOrCreateSku(
  code: string,
  name: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(code);
  if (hit) return hit;
  const existing = await prisma.sku.findUnique({ where: { internalCode: code } });
  if (existing) { cache.set(code, existing.id); return existing.id; }
  const created = await prisma.sku.create({
    data: { internalCode: code, name: name || code, category: "Tira", uom: "unit" },
  });
  cache.set(code, created.id);
  return created.id;
}

/**
 * Ingest raw Tira POs from the SRM portal into the pipeline.
 * Field names are unknown until the first live cURL is captured — the extractor
 * tries all common SAP SRM conventions and logs unrecognised shapes.
 *
 * `itemsMap`: per-PO line items fetched separately from /purchase-order/items.
 * keyed by PO number. When absent, falls back to inline lineItems in the PO row.
 */
async function ingestTiraPOs(
  rawPos: RawTiraPo[],
  channelId: string,
  itemsMap?: Map<string, RawTiraItem[]>,
): Promise<{ created: number; updated: number; skipped: number; skusCreated: number; warnings: string[] }> {
  let created = 0, updated = 0, skipped = 0, skusCreated = 0;
  const warnings: string[] = [];
  const skuCache = new Map<string, string>();

  for (const raw of rawPos) {
    const poNum = extractPoNumber(raw);
    if (!poNum) {
      warnings.push(`Skipped Tira PO with no identifier. Keys: ${Object.keys(raw).join(",")}`);
      skipped++;
      continue;
    }

    const externalId = `tira:${poNum}`;
    // Prefer separately-fetched items (richer); fall back to inline lineItems if any.
    const lines: Record<string, unknown>[] = itemsMap?.get(poNum) ?? findLineItems(raw);

    // Delivery date isn't on the PO header — take it from the first line's requiredOn.
    const deliveryDate =
      parseDate(raw.deliveryDate ?? raw.requestedDeliveryDate ?? raw.dueDate) ??
      parseDate(lines[0]?.requiredOn);

    // Resolve all SKUs first (so we can create them before the PO row)
    const resolvedLines: {
      skuId: string;
      channelSkuCode: string;
      requestedQty: number;
      unitPrice: number | null;
      uom: string;
      rawData: Record<string, unknown>;
    }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const det = isRecord(l.skuDescItemDetails) ? l.skuDescItemDetails : {};
      // Tira: productCode / rrSKUCode is the channel SKU code.
      const itemCode =
        str(l.productCode) ?? str(det.rrSKUCode) ?? str(l.itemCode) ??
        str(l.materialCode) ?? str(l.skuCode) ?? str(l.sku) ??
        str(l.vendorMaterialNumber) ?? `TIRA-${poNum}-${i}`;
      const itemName =
        str(l.productDescription) ?? str(det.skuDescription) ?? str(l.itemDescription) ??
        str(l.description) ?? str(l.shortText) ?? str(l.productName) ?? itemCode;

      try {
        const skuId = await resolveOrCreateSku(itemCode, itemName, skuCache);
        const wasNew = !skuCache.has(itemCode);
        if (wasNew) skusCreated++;
        resolvedLines.push({
          skuId,
          channelSkuCode: itemCode,
          // orderQuantity is "2.00 each"; itemNetPrice is "590.2600".
          requestedQty: Math.round(
            numFrom(l.orderQuantity) ?? numFrom(det.orderQuantity) ??
            num(l.qty) ?? num(l.quantity) ?? num(l.requestedQty) ?? num(l.orderQty) ?? 0,
          ),
          unitPrice:
            numFrom(l.itemNetPrice) ?? numFrom(det.landedCost) ??
            num(l.unitPrice) ?? num(l.netPrice) ?? num(l.price) ?? null,
          uom: str(det.orderUnit) ?? str(l.uom) ?? str(l.unit) ?? "unit",
          rawData: l,
        });
      } catch (err) {
        warnings.push(`PO ${poNum} line ${i}: SKU resolve failed — ${String(err)}`);
      }
    }

    // If no line items found, create a summary line so the PO is visible in the UI
    if (resolvedLines.length === 0) {
      const summaryCode = `TIRA-${poNum}-SUMMARY`;
      const skuId = await resolveOrCreateSku(summaryCode, `Tira PO ${poNum} (summary)`, skuCache);
      skusCreated++;
      resolvedLines.push({
        skuId,
        channelSkuCode: summaryCode,
        requestedQty: num(raw.totalQty) ?? num(raw.quantity) ?? 1,
        unitPrice: null,
        uom: "unit",
        rawData: {},
      });
      warnings.push(`PO ${poNum}: no line items in response — created summary placeholder`);
    }

    // Tira PO headers carry no value field (only line items do), so derive the
    // PO total from the lines (rate × qty) — matches the per-line VALUE the UI
    // shows. Fall back to a header value if one ever appears.
    const headerValue = num(raw.totalValue ?? raw.netValue ?? raw.grossValue ?? raw.amount);
    const linesValue = resolvedLines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.requestedQty, 0);
    const totalRequestedValue = headerValue ?? (linesValue > 0 ? linesValue : null);

    try {
      const existing = await prisma.purchaseOrder.findUnique({ where: { externalId } });
      if (existing) {
        // Refresh line items only when we have real ones AND the PO is still in
        // review — never clobber items on a PO someone has started allocating.
        const hasRealLines = lines.length > 0;
        const safeToReplace = hasRealLines && existing.status === "PENDING_REVIEW";
        await prisma.purchaseOrder.update({
          where: { externalId },
          data: {
            poDate: parseDate(raw.purchaseOrderDate ?? raw.poDate ?? raw.po_date ?? raw.documentDate),
            requestedDeliveryDate: deliveryDate,
            totalRequestedValue,
            ...(safeToReplace
              ? {
                  lineItems: {
                    deleteMany: {},
                    create: resolvedLines.map((l) => ({
                      skuId: l.skuId,
                      channelSkuCode: l.channelSkuCode,
                      requestedQty: l.requestedQty,
                      unitPrice: l.unitPrice,
                      rawData: l.rawData as never,
                    })),
                  },
                }
              : {}),
          },
        });
        updated++;
      } else {
        await prisma.purchaseOrder.create({
          data: {
            channelId,
            externalId,
            channelPoNumber: poNum,
            source: "TIRA",
            status: "PENDING_REVIEW",
            poDate: parseDate(raw.purchaseOrderDate ?? raw.poDate ?? raw.po_date ?? raw.documentDate),
            requestedDeliveryDate: deliveryDate,
            totalRequestedValue,
            rawData: raw as never,
            lineItems: {
              create: resolvedLines.map((l) => ({
                skuId: l.skuId,
                channelSkuCode: l.channelSkuCode,
                requestedQty: l.requestedQty,
                unitPrice: l.unitPrice,
                rawData: l.rawData as never,
              })),
            },
          },
        });
        created++;
      }
    } catch (err) {
      warnings.push(`PO ${poNum}: ingest failed — ${String(err)}`);
      skipped++;
    }
  }

  return { created, updated, skipped, skusCreated, warnings };
}

/** Resolve the Tira channel row (throws if it doesn't exist). */
async function resolveTiraChannel() {
  const channel = await prisma.channel.findFirst({
    where: { name: { contains: "Tira", mode: "insensitive" } },
  });
  if (!channel) {
    throw new Error(
      "Tira channel not found. Create it via Settings → Channels or run the seed script.",
    );
  }
  return channel;
}

/**
 * Ingest a browser-collected Tira payload.
 *
 * The Tira SRM portal binds its session to the browser (F5/SAP SSO), so
 * server-side fetches are rejected with "Unauthorized session". Instead the
 * browser collector script (run in the portal's console) reads the PO list
 * from IndexedDB, fetches per-PO line items with the live session, and POSTs
 * the combined payload here.
 *
 * payload.pos    — raw PO header rows (from IndexedDB allPOList)
 * payload.items  — optional map of poNumber → raw line-item rows
 */
export async function ingestTiraPayload(payload: {
  pos: RawTiraPo[];
  items?: Record<string, unknown>;
}): Promise<TiraSyncResult> {
  const channel = await resolveTiraChannel();
  const pos = Array.isArray(payload.pos) ? payload.pos : [];

  // Each PO's items response is a wrapper object; the line items are under
  // `purchaseOrderItems`. Accept a raw array too, in case the shape changes.
  const itemsMap = new Map<string, RawTiraItem[]>();
  if (payload.items) {
    for (const [poNum, wrapper] of Object.entries(payload.items)) {
      let arr: unknown = wrapper;
      if (isRecord(wrapper)) {
        arr = wrapper.purchaseOrderItems ?? wrapper.items ?? wrapper.lineItems ?? [];
      }
      if (Array.isArray(arr) && arr.length) {
        itemsMap.set(poNum, arr.filter(isRecord) as RawTiraItem[]);
      }
    }
  }

  console.info(`[tira-ingest] received ${pos.length} POs, ${itemsMap.size} with items`);
  const result = await ingestTiraPOs(pos, channel.id, itemsMap);
  if (result.warnings.length) console.warn("[tira-ingest] warnings:", result.warnings);
  console.info(
    `[tira-ingest] done: +${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.skusCreated} new SKUs`,
  );

  return {
    since: "(browser-collected)",
    until: "(browser-collected)",
    fetched: pos.length,
    ...result,
  };
}

/**
 * Live-sync Tira POs from srm-rrscm.ril.com by driving a real headless browser.
 *
 * The portal's F5/SAP SSO rejects raw server-to-server requests ("Unauthorized
 * session"), so we log in with a real Chromium (sap-user/sap-password), let the
 * SPA cache the PO list, and collect it in-page — no console paste required.
 * The collected `{ pos, items }` payload goes through the same ingest path as
 * the manual browser collector.
 */
export async function syncTira(opts: {
  since?: string;
  until?: string;
  actorLabel?: string;
} = {}): Promise<TiraSyncResult> {
  // The portal's IndexedDB PO list isn't date-filtered server-side; date args
  // are accepted for API symmetry but the browser returns the full cached list.
  const since = opts.since ?? istDaysAgo(30);
  const until = opts.until ?? istDaysAgo(-1);

  const payload = await collectTiraViaBrowser();
  console.info(`[tira-sync] browser collected ${payload.pos.length} POs, ${Object.keys(payload.items).length} with items`);

  const result = await ingestTiraPayload(payload);
  return { ...result, since, until };
}
