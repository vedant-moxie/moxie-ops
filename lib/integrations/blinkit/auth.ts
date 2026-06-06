import "server-only";
import { prisma } from "@/lib/db";
import { env, requireEnv } from "@/lib/env";
import { waitForOtp } from "@/lib/integrations/gmail";
import { waitForOtpImap } from "@/lib/integrations/blinkit/otp-imap";

const PROVIDER = "blinkit";

export interface BlinkitTokens {
  accessToken: string;
  refreshToken: string;
  user?: unknown;
  /** Derived from the login response (or env override) — used for x-entity-* headers. */
  entityId?: string;
  entityType?: string;
}

/** Best-effort dig the entity id / type out of the verify_otp `user` payload. */
function deriveEntity(user: unknown): { entityId?: string; entityType?: string } {
  if (typeof user !== "object" || user === null) return {};
  const u = user as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

  // Direct fields
  let entityId = str(u.entity_id) ?? str(u.entityId) ?? str(u.org_id) ?? str(u.manufacturer_id);
  let entityType = str(u.entity_type) ?? str(u.entityType) ?? str(u.type) ?? str(u.role);

  // Nested under entity / entities[0] / org
  const nestedCandidates = [u.entity, u.org, u.organisation, u.organization,
    Array.isArray(u.entities) ? u.entities[0] : undefined,
    Array.isArray(u.orgs) ? u.orgs[0] : undefined];
  for (const c of nestedCandidates) {
    if (typeof c === "object" && c !== null) {
      const cc = c as Record<string, unknown>;
      entityId ??= str(cc.id) ?? str(cc.entity_id) ?? str(cc.entityId);
      entityType ??= str(cc.type) ?? str(cc.entity_type) ?? str(cc.entityType) ?? str(cc.role);
    }
  }
  return { entityId, entityType };
}

export class BlinkitAuthError extends Error {}

function publicHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    app_client: "partnersbiz-web",
    "content-type": "application/x-www-form-urlencoded",
    origin: env.BLINKIT_BASE_URL,
    referer: `${env.BLINKIT_BASE_URL}/`,
    service: "partnersbiz",
    "user-agent": "Mozilla/5.0 (compatible; moxie-ops/1.0)",
  };
  if (env.BLINKIT_API_KEY) h["x-api-key"] = env.BLINKIT_API_KEY;
  return h;
}

async function loadCached(): Promise<BlinkitTokens | null> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  const data = (row.data as Record<string, unknown> | null) ?? {};
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken ?? "",
    user: data.user,
    entityId: typeof data.entityId === "string" ? data.entityId : undefined,
    entityType: typeof data.entityType === "string" ? data.entityType : undefined,
  };
}

async function save(tokens: BlinkitTokens): Promise<void> {
  const data = {
    user: tokens.user ?? null,
    entityId: tokens.entityId ?? null,
    entityType: tokens.entityType ?? null,
  };
  await prisma.integrationToken.upsert({
    where: { provider: PROVIDER },
    create: {
      provider: PROVIDER,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || null,
      data,
    },
    update: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || null,
      data,
    },
  });
}

/** Return cached tokens unless forcing a refresh; otherwise run the OTP login. */
export async function getTokens(forceRefresh = false): Promise<BlinkitTokens> {
  if (!forceRefresh) {
    const cached = await loadCached();
    if (cached?.accessToken) return cached;
  }
  return login();
}

/**
 * Return cached tokens only — never trigger an OTP login.
 * Use this for non-interactive background operations (e.g. doc downloads during allocate)
 * where a slow OTP flow would block the HTTP response.
 */
export async function getTokensIfCached(): Promise<BlinkitTokens | null> {
  return loadCached();
}

/** Full OTP login: send → read code from inbox → verify → persist. No API key required. */
export async function login(): Promise<BlinkitTokens> {
  requireEnv("blinkit", ["BLINKIT_LOGIN_EMAIL"]);
  const email = env.BLINKIT_LOGIN_EMAIL!;
  const sentAt = new Date();

  await sendOtp(email);

  // Prefer IMAP app-password reading; fall back to Gmail OAuth if that's configured instead.
  let code: string;
  if (env.BLINKIT_OTP_APP_PASSWORD) {
    code = await waitForOtpImap({ sentAfter: sentAt });
  } else {
    requireEnv("blinkit(OTP)", ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]);
    code = await waitForOtp({
      query: "(from:partnersbiz.com OR subject:OTP OR subject:verification) newer_than:1h",
      sentAfter: sentAt,
    });
  }

  const tokens = await verifyOtp(email, code);
  await save(tokens);
  return tokens;
}

async function sendOtp(email: string): Promise<void> {
  const res = await fetch(`${env.BLINKIT_BASE_URL}/auth/api/v1/email/send_otp`, {
    method: "POST",
    headers: publicHeaders(),
    body: new URLSearchParams({ email_id: email }).toString(),
  });
  if (!res.ok) {
    throw new BlinkitAuthError(`send_otp failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

async function verifyOtp(email: string, code: string): Promise<BlinkitTokens> {
  const res = await fetch(`${env.BLINKIT_BASE_URL}/auth/api/v1/email/verify_otp`, {
    method: "POST",
    headers: publicHeaders(),
    body: new URLSearchParams({ email_id: email, verify_code: code }).toString(),
  });
  if (!res.ok) {
    throw new BlinkitAuthError(`verify_otp failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.success || !data.access_token) {
    throw new BlinkitAuthError(`verify_otp returned no tokens: keys=${Object.keys(data).join(",")}`);
  }
  // Log the shape (not the values) so we can confirm where entity info lives.
  if (data.user && typeof data.user === "object") {
    console.log("[blinkit] login user payload keys:", Object.keys(data.user as object).join(", "));
  }
  const derived = deriveEntity(data.user);
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : "",
    user: data.user,
    // env override wins, else what we dug out of the login response
    entityId: env.BLINKIT_ENTITY_ID || derived.entityId,
    entityType: env.BLINKIT_ENTITY_TYPE || derived.entityType,
  };
}
