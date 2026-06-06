import "server-only";

/**
 * Shared token-refresh utilities for self-healing channel doc downloads.
 *
 * The allocate hot path normally uses cached channel tokens (fast, no OTP). When a
 * cached token has lapsed the download fails with HTTP 401 / "auth expired". These
 * helpers let the doc-download layer mint a fresh token ONCE (OTP login via IMAP),
 * persist it, and retry — without a manual re-sync — while keeping the path bounded
 * (≤ refresh timeout) and never firing more than one concurrent login per channel.
 */

/** Default ceiling for an OTP refresh-and-retry (OTP email read can take ~10-30s). */
export const REFRESH_TIMEOUT_MS = 60_000;

/** Reject after `ms` if `p` hasn't settled. The underlying promise keeps running. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Dedupe concurrent refreshes per channel: if several POs hit 401 at once (or two
// allocate requests overlap) we run a single OTP login and share its result rather
// than triggering a storm of logins.
const inflightRefresh = new Map<string, Promise<unknown>>();

/**
 * Mint a fresh token for `channel` via `refresh` (the channel's forced OTP login),
 * deduped across concurrent callers and bounded by `timeoutMs`. The login persists
 * the token itself; this just returns it for an immediate retry.
 */
export function refreshTokenOnce<T>(
  channel: string,
  refresh: () => Promise<T>,
  timeoutMs: number = REFRESH_TIMEOUT_MS,
): Promise<T> {
  const existing = inflightRefresh.get(channel) as Promise<T> | undefined;
  if (existing) return existing;

  const p = withTimeout(refresh(), timeoutMs, `${channel} token refresh timed out after ${timeoutMs}ms`).finally(
    () => {
      // Only clear if we're still the registered in-flight promise.
      if (inflightRefresh.get(channel) === (p as Promise<unknown>)) inflightRefresh.delete(channel);
    },
  );
  inflightRefresh.set(channel, p as Promise<unknown>);
  return p;
}

/** True when an error looks like an expired/invalid auth (instance check or 401/403 text). */
export function looksLikeAuthError(err: unknown, ...authErrorTypes: Array<new (...a: never[]) => Error>): boolean {
  for (const Type of authErrorTypes) {
    if (err instanceof Type) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b40[13]\b/.test(msg) || /auth\s*expired|token\s*expired|unauthor/i.test(msg);
}

/**
 * Decode a JWT's `exp` claim (seconds → ms). Returns null when the string is not a
 * JWT, has no `exp`, or can't be parsed — callers treat null as "can't tell".
 */
export function jwtExpiryMs(token: string | undefined | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
    const exp = payload.exp;
    if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000;
    return null;
  } catch {
    return null;
  }
}

/**
 * True when `token` is a JWT whose `exp` is within `withinMs` of now (or already
 * past). Returns false for non-JWT / unparseable tokens so the caller stays
 * conservative and only refreshes when it can prove the token is near expiry.
 */
export function isJwtNearExpiry(token: string | undefined | null, withinMs: number): boolean {
  const expMs = jwtExpiryMs(token);
  if (expMs === null) return false;
  return expMs - Date.now() <= withinMs;
}

/** Default window for proactive keep-warm: refresh once a JWT is within 45 min of expiry. */
export const KEEP_WARM_WINDOW_MS = 45 * 60_000;

export type KeepWarmResult = "refreshed" | "fresh" | "no-token" | "unknown" | "error";

/**
 * Proactively keep a channel token warm when the background auto-sync SKIPS its data
 * pull (data already fresh). If the cached token is a JWT within `withinMs` of expiry
 * we mint a fresh one now — so the allocate hot path rarely hits the 401 self-heal.
 *
 * Conservative by design: tokens we can't decode (non-JWT, no `exp`) are left alone
 * ("unknown") and rely on the refresh-on-401 path in po-documents. Bounded + deduped
 * via {@link refreshTokenOnce}; never throws.
 */
export async function keepChannelTokenWarm(opts: {
  channel: string;
  getCached: () => Promise<{ accessToken: string } | null>;
  refresh: () => Promise<unknown>;
  withinMs?: number;
}): Promise<KeepWarmResult> {
  const withinMs = opts.withinMs ?? KEEP_WARM_WINDOW_MS;
  let cached: { accessToken: string } | null;
  try {
    cached = await opts.getCached();
  } catch {
    return "error";
  }
  if (!cached?.accessToken) return "no-token";

  if (jwtExpiryMs(cached.accessToken) === null) return "unknown";
  if (!isJwtNearExpiry(cached.accessToken, withinMs)) return "fresh";

  try {
    await refreshTokenOnce(opts.channel, opts.refresh);
    console.log(`[token-warm] ${opts.channel}: token near expiry — refreshed proactively`);
    return "refreshed";
  } catch (err) {
    console.warn(`[token-warm] ${opts.channel}: proactive refresh failed: ${err instanceof Error ? err.message : err}`);
    return "error";
  }
}
