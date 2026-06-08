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
