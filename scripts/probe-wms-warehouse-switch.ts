/**
 * Plan 008 — the Outward LOI Report (388) carries SO no + both PO numbers + SKU + qty,
 * but its `p_warehouse_id` parameter is `is_disabled: true`: the report always returns
 * the warehouse the LOGGED-IN USER currently has selected. To cover all three Moxie
 * warehouses we therefore need the portal's own warehouse-switch call.
 *
 * This probe captures that request (method, URL, body) by driving the picker, then
 * restores the original warehouse. It is the ONE write this discovery needs — it changes
 * a user preference, exactly as clicking the portal UI does.
 *
 * Run: npx tsx --env-file=.env.local --conditions=react-server scripts/probe-wms-warehouse-switch.ts
 */
import { chromium } from "playwright";

const PORTAL = process.env.WMS_PORTAL_URL ?? "https://wms.myrgl.com";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

  const writes: Array<{ method: string; url: string; body: string; status: number }> = [];
  page.on("response", async (res) => {
    const m = res.request().method();
    if (!/myrgl\.com\/api\//.test(res.url())) return;
    if (m === "GET") return;
    writes.push({ method: m, url: res.url(), body: res.request().postData() ?? "", status: res.status() });
  });

  await page.goto(PORTAL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"], input[type="text"], #email', { timeout: 20_000 });
  await page.fill('input[type="email"], input[type="text"], #email', process.env.WMS_EMAIL!);
  await page.fill('input[type="password"]', process.env.WMS_PASSWORD!);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(8_000);

  const settle = async () => {
    await page.waitForSelector("ngx-spinner .overlay", { state: "detached", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(800);
  };

  // Switch to BENGALURU, capturing the call the portal makes.
  const before = writes.length;
  await page.getByText("RGL BENGALURU", { exact: false }).first()
    .locator("xpath=following::*[contains(text(),'MOXIE')][1]").click({ timeout: 10_000 });
  await settle();
  const proceed = page.getByText("Proceed", { exact: false }).first();
  if (await proceed.count().catch(() => 0)) await proceed.click({ timeout: 20_000, force: true }).catch(() => {});
  await page.waitForTimeout(8_000);

  console.log("=== non-GET calls made by the warehouse switch ===");
  for (const w of writes.slice(before)) {
    console.log(`\n${w.method} ${w.status} ${w.url}`);
    console.log(`  BODY: ${w.body.slice(0, 600) || "(empty)"}`);
  }

  // Confirm the switch actually changes what the report returns.
  const auth = await fetch(`${process.env.WMS_PORTAL_BASE_URL}/api/security/user/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({
      email_address: process.env.WMS_EMAIL,
      password: process.env.WMS_PASSWORD,
      client_date_format: "dd-MM-yyyy",
    }),
  }).then((r) => r.json());
  console.log(
    `\nsession default after switch: ${auth.default_warehouse_id} ${auth.default_warehouse_name}`,
  );

  // Restore Gurgaon so we leave the account as we found it.
  await page.goto(`${PORTAL}/home-dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5_000);
  await page.getByText("RGL GURGAON HARYANA", { exact: false }).first()
    .locator("xpath=following::*[contains(text(),'MOXIE')][1]").click({ timeout: 10_000 })
    .catch(() => console.log("(restore click failed — check the portal's selected warehouse)"));
  await settle();
  const p2 = page.getByText("Proceed", { exact: false }).first();
  if (await p2.count().catch(() => 0)) await p2.click({ timeout: 20_000, force: true }).catch(() => {});
  await page.waitForTimeout(6_000);
  const auth2 = await fetch(`${process.env.WMS_PORTAL_BASE_URL}/api/security/user/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
    body: JSON.stringify({
      email_address: process.env.WMS_EMAIL,
      password: process.env.WMS_PASSWORD,
      client_date_format: "dd-MM-yyyy",
    }),
  }).then((r) => r.json());
  console.log(`restored to: ${auth2.default_warehouse_id} ${auth2.default_warehouse_name}`);

  await browser.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
