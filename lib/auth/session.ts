import "server-only";
import crypto from "node:crypto";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "moxie_session";
const SESSION_TTL_MS = 7 * 24 * 3_600_000; // 7 days
export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);

export interface SessionPayload {
  sub: string; // Google account id
  email: string;
  name: string;
  picture?: string;
  exp: number; // epoch ms
}

function key(): string {
  const k = env.MOXIE_SECRET_KEY;
  if (!k) throw new Error("MOXIE_SECRET_KEY is not set");
  return k;
}

function hmac(data: string): string {
  return crypto.createHmac("sha256", key()).update(data).digest("base64url");
}

/** Sign a session payload into a `<body>.<sig>` token. */
export function signSession(p: Omit<SessionPayload, "exp"> & { exp?: number }): string {
  const payload: SessionPayload = { ...p, exp: p.exp ?? Date.now() + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** Verify a token's signature + expiry. Returns the payload or null. */
export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
