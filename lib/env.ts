import { z } from "zod";

/**
 * Centralized, validated environment access.
 * Throws on startup (first import) if a required variable is missing.
 *
 * Integration-specific blocks are marked optional so the app boots and the UI
 * renders even before every third-party credential is supplied; the relevant
 * client helper throws a clear error only when that integration is actually used.
 */
const schema = z.object({
  // Core — required to boot
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // Clerk
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  // Comma-separated emails allowed to edit admin-gated config (e.g. SKU master)
  ADMIN_EMAILS: z.string().default("amritya@moxiebeauty.in"),

  // Google OAuth sign-in (custom flow). When all four are set, Google sign-in
  // takes over from Clerk. The redirect URI must exactly match the Google Console
  // entry and end in /auth/google/callback.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  // HMAC key signing the session cookie. Keep stable across restarts; rotating it
  // invalidates all sessions. Required when Google OAuth is enabled.
  MOXIE_SECRET_KEY: z.string().optional(),
  // Comma-separated email domains allowed to sign in via Google. Empty = any
  // Google account (not recommended for a publicly reachable URL).
  ALLOWED_EMAIL_DOMAINS: z.string().default("moxiebeauty.in"),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),

  // Gmail
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_EMAIL: z.string().optional(),

  // Google Sheets
  GOOGLE_SHEETS_CLIENT_EMAIL: z.string().optional(),
  GOOGLE_SHEETS_PRIVATE_KEY: z.string().optional(),
  INVENTORY_SPREADSHEET_ID: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default("ops@moxiebeauty.in"),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  OPS_WHATSAPP_GROUP: z.string().optional(),

  // AWS
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("ap-south-1"),
  S3_BUCKET_NAME: z.string().optional(),

  // Warehouse
  WAREHOUSE_EMAIL: z.string().default("warehouse@moxiebeauty.in"),

  // Channel ingestion — directory a Blinkit dump file may be dropped into (manual fallback)
  BLINKIT_DOWNLOAD_DIR: z.string().optional(),

  // Blinkit / partnersbiz live scraping (the /app/po data source)
  BLINKIT_BASE_URL: z.string().default("https://partnersbiz.com"),
  BLINKIT_API_KEY: z.string().optional(),
  BLINKIT_ENTITY_ID: z.string().optional(),
  BLINKIT_ENTITY_TYPE: z.string().optional(),
  BLINKIT_LOGIN_EMAIL: z.string().optional(), // partnersbiz account; OTP arrives here
  BLINKIT_START_DATE: z.string().default("2026-06-01"), // backfill floor
  // partnersbiz report date filter field. issue_date is the only one the bulk-po
  // export reliably generates on (created_at crashes generation). It lags ~2 days.
  BLINKIT_DATE_FILTER_FIELD: z.string().default("issue_date"),
  // Only ingest POs whose manufacturer_name contains this (case-insensitive). Empty = no filter.
  BLINKIT_MANUFACTURER_FILTER: z.string().default("beyoutiful"),
  // Background auto-sync (runs while the app is up)
  BLINKIT_AUTO_SYNC: z.string().default("true"), // "false" to disable
  BLINKIT_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(3),
  // OTP inbox over IMAP (Gmail app password) — preferred over OAuth for OTP reading
  BLINKIT_OTP_EMAIL: z.string().optional(), // defaults to BLINKIT_LOGIN_EMAIL
  BLINKIT_OTP_APP_PASSWORD: z.string().optional(),
  OTP_IMAP_HOST: z.string().default("imap.gmail.com"),

  // Zepto / brands.zepto.co.in live scraping (mirrors the Blinkit block above)
  // Auth host for the brands app — sign-in + OTP validation happen on fcc.zepto.co.in.
  // (cx.zepto.co.in is a different app that returned 1003 "not approved".)
  ZEPTO_BASE_URL: z.string().default("https://fcc.zepto.co.in"),
  // Application id the brands portal (brands.zepto.co.in) signs in against.
  // d0cd4873 is the confirmed working app (cx 59b80e60 returns 1003).
  ZEPTO_APPLICATION_ID: z.string().default("d0cd4873-7cb3-4c7c-9a25-3b109a0d2301"),
  ZEPTO_LOGIN_EMAIL: z.string().optional(), // Zepto portal account; OTP is sent for this user
  ZEPTO_PASSWORD: z.string().optional(), // Zepto portal password (sign-in body)
  ZEPTO_START_DATE: z.string().default("2026-06-01"), // backfill floor
  // Fallback HS256 jwtToken from a browser-captured request when OTP login is blocked.
  // Set ZEPTO_PORTAL_TOKEN to bypass the login flow and use this token directly.
  ZEPTO_PORTAL_TOKEN: z.string().optional(),
  // PO-listing endpoint. Defaults to the confirmed working brands-app data host.
  ZEPTO_PO_LIST_PATH: z.string().default("https://fcc.zepto.co.in/api/v1/po/filter"),
  // HTTP method for the PO-list endpoint. fcc.zepto.co.in/api/v1/po/filter is POST.
  ZEPTO_PO_LIST_METHOD: z.enum(["GET", "POST"]).default("POST"),
  // POST body template (JSON). Placeholders {since} {until} {page} {pageSize} {offset}.
  // The client sends a best-effort default body; override with the exact captured body
  // if the server rejects the default (field names are proprietary and undocumented).
  ZEPTO_PO_LIST_BODY: z.string().optional(),
  // Cookie header — x-aws-waf-token is NOT required (probed and confirmed). Kept as
  // optional fallback in case the endpoint adds WAF enforcement later.
  ZEPTO_PORTAL_COOKIE: z.string().optional(),
  ZEPTO_PO_DETAIL_PATH: z.string().optional(), // optional per-PO line-items endpoint (use {poId})
  // Optional override for the PO PDF endpoint. {poId} placeholder; {fmt} = pdf|excel.
  // If unset, the client uses GET /api/v1/po/{poId}/attachments, which returns
  // data[].s3Url (a short-lived presigned prod-nexus-svc-bucket URL) for the PO_DOC.
  ZEPTO_PO_DOC_PATH: z.string().optional(),
  // Background auto-sync (runs while the app is up)
  ZEPTO_AUTO_SYNC: z.string().default("true"), // "false" to disable
  ZEPTO_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(3),
  // OTP inbox over IMAP (Gmail app password). Defaults to the Blinkit OTP inbox host.
  ZEPTO_OTP_EMAIL: z.string().optional(), // defaults to ZEPTO_LOGIN_EMAIL
  ZEPTO_OTP_APP_PASSWORD: z.string().optional(),

  // ── Swiggy Instamart Ads Portal live scraping (mirrors the Blinkit block) ──
  // OTP-only login: a verification code is emailed to INSTAMART_LOGIN_EMAIL, which
  // MUST be the monitored inbox so the IMAP reader can pick it up.
  INSTAMART_BASE_URL: z.string().default("https://ozone-idp-brands-im-kba.swiggy.com/v1/accounts"),
  // PO data endpoint host (picker.swiggy.com). Different from the auth host.
  INSTAMART_API_BASE_URL: z.string().default("https://picker.swiggy.com"),
  INSTAMART_CLIENT_ID: z.string().default("f4e72b9a-5fde-4d1a-9e74-0237bcf4d67f"),
  INSTAMART_APP_VERSION: z.string().default("1.4.67"),
  INSTAMART_LOGIN_EMAIL: z.string().optional(), // OTP arrives here; must equal the monitored inbox
  INSTAMART_START_DATE: z.string().default("2026-06-01"), // backfill floor
  // OTP inbox over IMAP (Gmail app password). Falls back to BLINKIT_OTP_* / OTP_IMAP_HOST.
  INSTAMART_OTP_EMAIL: z.string().optional(), // defaults to INSTAMART_LOGIN_EMAIL
  INSTAMART_OTP_APP_PASSWORD: z.string().optional(),
  // Only ingest POs whose manufacturer/brand contains this (case-insensitive). Empty = no filter.
  INSTAMART_MANUFACTURER_FILTER: z.string().default(""),
  // ozone-idp account UUID from the JWT claims.account_ids (kept for reference).
  INSTAMART_ACCOUNT_ID: z.string().default("75a429de-dc67-44d2-b41d-608ce5e8a7f1"),
  // Internal SHA-1 hash used as brand_company_id in the searchPurchaseOrder body.
  // This is NOT the ozone-idp UUID — it's Swiggy's internal identifier for the brand.
  // Captured live from picker.swiggy.com (Moxie Beauty / Beyoutiful brand hash).
  INSTAMART_BRAND_COMPANY_ID: z.string().default("ad98bf0ad58476b2549a49c0e375d554e2dc1fac"),
  // PO grid endpoint. Defaults to the confirmed working host/path (abacus-token auth, POST).
  INSTAMART_PO_LIST_PATH: z.string().default("https://picker.swiggy.com/api/v1/searchPurchaseOrder"),
  // HTTP method for the PO-list endpoint. picker.swiggy.com/searchPurchaseOrder is POST.
  INSTAMART_PO_LIST_METHOD: z.enum(["GET", "POST"]).default("POST"),
  // POST body template (JSON). Placeholders {since} {until} {page} {pageSize} {offset}.
  // The client builds a sensible default using INSTAMART_ACCOUNT_ID; override here if
  // the server rejects the default body (paste the exact body from a fresh browser capture).
  INSTAMART_PO_LIST_BODY: z.string().optional(),
  // Cookie header — no longer required; abacus-token replaces cookie auth. Kept for
  // fallback in case a different portal host still needs it.
  INSTAMART_PORTAL_COOKIE: z.string().optional(),
  INSTAMART_PO_DETAIL_PATH: z.string().optional(),
  // Per-PO document download base path. {poId} placeholder; {fmt} = pdf|excel.
  // If unset, the client probes picker.swiggy.com/api/v1/purchaseOrderDocument/{poId}/download?format={fmt}.
  INSTAMART_PO_DOC_PATH: z.string().optional(),
  // Background auto-sync (runs while the app is up)
  INSTAMART_AUTO_SYNC: z.string().default("true"), // "false" to disable
  INSTAMART_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(3),

  // ── Nykaa seller-portal live scraping (mirrors the Zepto block) ──
  // Auth uses 2captcha (reCAPTCHA) + OTP: signIn triggers an OTP email, then
  // verifyTwoFaCode returns the token. The token is sent on data calls as the
  // `x-access-token` header (NOT Authorization Bearer) plus `x-domain`.
  // Shared 2captcha key — required for Nykaa login (its reCAPTCHA gate).
  TWOCAPTCHA_API_KEY: z.string().optional(),
  // Seller-portal backend host (auth + data). spbackend.nyk00-int.network is the
  // confirmed backend for seller.nykaa.com.
  NYKAA_BASE_URL: z.string().default("https://spbackend.nyk00-int.network"),
  NYKAA_DOMAIN: z.string().default("Beauty"), // x-domain header value
  NYKAA_LOGIN_EMAIL: z.string().optional(), // Nykaa portal account; OTP is sent for this user
  NYKAA_START_DATE: z.string().default("2026-06-01"), // backfill floor
  // reCAPTCHA sitekey + login page URL for the 2captcha solver (captured defaults).
  NYKAA_RECAPTCHA_SITEKEY: z.string().default("6LezEMUUAAAAAD5e03qpKu8apgqrINORZnxu8x_N"),
  NYKAA_LOGIN_PAGE: z.string().default("https://seller.nykaa.com/login"),
  // Fallback token from a browser-captured request when OTP/captcha login is blocked.
  NYKAA_PORTAL_TOKEN: z.string().optional(),
  // PO-listing endpoint. UNSET by default — the nykka-simulate bundle only exposed
  // the sales-report download endpoint, so the PO-grid endpoint must be captured
  // from seller.nykaa.com (Copy as cURL). May be a FULL URL. Supports {since}
  // {until} {page} {pageSize} placeholders.
  NYKAA_PO_LIST_PATH: z.string().optional(),
  NYKAA_PO_LIST_METHOD: z.enum(["GET", "POST"]).default("GET"),
  // POST body template (JSON). Placeholders {since} {until} {page} {pageSize} {offset}.
  NYKAA_PO_LIST_BODY: z.string().optional(),
  NYKAA_PORTAL_COOKIE: z.string().optional(), // optional raw Cookie header
  NYKAA_PO_DETAIL_PATH: z.string().optional(), // optional per-PO line-items endpoint (use {poId})
  // Background auto-sync — DISABLED by default until NYKAA_PO_LIST_PATH is captured.
  NYKAA_AUTO_SYNC: z.string().default("false"),
  NYKAA_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(3),
  // OTP inbox over IMAP (Gmail app password). Defaults to OTP_IMAP_HOST.
  NYKAA_OTP_EMAIL: z.string().optional(), // defaults to NYKAA_LOGIN_EMAIL
  NYKAA_OTP_APP_PASSWORD: z.string().optional(),

  // ── Tira (Reliance Retail SRM portal — srm-rrscm.ril.com) ──────────────────
  // Auth: Bearer JWT + MYSAPSSO2 cookie. JWT expires every 1 hour.
  // Fast path: capture both from the browser network tab after logging in manually.
  TIRA_PORTAL_TOKEN: z.string().optional(), // Bearer JWT from Authorization header
  TIRA_PORTAL_COOKIE: z.string().optional(), // Full Cookie header (MYSAPSSO2=... + BIGip... + TS...)
  // Auto-login credentials (when TIRA_PORTAL_TOKEN is not set)
  TIRA_USER_ID: z.string().optional(), // e.g. RR88051402
  TIRA_PASSWORD: z.string().optional(), // portal password
  // Override the login endpoint if auto-login fails (default: /srm/api/auth/login)
  TIRA_LOGIN_PATH: z.string().optional(),
  // PO list: action header value for the /srm/po-data/api/v1/master endpoint.
  // Confirmed: READ_ALL_PO_VIEW_AND_EXCEL_CONFIG (returns PO list + column config).
  TIRA_PO_LIST_ACTION: z.string().optional(),
  // POST body template (JSON). Placeholders: {since} {until} {page} {pageSize}.
  TIRA_PO_LIST_BODY: z.string().optional(),
  // Line-items endpoint (/purchase-order/items).
  // Body template with {poId} placeholder. If unset, defaults to {purchaseOrderId: poId}.
  // Capture the Payload tab from DevTools to confirm the exact field name.
  TIRA_PO_ITEMS_BODY: z.string().optional(),
  // Print/PDF endpoint (/purchase-orders/print).
  // Body template with {poId} placeholder. If unset, defaults to {purchaseOrders: [poId]}.
  TIRA_PO_PRINT_BODY: z.string().optional(),
  TIRA_START_DATE: z.string().default("2026-06-01"),
  // Background auto-sync — disabled by default until TIRA_PO_LIST_ACTION is confirmed.
  TIRA_AUTO_SYNC: z.string().default("false"),
  TIRA_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(6),

  // Test PO email (Gmail SMTP, FROM amritya@moxiebeauty.in)
  PO_TEST_EMAIL_SMTP_USER: z.string().default("amritya@moxiebeauty.in"),
  PO_TEST_EMAIL_SMTP_PASS: z.string().optional(), // Gmail app password (strip spaces)
  PO_TEST_EMAIL_TO: z.string().default("abhishek@moxiebeauty.in"),

  // PO allocation email reference number (subject: `${PO_EMAIL_REF_PREFIX}${n}`)
  PO_EMAIL_REF_PREFIX: z.string().default("MB - 26/27 - "),
  PO_EMAIL_REF_START: z.coerce.number().int().positive().default(1457),

  // Company
  COMPANY_NAME: z.string().default("Moxie Beauty Pvt Ltd"),
  COMPANY_GSTIN: z.string().default("29ABCDE1234F1Z5"),
  COMPANY_ADDRESS: z.string().default("Bengaluru, Karnataka, India"),
  COMPANY_BANK_ACCOUNT_NAME: z.string().default("Moxie Beauty Pvt Ltd"),
  COMPANY_BANK_ACCOUNT_NO: z.string().default("000000000000"),
  COMPANY_BANK_IFSC: z.string().default("HDFC0000000"),
  COMPANY_BANK_NAME: z.string().default("HDFC Bank"),

  // WMS (Benchmark Computer Solutions / myrgl.com)
  // For live access remove "uat" from the base URL per WMS doc.
  WMS_BASE_URL: z.string().default("https://wms-uat-api.myrgl.com"),
  // Portal API behind wms.myrgl.com — used for stock reports (no external report API exists)
  WMS_PORTAL_BASE_URL: z.string().default("https://wms-api.myrgl.com"),
  WMS_EMAIL: z.string().optional(),
  WMS_PASSWORD: z.string().optional(),
  // Warehouse stock rows older than this trigger a re-sync on read
  WMS_STOCK_STALE_MINUTES: z.coerce.number().default(15),
  // Background WMS stock auto-sync (mirrors the channel auto-syncs)
  WMS_AUTO_SYNC: z.string().default("true"), // "false" to disable
  WMS_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(3),
  // Manual overrides for the Outward LOI Report (auto-discovered by name if not set)
  WMS_OUTWARD_REPORT_ID: z.coerce.number().optional(),
  WMS_OUTWARD_REPORT_SP: z.string().optional(),
  // JSON array: [{"code":"W21","name":"Bhiwandi","sheetRange":"W21!A2:D"},...]
  WMS_WAREHOUSES: z.string().optional(),
  // WMS party codes per channel name: {"Blinkit":"25725800003702976","Zepto":"..."}
  WMS_PARTY_CODES: z.string().optional(),
  WMS_DEFAULT_PARTY_CODE: z.string().optional(),

  // Gemini AI — used as last-resort fallback in the SKU item mapper when a Blinkit
  // item ID has no entry in SkuMaster.blinkitCode. Model: gemini-2.0-flash (default).
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),

  // Cron
  CRON_SECRET: z.string().optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

function buildEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`❌ Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const env = buildEnv();

/** Asserts a set of env keys are present before using an integration. */
export function requireEnv<K extends keyof typeof env>(
  integration: string,
  keys: K[],
): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `[${integration}] missing required env: ${missing.join(", ")}. ` +
        `Add them to .env.local to enable this integration.`,
    );
  }
}
