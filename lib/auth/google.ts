import "server-only";
import { env } from "@/lib/env";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export interface GoogleUser {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

/** True when every var needed for the Google sign-in flow is present. */
export function googleAuthConfigured(): boolean {
  return !!(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_REDIRECT_URI &&
    env.MOXIE_SECRET_KEY
  );
}

function allowedDomains(): string[] {
  return (env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** True when this email is permitted to sign in (empty allowlist = open). */
export function emailAllowed(email: string): boolean {
  const domains = allowedDomains();
  if (domains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && domains.includes(domain);
}

/** Build Google's consent-screen URL for a given CSRF state token. */
export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  // Single-domain hint for a cleaner account picker (UX only, not a security control).
  const domains = allowedDomains();
  if (domains.length === 1 && domains[0]) params.set("hd", domains[0]);
  return `${AUTH_URL}?${params.toString()}`;
}

/** Exchange an auth code for the signed-in Google user's profile. */
export async function exchangeCodeForUser(code: string): Promise<GoogleUser> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error("Google token exchange returned no access_token");

  const userRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Google userinfo failed: ${userRes.status}`);
  const u = (await userRes.json()) as {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  return {
    sub: u.sub,
    email: u.email,
    emailVerified: u.email_verified ?? false,
    name: u.name || u.email,
    picture: u.picture,
  };
}
