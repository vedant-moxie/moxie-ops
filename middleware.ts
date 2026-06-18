import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

/**
 * Cron endpoints authenticate via CRON_SECRET (handled in-route). Auth pages and
 * the OAuth callback are public. Everything else requires a signed-in user.
 *
 * Provider precedence: Google OAuth → Clerk → no-op (local/demo boot, so the full
 * UI is browsable without any auth provider configured).
 *
 * NOTE: middleware runs on the Edge runtime, which inlines process.env at BUILD
 * time. When the OAuth vars aren't present in the build (e.g. secrets injected
 * only at runtime), `googleConfigured` is baked false and this guard no-ops — so
 * it's best-effort UX only. The authoritative gate is the Node-runtime check in
 * app/(dashboard)/layout.tsx (pages) and requireAuth() in API routes, both of
 * which read env at runtime.
 */
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/auth/(.*)",
  "/api/cron/(.*)",
]);

const googleConfigured =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_REDIRECT_URI &&
  !!process.env.MOXIE_SECRET_KEY;

const clerkConfigured =
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
  !!process.env.CLERK_SECRET_KEY;

const clerkHandler = clerkConfigured
  ? clerkMiddleware(async (auth, req) => {
      if (!isPublicRoute(req)) await auth.protect();
    })
  : null;

/**
 * Google guard: presence check only (Edge runtime has no Node crypto). The
 * signature/expiry are verified server-side in currentActor(); a forged cookie
 * passes here but fails there, so no data is exposed.
 */
function googleHandler(req: NextRequest) {
  if (isPublicRoute(req)) return NextResponse.next();
  if (req.cookies.get("moxie_session")?.value) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  return NextResponse.redirect(url);
}

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (googleConfigured) return googleHandler(req);
  if (clerkHandler) return clerkHandler(req, event);
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
