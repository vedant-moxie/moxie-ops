import "server-only";
import { prisma } from "@/lib/db";
import { env, requireEnv } from "@/lib/env";
import { solveNykaaCaptcha } from "@/lib/integrations/nykaa/captcha";
import { waitForNykaaOtpImap } from "@/lib/integrations/nykaa/otp-imap";

const PROVIDER = "nykaa";

export interface NykaaTokens {
  /** The token sent as `x-access-token` on all authenticated Nykaa API calls. */
  accessToken: string;
  /** Nykaa seller domain sent as `x-domain` (e.g. "Beauty"). */
  domain: string;
  refreshToken?: string;
  user?: unknown; // full verifyTwoFaCode response (diagnostics / later mapping)
}

export class NykaaAuthError extends Error {}

/** Common headers the Nykaa seller portal sends on its auth endpoints. */
function commonHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: "https://seller.nykaa.com",
    referer: "https://seller.nykaa.com/",
    "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** signIn / verify responses may nest the payload under data/result. */
function peel(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  for (const k of ["data", "result"]) {
    const nested = payload[k];
    if (isRecord(nested)) return { ...payload, ...nested };
  }
  return payload;
}

async function loadCached(): Promise<NykaaTokens | null> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  const data = (row.data as Record<string, unknown> | null) ?? {};
  return {
    accessToken: row.accessToken,
    domain: typeof data.domain === "string" ? data.domain : env.NYKAA_DOMAIN,
    refreshToken: row.refreshToken ?? undefined,
    user: data.user,
  };
}

async function save(tokens: NykaaTokens): Promise<void> {
  const data = { domain: tokens.domain ?? env.NYKAA_DOMAIN, user: tokens.user ?? null };
  await prisma.integrationToken.upsert({
    where: { provider: PROVIDER },
    create: {
      provider: PROVIDER,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || null,
      data,
    },
    update: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || null, data },
  });
}

/**
 * Return tokens for Nykaa data calls. Priority order:
 * 1. Cached DB token (unless forceRefresh)
 * 2. NYKAA_PORTAL_TOKEN env var (browser-captured token fallback)
 * 3. Full OTP login (2captcha → signIn → OTP → verifyTwoFaCode)
 */
export async function getTokens(forceRefresh = false): Promise<NykaaTokens> {
  if (!forceRefresh) {
    const cached = await loadCached();
    if (cached?.accessToken) return cached;
  }
  // Fast-path: use the pre-captured portal token when OTP login isn't available.
  if (env.NYKAA_PORTAL_TOKEN) {
    const tokens: NykaaTokens = { accessToken: env.NYKAA_PORTAL_TOKEN, domain: env.NYKAA_DOMAIN };
    if (!forceRefresh) await save(tokens);
    return tokens;
  }
  return login();
}

/**
 * Return cached tokens only — never trigger an OTP login. Use for non-interactive
 * background operations (e.g. doc downloads during allocate) where a slow OTP +
 * captcha flow would block the HTTP response.
 */
export async function getTokensIfCached(): Promise<NykaaTokens | null> {
  return loadCached();
}

/**
 * Full login (seller.nykaa.com): solve reCAPTCHA → signIn (triggers OTP email)
 * → read OTP over IMAP → solve a second reCAPTCHA → verifyTwoFaCode → persist.
 *
 * Mirrors the proven nykka-simulate login-otp flow. Nykaa requires a fresh
 * `x-recaptcha-token` on BOTH the signIn and verify calls, so we solve twice —
 * the second solve runs in parallel with the OTP wait to hide its latency.
 */
export async function login(): Promise<NykaaTokens> {
  requireEnv("nykaa", ["NYKAA_LOGIN_EMAIL"]);
  const email = env.NYKAA_LOGIN_EMAIL!;
  const sentAt = new Date();

  // 1) Solve captcha for signIn, then trigger the OTP email.
  const captcha1 = await solveNykaaCaptcha(" #1");
  const userCode = await signIn(email, captcha1);

  // 2) Read the OTP while solving the second captcha in parallel.
  const [code, captcha2] = await Promise.all([
    waitForNykaaOtpImap({ sentAfter: sentAt }),
    solveNykaaCaptcha(" #2"),
  ]);

  // 3) Verify the OTP to obtain the access token.
  const tokens = await verifyTwoFaCode(email, code, userCode, captcha2);
  await save(tokens);
  return tokens;
}

/** POST /seller-portal/api/v1/auth/signIn {email} (x-recaptcha-token) → user_code. */
async function signIn(email: string, recaptchaToken: string): Promise<string> {
  const res = await fetch(`${env.NYKAA_BASE_URL}/seller-portal/api/v1/auth/signIn`, {
    method: "POST",
    headers: { ...commonHeaders(), "x-recaptcha-token": recaptchaToken },
    body: JSON.stringify({ email }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new NykaaAuthError(`Nykaa signIn failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = peel(JSON.parse(text));
  } catch {
    throw new NykaaAuthError(`Nykaa signIn returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  // user_code is the server-side session identifier echoed back to verifyTwoFaCode.
  return str(data.user_code) ?? str(data.userCode) ?? "undefined";
}

/**
 * POST /seller-portal/api/v1/auth/verifyTwoFaCode {two_fa_code,user_code,email}
 * (x-recaptcha-token) → { data: { access_token, refresh_token, … } }.
 */
async function verifyTwoFaCode(
  email: string,
  otp: string,
  userCode: string,
  recaptchaToken: string,
): Promise<NykaaTokens> {
  const res = await fetch(`${env.NYKAA_BASE_URL}/seller-portal/api/v1/auth/verifyTwoFaCode`, {
    method: "POST",
    headers: { ...commonHeaders(), "x-recaptcha-token": recaptchaToken },
    body: JSON.stringify({ two_fa_code: otp, user_code: userCode, email }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new NykaaAuthError(`Nykaa verifyTwoFaCode failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = peel(JSON.parse(text));
  } catch {
    throw new NykaaAuthError(`verifyTwoFaCode returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const token =
    str(data.access_token) ?? str(data.token) ?? str(data.accessToken) ?? str(data.jwtToken);
  if (!token) {
    throw new NykaaAuthError(`verifyTwoFaCode returned no token: keys=${Object.keys(data).join(",")}`);
  }
  console.log("[nykaa] login ok; response keys:", Object.keys(data).join(", "));
  return {
    accessToken: token,
    domain: str(data.domain) ?? env.NYKAA_DOMAIN,
    refreshToken: str(data.refresh_token) ?? str(data.refreshToken),
    user: data,
  };
}
