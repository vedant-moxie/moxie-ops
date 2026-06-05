import "server-only";
import { prisma } from "@/lib/db";
import { env, requireEnv } from "@/lib/env";
import { waitForZeptoOtpImap } from "@/lib/integrations/zepto/otp-imap";

const PROVIDER = "zepto";

export interface ZeptoTokens {
  /** The Bearer JWT used for all authenticated Zepto API calls. */
  accessToken: string;
  tokenType: string; // "Bearer"
  userId?: string;
  user?: unknown; // full validate-mfa-otp response (for diagnostics / later mapping)
}

export class ZeptoAuthError extends Error {}

/** Common headers the partner portal sends (ported from zepto-auth.js). */
function commonHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9,hi;q=0.8",
    "content-type": "application/json",
    origin: "https://partner.zepto.co.in",
    referer: "https://partner.zepto.co.in/",
    "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** sign-in / validate responses may nest the payload under data/result. */
function peel(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  for (const k of ["data", "result"]) {
    const nested = payload[k];
    if (isRecord(nested)) return { ...payload, ...nested };
  }
  return payload;
}

async function loadCached(): Promise<ZeptoTokens | null> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  const data = (row.data as Record<string, unknown> | null) ?? {};
  return {
    accessToken: row.accessToken,
    tokenType: typeof data.tokenType === "string" ? data.tokenType : "Bearer",
    userId: typeof data.userId === "string" ? data.userId : undefined,
    user: data.user,
  };
}

async function save(tokens: ZeptoTokens): Promise<void> {
  const data = {
    tokenType: tokens.tokenType ?? "Bearer",
    userId: tokens.userId ?? null,
    user: tokens.user ?? null,
  };
  await prisma.integrationToken.upsert({
    where: { provider: PROVIDER },
    create: { provider: PROVIDER, accessToken: tokens.accessToken, data },
    update: { accessToken: tokens.accessToken, data },
  });
}

/** Return cached tokens unless forcing a refresh; otherwise run the OTP login. */
export async function getTokens(forceRefresh = false): Promise<ZeptoTokens> {
  if (!forceRefresh) {
    const cached = await loadCached();
    if (cached?.accessToken) return cached;
  }
  return login();
}

/** Full MFA login: sign-in → read 4-digit OTP from inbox → validate → persist. */
export async function login(): Promise<ZeptoTokens> {
  requireEnv("zepto", ["ZEPTO_LOGIN_EMAIL", "ZEPTO_PASSWORD"]);
  const sentAt = new Date();

  const mfaId = await signIn(env.ZEPTO_LOGIN_EMAIL!, env.ZEPTO_PASSWORD!);

  // OTP arrives by email (from mailer@zeptonow.com, subject "Email Otp"); read it over IMAP.
  const code = await waitForZeptoOtpImap({ sentAfter: sentAt });

  const tokens = await validateOtp(mfaId, code);
  await save(tokens);
  return tokens;
}

/**
 * Detect the "access not approved" rejection (HTTP 400, code 1003) the Zepto
 * partner portal returns for accounts that exist but haven't been granted
 * application access yet, and surface a clear, actionable message.
 */
function detectAccessRejection(email: string, status: number, body: string): ZeptoAuthError | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* non-JSON body — fall back to substring sniffing below */
  }
  const code = isRecord(parsed) ? parsed.code ?? parsed.errorCode ?? parsed.statusCode : undefined;
  const isCode1003 = String(code) === "1003";
  const looksNotApproved = /not\s+(yet\s+)?approved/i.test(body);
  if (status === 400 && (isCode1003 || looksNotApproved)) {
    return new ZeptoAuthError(
      `Zepto login rejected: account ${email} is not approved for this application (code 1003). ` +
        `Approve it on the Zepto partner portal, then retry.`,
    );
  }
  return null;
}

/** POST /api/v1/auth/sign-in?applicationId=… {email,password} → mfaId. */
async function signIn(email: string, password: string): Promise<string> {
  const url = `${env.ZEPTO_BASE_URL}/api/v1/auth/sign-in?applicationId=${env.ZEPTO_APPLICATION_ID}`;
  const res = await fetch(url, {
    method: "POST",
    headers: commonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    const rejection = detectAccessRejection(email, res.status, text);
    if (rejection) throw rejection;
    throw new ZeptoAuthError(`Zepto sign-in failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = peel(JSON.parse(text));
  } catch {
    throw new ZeptoAuthError(`Zepto sign-in returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const mfaId = str(data.mfaId);
  if (!mfaId) {
    throw new ZeptoAuthError(`Zepto sign-in returned no mfaId: keys=${Object.keys(data).join(",")}`);
  }
  return mfaId;
}

/** POST /api/v1/auth/validate-mfa-otp/ {otp,mfaId,applicationId} → {jwtToken,…}. */
async function validateOtp(mfaId: string, otp: string): Promise<ZeptoTokens> {
  const res = await fetch(`${env.ZEPTO_BASE_URL}/api/v1/auth/validate-mfa-otp/`, {
    method: "POST",
    headers: commonHeaders(),
    body: JSON.stringify({ otp, mfaId, applicationId: env.ZEPTO_APPLICATION_ID }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ZeptoAuthError(`validate-mfa-otp failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = peel(JSON.parse(text));
  } catch {
    throw new ZeptoAuthError(`validate-mfa-otp returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const jwtToken = str(data.jwtToken) ?? str(data.token) ?? str(data.accessToken);
  if (!jwtToken) {
    throw new ZeptoAuthError(`validate-mfa-otp returned no jwtToken: keys=${Object.keys(data).join(",")}`);
  }
  console.log("[zepto] login ok; response keys:", Object.keys(data).join(", "));
  return {
    accessToken: jwtToken,
    tokenType: str(data.tokenType) ?? "Bearer",
    userId: str(data.userId),
    user: data,
  };
}
