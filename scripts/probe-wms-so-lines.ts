/**
 * Plan 008 Phase 0 (round 4) — analytics/dashboard/kpi/list gives us real SO headers
 * (SO number, channel ref, customer, dates) plus an internal `record_id`. The SKU-wise
 * quantity check needs LINES, so: can a real record_id reach a detail payload?
 *
 * Read-only GETs (plus list/search-shaped POSTs). Run:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/probe-wms-so-lines.ts
 */
import { portalProbe } from "../lib/integrations/wms";

async function portalAuthRaw() {
  return fetch(`${process.env.WMS_PORTAL_BASE_URL}/api/security/user/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({
      email_address: process.env.WMS_EMAIL,
      password: process.env.WMS_PASSWORD,
      client_date_format: "dd-MM-yyyy",
    }),
  }).then((r) => r.json());
}

/** Pull live SO headers (and their record_ids) from the dashboard KPI grid. */
async function kpiList(accountId: number, warehouseId: number | string, token: string) {
  const res = await fetch(`${process.env.WMS_PORTAL_BASE_URL}/api/analytics/dashboard/kpi/list`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({
      account_id: String(accountId),
      warehouse_id: String(warehouseId),
      operation: "",
      status_id: "",
    }),
  });
  const json = await res.json().catch(() => ({}));
  return (json.data ?? []) as any[];
}

async function main() {
  const auth = await portalAuthRaw();
  const token = auth.token as string;
  const accountId = auth.default_account_id as number;

  // Which warehouses can we ask about?
  const whRes = await portalProbe("common/warehouse/filllist?warehouse_type=company&status_id=1&company_id=1");
  const warehouses = (JSON.parse(whRes.body || "{}").data ?? []) as any[];
  console.log("=== warehouses ===");
  for (const w of warehouses) console.log(`  id=${w.id}\t${w.name}`);

  // Sweep every warehouse for live SOs.
  const all: any[] = [];
  for (const w of warehouses) {
    const rows = await kpiList(accountId, w.id, token);
    const out = rows.filter((r) => !r.is_inbound);
    console.log(`\n=== ${w.name} (id=${w.id}) — ${rows.length} rows, ${out.length} outbound ===`);
    for (const r of out) {
      console.log(`  ${r.details}\tref=${r.invoice_no}\tcust=${r.customer}\trecord_id=${r.record_id}\tdate=${r.salesorder_date}`);
    }
    all.push(...out);
  }
  if (all.length === 0) {
    console.log("\nNo live outbound rows right now — re-run during working hours.");
    return;
  }

  // Can a REAL record_id reach line-level detail?
  const id = all[0].record_id;
  const soNo = all[0].details as string;
  console.log(`\n=== detail probe with real record_id=${id} (${soNo}) ===`);
  const paths = [
    `outbound/sales-order/${id}`,
    `outbound/sales-order/detail?salesorder_id=${id}`,
    `outbound/sales-order/detail/${id}`,
    `outbound/sales-order/loi/${id}`,
    `outbound/sales-order/loi?salesorder_id=${id}`,
    `outbound/sales-order/view/${id}`,
    `outbound/sales-order/${id}/loi`,
    `outbound/sales-order/${id}/detail`,
    `analytics/dashboard/kpi/detail?record_id=${id}`,
    `analytics/dashboard/kpi/${id}`,
    `outbound/salesorder/${id}`,
    `outbound/sales-order/get/${id}`,
    `outbound/pick-list/salesorder/${id}`,
  ];
  for (const p of paths) {
    const r = await portalProbe(p, "GET");
    if (r.status === 404) continue;
    const body = r.body.replace(/\s+/g, " ");
    const empty = /"data"\s*:\s*(null|\[\s*\])/.test(body);
    console.log(`  ${empty ? " " : "★"} ${r.status} ${p}\n      ${body.slice(0, 400)}`);
  }

  // Does the SO number itself work as a lookup key anywhere?
  console.log(`\n=== lookup by SO number ${soNo} ===`);
  for (const p of [
    `outbound/sales-order/list?order_no=${encodeURIComponent(soNo)}`,
    `outbound/sales-order/search?search=${encodeURIComponent(soNo)}`,
    `common/common/salesorder/filllist?search=${encodeURIComponent(soNo)}`,
  ]) {
    const r = await portalProbe(p, "GET");
    if (r.status === 404) continue;
    const body = r.body.replace(/\s+/g, " ");
    console.log(`  ${/"data"\s*:\s*(null|\[\s*\])/.test(body) ? " " : "★"} ${r.status} ${p}\n      ${body.slice(0, 300)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
