import "server-only";
import { prisma } from "@/lib/db";
import { env, requireEnv } from "@/lib/env";

const PROVIDER = "tira";
const BASE = "https://srm-rrscm.ril.com";

export interface TiraTokens {
  accessToken: string;
  /** MYSAPSSO2 cookie value — required alongside the Bearer token. */
  ssoCookie: string;
}

export class TiraAuthError extends Error {}

function commonHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: BASE,
    referer: `${BASE}/purchase-order/new`,
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function loadCached(): Promise<TiraTokens | null> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  const data = (row.data as Record<string, unknown> | null) ?? {};
  const ssoCookie = typeof data.ssoCookie === "string" ? data.ssoCookie : "";
  return { accessToken: row.accessToken, ssoCookie };
}

async function save(tokens: TiraTokens): Promise<void> {
  await prisma.integrationToken.upsert({
    where: { provider: PROVIDER },
    create: { provider: PROVIDER, accessToken: tokens.accessToken, data: { ssoCookie: tokens.ssoCookie } },
    update: { accessToken: tokens.accessToken, data: { ssoCookie: tokens.ssoCookie } },
  });
}

/**
 * Return tokens. Priority:
 * 1. Cached DB token (unless forceRefresh).
 * 2. TIRA_PORTAL_TOKEN + TIRA_PORTAL_COOKIE env vars (browser-captured fast path).
 * 3. Auto-login with TIRA_USER_ID + TIRA_PASSWORD.
 *
 * NOTE: The Tira JWT expires in 1 hour. The client detects 401 and calls
 * getTokens(forceRefresh=true) to re-login automatically.
 */
export async function getTokens(forceRefresh = false): Promise<TiraTokens> {
  if (!forceRefresh) {
    const cached = await loadCached();
    if (cached?.accessToken) return cached;
  }
  // Fast path: browser-captured token (token + cookie both required).
  if (env.TIRA_PORTAL_TOKEN) {
    const tokens: TiraTokens = {
      accessToken: env.TIRA_PORTAL_TOKEN,
      ssoCookie: env.TIRA_PORTAL_COOKIE ?? "",
    };
    await save(tokens);
    return tokens;
  }
  return login();
}

export async function getTokensIfCached(): Promise<TiraTokens | null> {
  return loadCached();
}

/**
 * Auto-login: POST user/password → get JWT + MYSAPSSO2.
 *
 * The Tira SRM portal (srm-rrscm.ril.com) uses a custom SAP Spring-Security
 * auth service. The login endpoint was reverse-engineered from the portal's
 * network calls. If the endpoint changes, update TIRA_LOGIN_PATH.
 */
export async function login(): Promise<TiraTokens> {
  requireEnv("tira", ["TIRA_USER_ID", "TIRA_PASSWORD"]);
  const loginPath = env.TIRA_LOGIN_PATH ?? `${BASE}/srm/api/auth/login`;

  const res = await fetch(loginPath, {
    method: "POST",
    headers: { ...commonHeaders() },
    body: JSON.stringify({ userId: env.TIRA_USER_ID, password: env.TIRA_PASSWORD }),
    redirect: "manual",
  });

  const text = await res.text();
  const status = res.status;

  // Some SAP SRM portals return the JWT in the response body; others return it
  // in a header alongside the MYSAPSSO2 Set-Cookie.
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const ssoCookieHeader = setCookie.find((c) => c.startsWith("MYSAPSSO2="));
  const ssoCookie = ssoCookieHeader?.split(";")[0]?.replace("MYSAPSSO2=", "") ?? "";

  let jwt: string | undefined;
  try {
    const data = JSON.parse(text);
    if (isRecord(data)) {
      jwt =
        (typeof data.token === "string" ? data.token : undefined) ??
        (typeof data.accessToken === "string" ? data.accessToken : undefined) ??
        (typeof data.jwt === "string" ? data.jwt : undefined) ??
        (typeof data.jwtToken === "string" ? data.jwtToken : undefined);
    }
  } catch {
    // might be a redirect (302) — JWT comes from subsequent call
  }

  // Fallback: JWT may be in Authorization response header
  if (!jwt) {
    const authHeader = res.headers.get("authorization") ?? res.headers.get("x-auth-token");
    jwt = authHeader?.replace(/^Bearer\s+/i, "") ?? undefined;
  }

  if (!jwt) {
    throw new TiraAuthError(
      `Tira login failed (HTTP ${status}): could not extract JWT. ` +
        `Response: ${text.slice(0, 300)}. ` +
        `If auto-login is failing, capture a fresh Bearer token from the browser and set TIRA_PORTAL_TOKEN.`,
    );
  }

  console.log("[tira] login ok; sso cookie present:", !!ssoCookie);
  const tokens: TiraTokens = { accessToken: jwt, ssoCookie };
  await save(tokens);
  return tokens;
}
