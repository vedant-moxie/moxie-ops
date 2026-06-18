import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { googleAuthConfigured, buildGoogleAuthUrl } from "@/lib/auth/google";

export const dynamic = "force-dynamic";

/** Start the Google OAuth flow: set a CSRF state cookie, redirect to consent. */
export async function GET(req: Request) {
  if (!googleAuthConfigured()) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildGoogleAuthUrl(state));
  res.cookies.set("g_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
