import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Clear the session cookie and return to the sign-in page. */
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL("/sign-in", req.url));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
