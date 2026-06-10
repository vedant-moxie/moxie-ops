import "server-only";
import * as XLSX from "xlsx";
import { env } from "@/lib/env";

// Token cache — WMS tokens last ~24h; refresh after 7.5h
let cachedToken: { value: string; expiresAt: number } | null = null;

async function authenticate(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const res = await fetch(`${env.WMS_BASE_URL}/api/security/user/external-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email_address: env.WMS_EMAIL, password: env.WMS_PASSWORD }),
  });
  if (!res.ok) throw new Error(`[wms] auth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const token = data.token as string | undefined;
  if (!token) throw new Error("[wms] auth response missing token");
  cachedToken = { value: token, expiresAt: Date.now() + 7.5 * 3_600_000 };
  return token;
}

export function wmsConfigured(): boolean {
  return !!(env.WMS_EMAIL && env.WMS_PASSWORD);
}

export interface WmsSalesOrderPayload {
  orderNo: string;
  orderDate: string; // ISO
  warehouseCode: string;
  warehouseName: string;
  partyCode: string;
  partyName: string;
  lines: Array<{
    skuCode: string;
    skuDescription: string;
    quantity: number;
    mrp?: number;
    amount?: number;
  }>;
  shipping?: {
    shipToCode?: string;
    contactPerson?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    country?: string;
    postCode?: string;
  };
}

export async function pushSalesOrder(payload: WmsSalesOrderPayload): Promise<number> {
  const token = await authenticate();
  const body = [
    {
      order_no: payload.orderNo,
      order_date: payload.orderDate,
      warehouse_code: payload.warehouseCode,
      warehouse_name: payload.warehouseName,
      party_code: payload.partyCode,
      party_name: payload.partyName,
      freight_term: "TOPAY",
      delivery_term: "DOOR",
      order_value: payload.lines.reduce((s, l) => s + (l.amount ?? 0), 0),
      api_salesorder_loi: payload.lines.map((l) => ({
        sku_code: l.skuCode,
        sku_description: l.skuDescription,
        category: "Saleable",
        quantity: l.quantity,
        mrp: l.mrp ?? 0,
        amount: l.amount ?? 0,
        sku_ean_no: "",
        batch_no: "",
        expiry_date: null,
      })),
      salesorder_shipping_address: {
        ship_to_code: payload.shipping?.shipToCode ?? "",
        shipping_contact_person: payload.shipping?.contactPerson ?? "",
        shipping_addressline1: payload.shipping?.addressLine1 ?? "",
        shipping_country: payload.shipping?.country ?? "India",
        shipping_state: payload.shipping?.state ?? "",
        shipping_city: payload.shipping?.city ?? "",
        shipping_post_code: payload.shipping?.postCode ?? "",
        shipping_company_name: payload.partyName,
      },
    },
  ];

  const res = await fetch(`${env.WMS_BASE_URL}/api/outbound/sales-order/v2/external-insert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.Errors || json.errors) {
    throw new Error(`[wms] SO insert failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return (json.Data?.[0]?.salesorder_id ?? json.data?.[0]?.salesorder_id ?? 0) as number;
}

// ───────────────────────────────────────────────────────────────────────────
// Portal API (wms-api.myrgl.com — the API behind the wms.myrgl.com SPA).
// The documented external API has no stock endpoint, so warehouse stock comes
// from the portal's report engine: auth → run "Consolidated Stock Report" →
// download the generated xlsx from S3 → parse the "Stock Report" sheet.
// ───────────────────────────────────────────────────────────────────────────

interface PortalSession {
  token: string;
  userId: number;
  accountId: number;
  companyId: number;
  warehouseId: number;
  expiresAt: number;
}

let portalSession: PortalSession | null = null;

async function portalAuth(): Promise<PortalSession> {
  if (portalSession && Date.now() < portalSession.expiresAt) return portalSession;
  const res = await fetch(`${env.WMS_PORTAL_BASE_URL}/api/security/user/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({
      email_address: env.WMS_EMAIL,
      password: env.WMS_PASSWORD,
      client_date_format: "dd-MM-yyyy",
    }),
  });
  if (!res.ok) throw new Error(`[wms] portal auth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.token) throw new Error(`[wms] portal auth rejected: ${data.message ?? "no token"}`);
  portalSession = {
    token: data.token as string,
    userId: data.user_id as number,
    accountId: data.default_account_id as number,
    companyId: data.default_company_id as number,
    warehouseId: data.default_warehouse_id as number,
    expiresAt: Date.now() + 7.5 * 3_600_000,
  };
  return portalSession;
}

async function portalGetWithToken(token: string, path: string): Promise<any> {
  const res = await fetch(`${env.WMS_PORTAL_BASE_URL}/api/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest" },
  });
  if (res.status === 401) return null; // signal to caller to re-auth
  if (!res.ok) throw new Error(`[wms] GET ${path} → ${res.status}`);
  return res.json();
}

async function portalGet(session: PortalSession, path: string): Promise<any> {
  const result = await portalGetWithToken(session.token, path);
  if (result !== null) return result;
  // Token expired — re-authenticate and retry once
  portalSession = null;
  const fresh = await portalAuth();
  Object.assign(session, fresh); // update in-place so callers see fresh IDs/token
  const retry = await portalGetWithToken(fresh.token, path);
  if (retry === null) throw new Error("[wms] portal 401 even after re-auth");
  return retry;
}

export interface WmsStockRow {
  /** WAREHOUSE column, e.g. "BHIWANDI - 2" */
  warehouseName: string;
  /** Master SKU code, e.g. "CAHHO100" */
  skuCode: string;
  skuDescription: string;
  stockType: string; // Saleable | Damaged | Expired | ...
  quantity: number;
  /** salesorder locked + picking locked */
  lockedQty: number;
  freeQty: number;
}

// Reports module id observed in the portal SPA
const REPORTS_MODULE_ID = 5;

type ParamDef = { parameter_name: string; control_type_id: number; parameter: string; default_value: string };

const wmsDate = (d: Date): string =>
  `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

/**
 * Generic WMS portal report runner.
 * Discovers the report by name (case-insensitive), resolves its stored-proc
 * from the details endpoint, builds params (session IDs + optional date range),
 * triggers report-output, and downloads + returns the xlsx buffer.
 */
async function runPortalReport(
  reportName: string,
  fallbackId: number,
  fallbackSp: string,
  options?: { from?: Date; until?: Date },
): Promise<Buffer> {
  // Get fresh session; re-authenticate if a previous portalGet call expired it.
  let session = await portalAuth();

  let reportId = fallbackId;
  let spName = fallbackSp;
  let paramDefs: ParamDef[] = [];

  try {
    const list = await portalGet(
      session,
      `analytics/report/list?user_id=${session.userId}&company_id=${session.companyId}&account_id=${session.accountId}&warehouse_id=${session.warehouseId}&module_id=${REPORTS_MODULE_ID}`,
    );
    const reports = (list.data?.group_report_types ?? []) as Array<{ id: number; report_name: string }>;
    const match = reports.find((r) => r.report_name?.trim().toLowerCase() === reportName.toLowerCase());
    if (match) {
      reportId = match.id;
    } else if (fallbackId === 0) {
      // Log available reports so the user can identify the correct one and set WMS_OUTWARD_REPORT_ID
      const names = reports.map((r) => `${r.id}: ${r.report_name}`).join(", ");
      console.info(`[wms] report "${reportName}" not found. Available: ${names}`);
      throw new Error(`[wms] report "${reportName}" not found — set WMS_OUTWARD_REPORT_ID in .env.local`);
    }
  } catch (err) {
    if ((err as Error).message?.includes("not found")) throw err; // re-throw our own
    console.warn(`[wms] report list failed (${reportName}), using fallback id ${fallbackId}:`, err);
    if (fallbackId === 0) throw new Error(`[wms] report list failed and no fallback id set for "${reportName}"`);
  }

  try {
    const details = await portalGet(
      session,
      `analytics/report/details?user_id=${session.userId}&report_id=${reportId}&module_id=${REPORTS_MODULE_ID}&account_id=${session.accountId}&company_id=${session.companyId}&warehouse_id=${session.warehouseId}`,
    );
    if (Array.isArray(details) && details.length > 0) {
      spName = details[0].report_sp ?? spName;
      paramDefs = details as ParamDef[];
    }
  } catch (err) {
    console.warn(`[wms] report details failed (${reportName}), using fallback sp:`, err);
  }

  const valueFor = (name: string, defaultVal: string): string => {
    const n = name.toLowerCase();
    if (n.includes("user")) return String(session.userId);
    if (n.includes("account")) return String(session.accountId);
    if (n.includes("company")) return String(session.companyId);
    if (n.includes("warehouse")) return String(session.warehouseId);
    if (options?.from && (n.includes("from") || n.includes("start"))) return wmsDate(options.from);
    if (options?.until && (n.includes("to") || n.includes("end"))) return wmsDate(options.until);
    // Fall back to whatever the portal said the default is
    return defaultVal ?? "";
  };

  const report_param_dtl =
    paramDefs.length > 0
      ? paramDefs.map((p) => ({
          parameter_name: p.parameter_name,
          control_type_id: p.control_type_id,
          value: valueFor(p.parameter_name, p.default_value),
          value1: null,
          parameter: p.parameter,
          actual_value: "",
        }))
      : [
          { parameter_name: "p_user_id", control_type_id: 5, value: String(session.userId), value1: null, parameter: "User", actual_value: "" },
          { parameter_name: "p_account_id", control_type_id: 5, value: String(session.accountId), value1: null, parameter: "Account", actual_value: "" },
          { parameter_name: "p_company_id", control_type_id: 5, value: String(session.companyId), value1: null, parameter: "Company", actual_value: "" },
          { parameter_name: "p_warehouse_id", control_type_id: 5, value: String(session.warehouseId), value1: null, parameter: "Warehouse", actual_value: "" },
          ...(options?.from ? [{ parameter_name: "p_from_date", control_type_id: 5, value: wmsDate(options.from), value1: null, parameter: "From Date", actual_value: "" }] : []),
          ...(options?.until ? [{ parameter_name: "p_to_date", control_type_id: 5, value: wmsDate(options.until), value1: null, parameter: "To Date", actual_value: "" }] : []),
        ];

  console.info(`[wms] report-output ${reportName} — id=${reportId} sp=${spName} params=${JSON.stringify(report_param_dtl)}`);

  const reportBody = JSON.stringify({ sp_name: spName, report_param_dtl, report_id: reportId });

  // Helper for the POST — retries once on 401 with a fresh token (same pattern as portalGet).
  const doReportOutput = async (tok: string) =>
    fetch(`${env.WMS_PORTAL_BASE_URL}/api/analytics/report/report-output`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "X-Requested-With": "XMLHttpRequest" },
      body: reportBody,
    });

  let outRes = await doReportOutput(session.token);
  if (outRes.status === 401) {
    console.warn(`[wms] report-output 401 for "${reportName}" — re-authenticating and retrying`);
    portalSession = null;
    const fresh = await portalAuth();
    Object.assign(session, fresh);
    outRes = await doReportOutput(fresh.token);
  }
  if (!outRes.ok) throw new Error(`[wms] report-output ${outRes.status}: ${await outRes.text()}`);
  const out = await outRes.json();
  const fileUrl = out.data?.file_url as string | undefined;
  if (!fileUrl) throw new Error(`[wms] report-output returned no file_url: ${JSON.stringify(out).slice(0, 300)}`);

  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`[wms] report download ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

// The Consolidated MIS Report (per ops) — its "Stock Report" sheet carries the
// per-warehouse saleable/locked/free figures we mirror.
const STOCK_REPORT_NAME = "consolidated mis report";
const STOCK_REPORT_FALLBACK_ID = 629;
const STOCK_REPORT_FALLBACK_SP = "sp_rpt_combined_mis_so_pick_locked";

/**
 * Runs the WMS "Consolidated MIS Report" (all warehouses, Pan India) and
 * returns every row of its Stock Report sheet. Filter on
 * stockType === "Saleable" for sellable units.
 */
export async function fetchWmsStock(): Promise<WmsStockRow[]> {
  const buf = await runPortalReport(STOCK_REPORT_NAME, STOCK_REPORT_FALLBACK_ID, STOCK_REPORT_FALLBACK_SP);
  return parseStockReportXlsx(buf);
}

// ── Outward LOI Report ──────────────────────────────────────────────────────
// "Outbound" sheet of the Outward LOI Report carries per-SKU dispatch lines
// with an Outward Date, which we use to compute 7D / 30D daily run rates for
// the Inventory Cover table in Analytics.

const OUTWARD_REPORT_NAME = "outward loi report";
// Fallback ID/SP — will be overridden by env vars or by live report discovery.
// If the portal uses a different name, set WMS_OUTWARD_REPORT_ID + WMS_OUTWARD_REPORT_SP in .env.local.
const OUTWARD_REPORT_FALLBACK_ID = 0;
const OUTWARD_REPORT_FALLBACK_SP = "sp_rpt_outward_loi";

export interface WmsOutwardRow {
  skuCode: string;
  skuDescription: string;
  warehouseName: string;
  outwardDate: Date;
  dispatchedQty: number;
}

/** Fetches the WMS Outward LOI Report and returns all outward lines since `since`. */
export async function fetchWmsOutwardReport(since: Date): Promise<WmsOutwardRow[]> {
  const fallbackId = env.WMS_OUTWARD_REPORT_ID ?? OUTWARD_REPORT_FALLBACK_ID;
  const fallbackSp = env.WMS_OUTWARD_REPORT_SP ?? OUTWARD_REPORT_FALLBACK_SP;
  const reportName = OUTWARD_REPORT_NAME;
  const buf = await runPortalReport(reportName, fallbackId, fallbackSp, {
    from: since,
    until: new Date(),
  });
  return parseOutwardReportXlsx(buf, since);
}

/** Parses the "Outbound" (or first) sheet of the Outward LOI Report xlsx. */
export function parseOutwardReportXlsx(buf: Buffer, since?: Date): WmsOutwardRow[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => {
      const ln = n.trim().toLowerCase();
      return ln === "outbound" || ln.startsWith("outward") || ln.startsWith("dispatch");
    }) ?? wb.SheetNames[0];

  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName!]!, { header: 1, raw: false });

  const headerIdx = rows.findIndex(
    (r) =>
      Array.isArray(r) &&
      r.some((c) => normHeader(c).includes("skucode")) &&
      r.some((c) => {
        const h = normHeader(c);
        return h.includes("outwarddate") || h.includes("dispatchdate") || h === "date";
      }),
  );
  if (headerIdx === -1) throw new Error(`[wms] no header row found in outward sheet "${sheetName}"`);

  const header = (rows[headerIdx] as unknown[]).map(normHeader);

  const col = (...patterns: string[]): number => {
    for (const pat of patterns) {
      const i = header.findIndex((h) => h === pat || h.startsWith(pat) || h.includes(pat));
      if (i !== -1) return i;
    }
    return -1;
  };

  const cSku = col("skucode");
  const cDesc = col("skudescription");
  const cWh = col("warehouse");
  const cDate = col("outwarddate", "dispatchdate", "date");
  const cQty = col("dispatchedqty", "outwardqty", "dispatchqty", "quantity", "qty");

  if (cSku === -1 || cDate === -1 || cQty === -1) {
    throw new Error(
      `[wms] outward report missing required columns — found: ${header.slice(0, 12).join(", ")}`,
    );
  }

  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0);

  const parseDate = (v: unknown): Date | null => {
    if (v instanceof Date) return v;
    if (typeof v === "string" && v.trim()) {
      // Support dd-MM-yyyy, dd/MM/yyyy, yyyy-MM-dd
      const parts = v.trim().split(/[-/]/);
      if (parts.length === 3) {
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        const c = Number(parts[2]);
        // If first part > 31 it's yyyy-MM-dd
        if (a > 31) return new Date(a, b - 1, c);
        return new Date(c, b - 1, a);
      }
    }
    return null;
  };

  const result: WmsOutwardRow[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    if (!Array.isArray(r)) continue;
    const skuCode = String(r[cSku] ?? "").trim();
    if (!skuCode) continue;
    const outwardDate = parseDate(r[cDate]);
    if (!outwardDate || isNaN(outwardDate.getTime())) continue;
    if (since && outwardDate < since) continue;
    const dispatchedQty = num(r[cQty]);
    if (dispatchedQty <= 0) continue;
    result.push({
      skuCode,
      skuDescription: cDesc !== -1 ? String(r[cDesc] ?? "").trim() : "",
      warehouseName: cWh !== -1 ? String(r[cWh] ?? "").trim() : "",
      outwardDate,
      dispatchedQty,
    });
  }
  return result;
}

/** Normalize a header cell: "SALESORDER LOCKED QUANTITY" → "salesorderlockedquantity" */
const normHeader = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Parses the per-warehouse stock sheet of a WMS report workbook.
 * Handles both header variants ("… LOCKED STOCK" in the MIS report,
 * "… LOCKED QUANTITY" in the consolidated stock report).
 */
export function parseStockReportXlsx(buf: Buffer): WmsStockRow[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName =
    wb.SheetNames.find((n) => n.trim().toLowerCase() === "stock report") ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName!]!, { header: 1 });

  // Find the header row (reports prepend company/title rows)
  const headerIdx = rows.findIndex(
    (r) => Array.isArray(r) && r.some((c) => normHeader(c) === "warehouse") && r.some((c) => normHeader(c).startsWith("skucode")),
  );
  if (headerIdx === -1) throw new Error(`[wms] no header row found in sheet "${sheetName}"`);

  const header = (rows[headerIdx] as unknown[]).map(normHeader);
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.findIndex((h) => h === n || h.startsWith(n));
      if (i !== -1) return i;
    }
    return -1;
  };
  const cWarehouse = col("warehouse");
  const cSku = col("skucode");
  const cDesc = col("skudescription");
  const cType = col("stocktype");
  const cQty = col("quantity");
  const cSoLock = col("salesorderlocked");
  const cPickLock = col("pickinglocked");
  const cFree = col("freeavailable");

  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0);

  const result: WmsStockRow[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    if (!Array.isArray(r)) continue;
    const warehouseName = String(r[cWarehouse] ?? "").trim();
    const skuCode = String(r[cSku] ?? "").trim();
    if (!warehouseName || !skuCode) continue;
    const quantity = num(r[cQty]);
    const lockedQty = num(r[cSoLock]) + num(r[cPickLock]);
    result.push({
      warehouseName,
      skuCode,
      skuDescription: String(r[cDesc] ?? "").trim(),
      stockType: String(r[cType] ?? "").trim(),
      quantity,
      lockedQty,
      freeQty: cFree !== -1 ? num(r[cFree]) : Math.max(0, quantity - lockedQty),
    });
  }
  return result;
}
