import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { env, requireEnv } from "@/lib/env";
import { waitForOtpImap } from "@/lib/integrations/instamart/otp-imap";

const PROVIDER = "instamart";

export interface InstamartTokens {
  accessToken: string;
  refreshToken: string;
  /** Raw signInWithOTP payload (kept for debugging / future entity needs). */
  user?: unknown;
}

export class InstamartAuthError extends Error {}

/**
 * Headers the Swiggy IDP expects (ported from the reference main.js). The IDP is
 * a public endpoint — no auth header until we exchange the OTP. A fresh
 * x-client-request-id / x-timestamp is minted per request.
 */
function idpHeaders(): Record<string, string> {
  return {
    accept: "*/*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    app_version: env.INSTAMART_APP_VERSION,
    "content-type": "application/json",
    origin: "https://partner.swiggy.com",
    priority: "u=1, i",
    referer: "https://partner.swiggy.com/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "x-client-request-id": randomUUID(),
    "x-timestamp": Date.now().toString(),
  };
}

async function loadCached(): Promise<InstamartTokens | null> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  const data = (row.data as Record<string, unknown> | null) ?? {};
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken ?? "",
    user: data.user,
  };
}

async function save(tokens: InstamartTokens): Promise<void> {
  const data = { user: tokens.user ?? null };
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
export async function getTokens(forceRefresh = false): Promise<InstamartTokens> {
  if (!forceRefresh) {
    const cached = await loadCached();
    if (cached?.accessToken) return cached;
  }
  return login();
}

/** Full OTP login: send code → read it from the inbox over IMAP → verify → persist. */
export async function login(): Promise<InstamartTokens> {
  requireEnv("instamart", ["INSTAMART_LOGIN_EMAIL"]);
  const email = env.INSTAMART_LOGIN_EMAIL!;
  const sentAt = new Date();

  const { userId, sessionInfo } = await sendVerificationCode(email);
  const code = await waitForOtpImap({ sentAfter: sentAt });
  const tokens = await signInWithOtp({ otp: code, userId, sessionInfo });
  await save(tokens);
  return tokens;
}

/** POST /sendVerificationCode → { user_id, session_info }. */
async function sendVerificationCode(email: string): Promise<{ userId: string; sessionInfo: string }> {
  const res = await fetch(`${env.INSTAMART_BASE_URL}/sendVerificationCode`, {
    method: "POST",
    headers: idpHeaders(),
    body: JSON.stringify({ email, client_id: env.INSTAMART_CLIENT_ID }),
  });
  if (!res.ok) {
    throw new InstamartAuthError(`sendVerificationCode failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.user_id || !data.session_info) {
    throw new InstamartAuthError(`sendVerificationCode returned no session: keys=${Object.keys(data).join(",")}`);
  }
  return { userId: String(data.user_id), sessionInfo: String(data.session_info) };
}

/** POST /signInWithOTP → { access_token, refresh_token }. */
async function signInWithOtp(opts: { otp: string; userId: string; sessionInfo: string }): Promise<InstamartTokens> {
  const res = await fetch(`${env.INSTAMART_BASE_URL}/signInWithOTP`, {
    method: "POST",
    headers: idpHeaders(),
    body: JSON.stringify({
      otp: opts.otp,
      user_id: opts.userId,
      session_info: opts.sessionInfo,
      client_id: env.INSTAMART_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new InstamartAuthError(`signInWithOTP failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.access_token) {
    throw new InstamartAuthError(`signInWithOTP returned no tokens: keys=${Object.keys(data).join(",")}`);
  }
  if (data.user && typeof data.user === "object") {
    console.log("[instamart] login user payload keys:", Object.keys(data.user as object).join(", "));
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : "",
    user: data.user,
  };
}
