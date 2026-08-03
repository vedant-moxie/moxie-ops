import "server-only";
import * as XLSX from "xlsx";
import { env } from "@/lib/env";
import { WAREHOUSES } from "@/lib/warehouses";

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
  /** user uid — needed by the default-access (warehouse switch) endpoint */
  userUid: string;
  roleId: number;
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
    userUid: data.uid as string,
    roleId: data.default_role_id as number,
    accountId: data.default_account_id as number,
    companyId: data.default_company_id as number,
    warehouseId: data.default_warehouse_id as number,
    expiresAt: Date.now() + 7.5 * 3_600_000,
  };
  return portalSession;
}

/**
 * Switches the portal account's default warehouse — the same call the portal UI makes
 * when you pick a warehouse on the landing screen.
 *
 * This is a WRITE, and the only one this integration performs. It exists because the
 * Outward LOI Report's `p_warehouse_id` parameter is `is_disabled`: the report always
 * returns whichever warehouse the account currently has selected, so covering all three
 * Moxie warehouses means switching between fetches. Callers must restore the original
 * (see fetchSalesOrdersFromOutwardLoi, which does so even on failure).
 *
 * Returns the warehouse id that was selected before the switch.
 */
export async function switchPortalWarehouse(warehouseId: number): Promise<number> {
  const session = await portalAuth();
  const previous = session.warehouseId;
  if (previous === warehouseId) return previous;
  const res = await fetch(
    `${env.WMS_PORTAL_BASE_URL}/api/security/user/default-access/${session.userUid}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({
        default_role_id: session.roleId,
        default_account_id: session.accountId,
        default_warehouse_id: warehouseId,
      }),
    },
  );
  if (!res.ok) throw new Error(`[wms] warehouse switch → ${res.status}: ${await res.text()}`);
  // Force a fresh session so the next report picks up the new default.
  portalSession = null;
  return previous;
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

/**
 * Raw authenticated call against an arbitrary portal path — endpoint discovery only
 * (scripts/probe-wms-so-endpoints.ts). Returns status + body instead of throwing.
 */
export async function portalProbe(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const session = await portalAuth();
  const res = await fetch(`${env.WMS_PORTAL_BASE_URL}/api/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      "X-Requested-With": "XMLHttpRequest",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify(body ?? {
      user_id: session.userId,
      account_id: session.accountId,
      company_id: session.companyId,
      warehouse_id: session.warehouseId,
      page: 1,
      page_size: 5,
    }) : undefined,
  });
  return { status: res.status, body: await res.text().catch(() => "") };
}

