/**
 * Plan 008 Phase 0 — is there a way to READ sales orders back out of the WMS?
 *
 * Re-run this when RGL says they've added a salesorder report or granted Outbound
 * access; it prints everything needed to decide. Strictly read-only: GETs plus POSTs
 * to list/search/grid-shaped paths only — never insert / update / delete.
 *
 * Run: npx tsx --env-file=.env.local --conditions=react-server scripts/probe-wms-so-readpath.ts
 *
 * Findings as of 2026-08-03 are written up in plans/008-verify-manual-so-punch.md.
 * The companion Playwright probe (what the live SPA actually calls) is
 * scripts/probe-wms-spa-so.ts.
 */
import * as XLSX from "xlsx";
import { listPortalReports, portalProbe, runPortalReport } from "../lib/integrations/wms";

const SO_REPORT = /sales\s*order|salesorder/i;

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

/** 1. What role/modules does our API login actually have? */
async function probeRole() {
  const a = await portalAuthRaw();
  console.log("\n=== our login ===");
  console.log("roles:", (a.user_roles ?? []).map((r: any) => r.role_name).join(", ") || "none");
  console.log(
    "default:",
    `${a.default_warehouse_name} (${a.default_warehouse_id}) / ${a.default_account_name} (${a.default_account_id})`,
  );
  const modules = [...new Set(((a.user_module_access ?? []) as any[]).map((m) => m.module_name))];
  console.log("modules:", modules.join(", "));
  const outbound = modules.some((m) => /outbound|sales/i.test(String(m)));
  console.log(outbound ? "→ Outbound access: YES" : "→ Outbound access: NO (SPA never calls an SO screen)");
  return a;
}

/** 2. Does the report engine expose a salesorder report? */
async function probeReports() {
  console.log("\n=== report engine ===");
  const seen = new Map<number, string>();
  for (const moduleId of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const reports = await listPortalReports(moduleId).catch(() => []);
    for (const r of reports) seen.set(r.id, r.report_name);
  }
  for (const [id, name] of [...seen].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${id}\t${name}${SO_REPORT.test(name) ? "  ← SALESORDER" : ""}`);
  }
  const hits = [...seen.values()].filter((n) => SO_REPORT.test(n));
  console.log(hits.length ? `→ candidate report(s): ${hits.join(", ")}` : "→ no salesorder report");
  return hits;
}

/** 3. Dump sheets + headers of the SO candidates and of the MIS report we already use. */
async function dumpWorkbooks(candidates: string[]) {
  const from = new Date(Date.now() - 30 * 86_400_000);
  for (const name of [...candidates.map((c) => c.trim().toLowerCase()), "consolidated mis report"]) {
    console.log(`\n=== workbook: ${name} ===`);
    try {
      const buf = await runPortalReport(name, 0, "", { from, until: new Date() });
      const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
      console.log("sheets:", wb.SheetNames.join(" | "));
      for (const sheet of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet]!, { header: 1, raw: false });
        const header = rows.find((r) => Array.isArray(r) && r.filter(Boolean).length > 4);
        console.log(`  [${sheet}] ${rows.length} rows · header: ${JSON.stringify(header)?.slice(0, 300)}`);
      }
    } catch (e) {
      console.log(`  FAILED — ${(e as Error).message}`);
    }
  }
}

/** 4. Is there an SPA-style sales-order list/detail endpoint we can call? */
async function probeEndpoints() {
  console.log("\n=== endpoint probe ===");
  const paths = new Set<string>();
  for (const m of ["outbound", "outward", "order", "transaction"]) {
    for (const e of ["sales-order", "salesorder", "sale-order", "so"]) {
      for (const a of ["list", "search", "grid", "get-list", "detail", "header", "loi", ""]) {
        paths.add(a ? `${m}/${e}/${a}` : `${m}/${e}`);
      }
    }
  }
  // A catch-all controller answers 200/data:null for every segment, so probe a few
  // ids too — real data on any of them would mean a usable detail route.
  for (const id of ["1", "1000", "100000"]) paths.add(`outbound/sales-order/${id}`);

  let usable = 0;
  for (const path of [...paths].sort()) {
    const r = await portalProbe(path, "GET");
    if (r.status === 404) continue;
    const body = r.body.replace(/\s+/g, " ");
    const empty = /"data"\s*:\s*(null|\[\s*\])/.test(body);
    console.log(`  ${empty ? " " : "★"} ${r.status} ${path} ${body.slice(0, 160)}`);
    if (!empty && r.status < 400) usable++;
  }
  console.log(usable ? `→ ${usable} endpoint(s) returned data` : "→ every endpoint returned empty data");
}

async function main() {
  await probeRole();
  const candidates = await probeReports();
  await dumpWorkbooks(candidates);
  await probeEndpoints();
  console.log(
    "\nIf a salesorder report showed up above: set WMS_SO_REPORT_NAME to its name and " +
      "re-run the SO check — no code change needed.",
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
