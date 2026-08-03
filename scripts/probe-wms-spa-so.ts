/**
 * Plan 008 Phase 0 step 1a — capture the network calls the WMS portal SPA makes on
 * its Sales Order screen, since the report engine has no Salesorder report and
 * GET outbound/sales-order/* answers 200/data:null for every segment.
 *
 * Read-only: logs in, opens the SO screen, records XHRs. Clicks nothing that writes.
 *
 * Run: npx tsx --env-file=.env.local --conditions=react-server scripts/probe-wms-spa-so.ts
 */
import { chromium } from "playwright";

const OUT = process.env.PROBE_OUT ?? "/tmp/wms-so-probe";
const PORTAL = process.env.WMS_PORTAL_URL ?? "https://wms.myrgl.com";

async function main() {
  const email = process.env.WMS_EMAIL!;
  const password = process.env.WMS_PASSWORD!;
  if (!email || !password) throw new Error("WMS_EMAIL / WMS_PASSWORD not set");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

  const calls: Array<{ method: string; url: string; status: number; body: string }> = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!/myrgl\.com\/api\//.test(url)) return;
    let body = "";
    try {
      body = (await res.text()).slice(0, 600);
    } catch {}
    calls.push({ method: res.request().method(), url, status: res.status(), body });
  });

  await page.goto(PORTAL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"], input[type="text"], #email', { timeout: 20_000 });
  await page.fill('input[type="email"], input[type="text"], #email', email);
  await page.fill('input[type="password"]', password);
  await page.screenshot({ path: `${OUT}-00-login.png` });
  console.log("buttons:", JSON.stringify(await page.evaluate(() =>
    Array.from(document.querySelectorAll("button,input[type=submit],a")).map((e) => ({
      tag: e.tagName, type: (e as HTMLInputElement).type ?? "", text: (e.textContent ?? "").trim().slice(0, 30),
    })),
  )).slice(0, 1200));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(9_000);
  await page.screenshot({ path: `${OUT}-01-after-login.png`, fullPage: false });
  console.log("URL after login:", page.url());

  // The landing page is a warehouse/account picker — pick the busiest warehouse's
  // MOXIE account, then Proceed into the app proper.
  await page.getByText("RGL GURGAON HARYANA", { exact: false }).first()
    .locator("xpath=following::*[contains(text(),'MOXIE')][1]").click({ timeout: 10_000 })
    .catch(async () => { await page.getByText("MOXIE", { exact: false }).first().click({ timeout: 10_000 }); });
  await page.waitForTimeout(1_500);
  await page.getByText("Proceed", { exact: false }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: `${OUT}-02-app.png` });
  console.log("URL after proceed:", page.url());

  const menu = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a,button,li,span")).map((e) => ({
      t: (e.textContent ?? "").trim().slice(0, 40),
      href: (e as HTMLAnchorElement).getAttribute?.("href") ?? "",
    })).filter((x) => x.t.length > 2 && x.t.length < 40),
  );
  console.log("menu:", JSON.stringify([...new Map(menu.map((m) => [m.t + m.href, m])).values()]).slice(0, 4000));

  // Open Outbound → Sales Order via the menu.
  for (const label of ["Outbound", "Sales Order", "Salesorder", "Sales order"]) {
    const el = page.getByText(label, { exact: false }).first();
    if (await el.count().catch(() => 0)) {
      const before = calls.length;
      await el.click({ timeout: 6_000 }).catch(() => {});
      await page.waitForTimeout(6_000);
      console.log(`clicked "${label}" → ${calls.length - before} api calls, url=${page.url()}`);
    }
  }
  await page.screenshot({ path: `${OUT}-03-so-screen.png` });

  console.log(`\n=== ${calls.length} API calls captured ===`);
  for (const c of calls) {
    const marked = /sales|order|so/i.test(c.url) ? "★" : " ";
    console.log(`${marked} ${c.method} ${c.status} ${c.url}`);
    if (marked === "★") console.log(`      ${c.body.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  await browser.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