/** Every report the portal exposes (id + name) — used to discover report names. */
export async function listPortalReports(moduleId = 5): Promise<Array<{ id: number; report_name: string }>> {
  const session = await portalAuth();
  const list = await portalGet(
    session,
    `analytics/report/list?user_id=${session.userId}&company_id=${session.companyId}&account_id=${session.accountId}&warehouse_id=${session.warehouseId}&module_id=${moduleId}`,
  );
  return (list.data?.group_report_types ?? []) as Array<{ id: number; report_name: string }>;
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
export async function runPortalReport(
  reportName: string,
  fallbackId: number,
  fallbackSp: string,
  options?: {
    from?: Date;
    until?: Date;
    /** Override the session's default warehouse — needed to sweep several warehouses. */
    warehouseId?: number;
    /** Some reports want yyyy-MM-dd rather than the portal's usual dd-MM-yyyy. */
    isoDates?: boolean;
  },
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

  const fmtDate = (d: Date) => (options?.isoDates ? d.toISOString().slice(0, 10) : wmsDate(d));
  const valueFor = (name: string, defaultVal: string): string => {
    const n = name.toLowerCase();
    if (n.includes("user")) return String(session.userId);
    if (n.includes("account")) return String(session.accountId);
    if (n.includes("company")) return String(session.companyId);
    if (n.includes("warehouse")) return String(options?.warehouseId ?? session.warehouseId);
    if (options?.from && (n.includes("from") || n.includes("start"))) return fmtDate(options.from);
    if (options?.until && (n.includes("to") || n.includes("end"))) return fmtDate(options.until);
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
    // This report only honours yyyy-MM-dd; with dd-MM-yyyy it ignores the range and
    // returns every row it has (7.4k vs 625 for a 3-day window).
    isoDates: true,
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

// ── Sales Order read-back ───────────────────────────────────────────────────
// The documented external API is write-only for SOs, and as of the Phase 0 probe
// (2026-08-03) the portal report engine exposes NO salesorder report — see
// plans/008-verify-manual-so-punch.md "Discovery findings". So this stays behind
// env config: the day RGL adds one, set WMS_SO_REPORT_NAME (+ _ID/_SP if the name
// lookup misses) and the SO check starts working with no code change.

export interface WmsSalesOrderRow {
  /** SO id / number as the WMS reports it */
  salesOrderId: string;
  /** order_no — should carry the channel PO number */
  orderNo: string | null;
  /** salesorder_ref_no — should carry our MB email ref */
  refNo: string | null;
  /** party_ref_order_no — third reference column the SO table carries */
  partyRefOrderNo: string | null;
  warehouseName: string | null;
  orderDate: Date | null;
  status: string | null;
  lines: Array<{ skuCode: string; qty: number }>;
  /**
   * False when the source gave us SO headers but no line items — `lines: []` then means
   * "unknown", NOT "zero". The KPI feed (our only working read path) is header-only, so
   * the quantity comparison must be skipped rather than reported as a 100% shortfall.
   */
  linesKnown: boolean;
  /** Destination/customer as the WMS records it — helps humans identify the SO. */
  customer?: string | null;
}

/**
 * Fetches sales orders punched into the WMS for a rolling window.
 *
 * Two sources, by capability:
 *  - WMS_SO_REPORT_NAME set → the report engine, which carries SKU lines (`linesKnown`).
 *    No such report exists today; set this the day RGL adds one.
 *  - otherwise → the dashboard KPI feed, which our read-only login can reach but which
 *    is header-only (no quantities).
 *
 * Throws rather than returning [] on failure — an empty list would look like "nobody
 * punched anything" and flag every PO.
 */
export async function fetchWmsSalesOrders(
  from: Date,
  until = new Date(),
  opts: { withLines?: boolean } = {},
): Promise<WmsSalesOrderRow[]> {
  // The KPI feed is cheap, read-only and covers every warehouse — always run it.
  const kpi = await fetchSalesOrdersFromKpi(from);

  // Line quantities come from the Outward LOI Report, which is dispatch-driven and
  // needs a warehouse switch per fetch, so it runs on the daily pass only.
  if (!opts.withLines) return kpi;

  let withQty: WmsSalesOrderRow[] = [];
  if (env.WMS_SO_REPORT_NAME) {
    // An explicit override wins — e.g. if RGL later ships a purpose-built SO report.
    const buf = await runPortalReport(env.WMS_SO_REPORT_NAME, env.WMS_SO_REPORT_ID ?? 0, env.WMS_SO_REPORT_SP ?? "", {
      from,
      until,
      isoDates: true,
    });
    withQty = parseSalesOrderReportXlsx(buf);
  } else {
    const linesFrom = new Date(Date.now() - env.SO_LINES_WINDOW_DAYS * 86_400_000);
    withQty = await fetchSalesOrdersFromOutwardLoi(linesFrom > from ? linesFrom : from, until);
  }

  // Line-bearing rows win, but must not erase what the other source knew: the two feeds
  // put references in different columns (the KPI feed has one combined field, the LOI
  // report has named MOXIE / CHANNEL columns, either of which the WH team may leave
  // blank), so references are merged field-by-field rather than overwritten wholesale.
  const merged = new Map<string, WmsSalesOrderRow>();
  for (const so of kpi) merged.set(so.salesOrderId, so);
  for (const so of withQty) {
    const prior = merged.get(so.salesOrderId);
    merged.set(so.salesOrderId, {
      ...so,
      orderNo: so.orderNo ?? prior?.orderNo ?? null,
      refNo: so.refNo ?? prior?.refNo ?? null,
      partyRefOrderNo: so.partyRefOrderNo ?? prior?.partyRefOrderNo ?? null,
      warehouseName: so.warehouseName ?? prior?.warehouseName ?? null,
      orderDate: so.orderDate ?? prior?.orderDate ?? null,
      customer: so.customer ?? prior?.customer ?? null,
    });
  }
  return [...merged.values()];
}

/** One row of the portal dashboard's KPI-tracking grid. */
interface KpiRow {
  warehouse?: string | null;
  customer?: string | null;
  /** whatever reference the WH team typed on the SO (channel PO, our MB ref, …) */
  invoice_no?: string | null;
  operation_activity?: string | null;
  /** the SO number, e.g. "SO/BCVBLR/26-27/00905" */
  details?: string | null;
  status?: string | null;
  record_id?: number | null;
  is_inbound?: boolean | null;
  salesorder_date?: string | null;
  expected_dispatch_date?: string | null;
}

async function portalPostJson(session: PortalSession, path: string, body: unknown): Promise<any> {
  const send = (tok: string) =>
    fetch(`${env.WMS_PORTAL_BASE_URL}/api/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(body),
    });
  let res = await send(session.token);
  if (res.status === 401) {
    portalSession = null;
    const fresh = await portalAuth();
    Object.assign(session, fresh);
    res = await send(fresh.token);
  }
  if (!res.ok) throw new Error(`[wms] POST ${path} → ${res.status}`);
  return res.json();
}

/**
 * Reads sales orders from the portal dashboard's KPI-tracking grid
 * (`analytics/dashboard/kpi/list`) — the only SO read path our API login can reach.
 *
 * Header-only: no SKU lines, so every row comes back `linesKnown: false`.
 *
 * It is a TAT work queue, so it lists SOs that have **not been dispatched yet** — an SO
 * disappears once it ships. Callers must therefore accumulate results (see
 * WmsSalesOrderMirror) instead of treating one fetch as the whole truth.
 */
export async function fetchSalesOrdersFromKpi(from: Date): Promise<WmsSalesOrderRow[]> {
  const session = await portalAuth();
  const whList = await portalGet(
    session,
    `common/warehouse/filllist?warehouse_type=company&status_id=1&company_id=${session.companyId}`,
  );
  const warehouses = (whList.data ?? []) as Array<{ id: number; name: string }>;
  if (warehouses.length === 0) throw new Error("[wms] KPI feed: warehouse list came back empty");

  const rows: WmsSalesOrderRow[] = [];
  const seen = new Set<string>();
  for (const wh of warehouses) {
    const json = await portalPostJson(session, "analytics/dashboard/kpi/list", {
      account_id: String(session.accountId),
      warehouse_id: String(wh.id),
      operation: "",
      status_id: "",
    });
    for (const r of (json.data ?? []) as KpiRow[]) {
      if (r.is_inbound) continue;
      if (r.operation_activity && !/outbound/i.test(r.operation_activity)) continue;
      const salesOrderId = (r.details ?? "").trim();
      if (!salesOrderId || seen.has(salesOrderId)) continue;
      const orderDate = r.salesorder_date ? new Date(r.salesorder_date) : null;
      if (orderDate && !isNaN(orderDate.getTime()) && orderDate < from) continue;
      seen.add(salesOrderId);
      rows.push({
        salesOrderId,
        // The feed exposes exactly one reference field; which of our two numbers it
        // holds depends on what the WH team typed, so it is matched against both.
        orderNo: (r.invoice_no ?? "").trim() || null,
        refNo: null,
        partyRefOrderNo: null,
        warehouseName: (r.warehouse ?? wh.name ?? "").trim() || null,
        orderDate: orderDate && !isNaN(orderDate.getTime()) ? orderDate : null,
        status: (r.status ?? "").trim() || null,
        lines: [],
        linesKnown: false,
        customer: (r.customer ?? "").trim() || null,
      });
    }
  }
  console.info(`[wms] KPI feed: ${rows.length} outbound SOs across ${warehouses.length} warehouses`);
  return rows;
}

/**
 * Parses a WMS sales-order report workbook into one row per SO with its lines.
 * Header-tolerant (the real column names are unknown until RGL ships the report),
 * and throws listing what it did find when a required column is missing — a silent
 * mis-parse would read as "no SOs punched" and flag every PO.
 */
export function parseSalesOrderReportXlsx(buf: Buffer): WmsSalesOrderRow[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => {
      const ln = normHeader(n);
      return ln.includes("salesorder") || ln.includes("saleorder") || ln === "so";
    }) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName!]!, { header: 1, raw: false });

  const headerIdx = rows.findIndex(
    (r) =>
      Array.isArray(r) &&
      r.some((c) => normHeader(c).includes("skucode")) &&
      r.some((c) => {
        const h = normHeader(c);
        return h.includes("salesorder") || h.includes("orderno") || h.includes("sono");
      }),
  );
  if (headerIdx === -1) {
    throw new Error(`[wms] no sales-order header row found in sheet "${sheetName}"`);
  }
  const header = (rows[headerIdx] as unknown[]).map(normHeader);

  // Exact match beats prefix beats substring, and a column is claimed by the first
  // field that wants it — otherwise "SALESORDER NO" (which *contains* "orderno")
  // steals the column meant for ORDER NO, and the channel PO number reads as the SO id.
  const claimed = new Set<number>();
  const col = (...patterns: string[]): number => {
    const tests: Array<(h: string, p: string) => boolean> = [
      (h, p) => h === p,
      (h, p) => h.startsWith(p),
      (h, p) => h.includes(p),
    ];
    for (const test of tests) {
      for (const pat of patterns) {
        const i = header.findIndex((h, idx) => !claimed.has(idx) && test(h, pat));
        if (i !== -1) {
          claimed.add(i);
          return i;
        }
      }
    }
    return -1;
  };

  const cSoId = col("salesorderid", "salesorderno", "sono", "salesordernumber");
  const cOrderNo = col("orderno", "customerorderno", "partyorderno");
  const cRefNo = col("salesorderrefno", "refno", "referenceno");
  const cPartyRef = col("partyreforderno", "partyrefno");
  const cWh = col("warehouse");
  const cDate = col("orderdate", "salesorderdate", "date");
  const cStatus = col("orderstatus", "status");
  const cSku = col("skucode");
  const cQty = col("orderqty", "salesorderqty", "quantity", "qty");

  if ((cSoId === -1 && cOrderNo === -1) || cSku === -1 || cQty === -1) {
    throw new Error(
      `[wms] sales-order report missing required columns — found: ${header.slice(0, 16).join(", ")}`,
    );
  }

  const text = (r: unknown[], i: number): string | null => {
    if (i === -1) return null;
    const v = String(r[i] ?? "").trim();
    return v || null;
  };
  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0);

  const byId = new Map<string, WmsSalesOrderRow>();
  for (const r of rows.slice(headerIdx + 1)) {
    if (!Array.isArray(r)) continue;
    const skuCode = text(r, cSku);
    const soId = text(r, cSoId) ?? text(r, cOrderNo);
    if (!soId || !skuCode) continue;
    let so = byId.get(soId);
    if (!so) {
      so = {
        salesOrderId: soId,
        orderNo: text(r, cOrderNo),
        refNo: text(r, cRefNo),
        partyRefOrderNo: text(r, cPartyRef),
        warehouseName: text(r, cWh),
        orderDate: parseWmsDate(cDate === -1 ? null : r[cDate]),
        status: text(r, cStatus),
        lines: [],
        // A report row carries its SKU + qty columns, so quantities are authoritative.
        linesKnown: true,
      };
      byId.set(soId, so);
    }
    const qty = num(r[cQty]);
    // Same SKU can repeat across batches on one SO — sum, don't overwrite.
    const existing = so.lines.find((l) => l.skuCode === skuCode);
    if (existing) existing.qty += qty;
    else so.lines.push({ skuCode, qty });
  }
  return [...byId.values()];
}

// ── Outward LOI Report → sales orders WITH quantities ───────────────────────
// Report 388 ("Outbound/Outward LOI Report", sp_rpt_outward_loi_batch) is the only
// source that carries SO number, BOTH PO numbers, SKU code and SKU quantity together:
//   WMS Outward No. | Order Received Date | MOXIE PO NO | SKU Code | SKU Quantity |
//   Customer Name | CHANNEL PO NO | CHANNEL | Invoice No. | Dispatch Date
// Two quirks, both handled below:
//   1. It wants yyyy-MM-dd dates. With dd-MM-yyyy it silently ignores the range and
//      returns everything (7.4k rows instead of 625).
//   2. Its warehouse parameter is disabled — see switchPortalWarehouse.
// It is dispatch-driven, so an SO appears here only once it ships; the KPI feed covers
// the not-yet-dispatched window.

const OUTWARD_LOI_ID = 388;
const OUTWARD_LOI_SP = "sp_rpt_outward_loi_batch";

/**
 * Fetches sales orders (with line quantities) from the Outward LOI Report for every
 * warehouse in our registry, switching the portal's selected warehouse per fetch and
 * restoring the original afterwards — including when a fetch throws.
 */
export async function fetchSalesOrdersFromOutwardLoi(
  from: Date,
  until = new Date(),
): Promise<WmsSalesOrderRow[]> {
  const session = await portalAuth();
  const original = session.warehouseId;
  const rows: WmsSalesOrderRow[] = [];
  const failed: string[] = [];
  try {
    for (const wh of WAREHOUSES) {
      // One warehouse timing out must not lose the others: quantities are a bonus on
      // top of the KPI feed, which already established that each SO exists.
      try {
        await switchPortalWarehouse(wh.portalWarehouseId);
        const buf = await withRetry(() =>
          runPortalReport(OUTWARD_REPORT_NAME, OUTWARD_LOI_ID, OUTWARD_LOI_SP, {
            from,
            until,
            isoDates: true,
          }),
        );
        const parsed = parseOutwardLoiSalesOrders(buf, wh.wmsName);
        console.info(`[wms] outward LOI ${wh.code}: ${parsed.length} sales orders`);
        rows.push(...parsed);
      } catch (err) {
        failed.push(wh.code);
        console.warn(`[wms] outward LOI ${wh.code} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    // Leave the account exactly as we found it, even if a report failed mid-sweep.
    await switchPortalWarehouse(original).catch((e) =>
      console.error("[wms] FAILED to restore default warehouse — portal left on another warehouse:", e),
    );
  }
  if (failed.length === WAREHOUSES.length) {
    throw new Error(`[wms] outward LOI failed for every warehouse (${failed.join(", ")})`);
  }
  if (failed.length > 0) {
    console.warn(`[wms] outward LOI incomplete — no quantities for ${failed.join(", ")} this run`);
  }
  return rows;
}

/** Report generation and its S3 download are occasionally slow — one retry. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn("[wms] report attempt failed, retrying once:", err instanceof Error ? err.message : err);
    return fn();
  }
}

/**
 * Parses the Outward LOI Report into one row per sales order with summed SKU lines.
 * The report emits one row per SKU *per batch*, so the same SKU legitimately repeats
 * within an SO and must be summed rather than overwritten.
 */
export function parseOutwardLoiSalesOrders(buf: Buffer, warehouseName?: string): WmsSalesOrderRow[] {
  const wb = XLSX.read(buf, { type: "buffer", raw: false });
  const sheetName =
    wb.SheetNames.find((n) => normHeader(n).includes("outwardloi")) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName!]!, { header: 1, raw: false });

  const headerIdx = rows.findIndex(
    (r) =>
      Array.isArray(r) &&
      r.some((c) => normHeader(c).includes("outwardno")) &&
      r.some((c) => normHeader(c).includes("skucode")),
  );
  if (headerIdx === -1) {
    throw new Error(`[wms] no Outward LOI header row found in sheet "${sheetName}"`);
  }
  const header = (rows[headerIdx] as unknown[]).map(normHeader);
  const col = columnFinder(header);

  // Order matters: the more specific name must claim its column first, or "channel"
  // would swallow "CHANNEL PO NO".
  const cSo = col("wmsoutwardno", "outwardno");
  const cMoxiePo = col("moxiepono");
  const cChannelPo = col("channelpono");
  const cChannel = col("channel");
  const cSku = col("skucode");
  const cQty = col("skuquantity");
  const cCustomer = col("customername");
  const cOrderDate = col("orderreceiveddate", "outwarddate");
  const cDispatch = col("dispatchdate");
  const cInvoice = col("invoiceno");

  if (cSo === -1 || cSku === -1 || cQty === -1) {
    throw new Error(
      `[wms] Outward LOI missing required columns — found: ${header.slice(0, 20).join(", ")}`,
    );
  }

  const text = (r: unknown[], i: number): string | null => {
    if (i === -1) return null;
    const v = String(r[i] ?? "").trim();
    return v || null;
  };
  const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "")) || 0);

  const byId = new Map<string, WmsSalesOrderRow>();
  for (const r of rows.slice(headerIdx + 1)) {
    if (!Array.isArray(r)) continue;
    const soId = text(r, cSo);
    const skuCode = text(r, cSku);
    if (!soId || !skuCode) continue;
    let so = byId.get(soId);
    if (!so) {
      so = {
        salesOrderId: soId,
        // Our two references live in named columns here, unlike the KPI feed's single field.
        orderNo: text(r, cChannelPo),
        refNo: text(r, cMoxiePo),
        partyRefOrderNo: null,
        warehouseName: warehouseName ?? null,
        orderDate: parseWmsDate(cOrderDate === -1 ? null : r[cOrderDate]),
        status: text(r, cInvoice) ? "Invoiced" : (text(r, cDispatch) ? "Dispatched" : null),
        lines: [],
        linesKnown: true,
        customer: text(r, cCustomer) ?? text(r, cChannel),
      };
      byId.set(soId, so);
    }
    const qty = num(r[cQty]);
    const existing = so.lines.find((l) => l.skuCode === skuCode);
    if (existing) existing.qty += qty; // same SKU across batches
    else so.lines.push({ skuCode, qty });
  }
  return [...byId.values()];
}

/**
 * Column locator for a normalised header row. Exact match beats prefix beats substring,
 * and each column is claimed by the first field that wants it — otherwise a header that
 * merely *contains* another's name (e.g. "CHANNEL PO NO" vs "CHANNEL") steals it.
 */
function columnFinder(header: string[]): (...patterns: string[]) => number {
  const claimed = new Set<number>();
  const tests: Array<(h: string, p: string) => boolean> = [
    (h, p) => h === p,
    (h, p) => h.startsWith(p),
    (h, p) => h.includes(p),
  ];
  return (...patterns: string[]): number => {
    for (const test of tests) {
      for (const pat of patterns) {
        const i = header.findIndex((h, idx) => !claimed.has(idx) && test(h, pat));
        if (i !== -1) {
          claimed.add(i);
          return i;
        }
      }
    }
    return -1;
  };
}

/** dd-MM-yyyy / dd/MM/yyyy / yyyy-MM-dd, or a real Date from cellDates. */
export function parseWmsDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" || !v.trim()) return null;
  const parts = v.trim().split(/[^0-9]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  const d = a > 31 ? new Date(a, b - 1, c) : new Date(c, b - 1, a);
  return isNaN(d.getTime()) ? null : d;
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
