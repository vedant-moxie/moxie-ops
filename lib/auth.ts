import "server-only";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { googleAuthConfigured } from "@/lib/auth/google";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

const clerkConfigured =
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
  !!process.env.CLERK_SECRET_KEY;

export interface Actor {
  id: string;
  label: string;
  email: string | null;
  isAdmin: boolean;
}

/** Emails allowed to edit admin-gated config (e.g. the SKU master). */
function adminEmails(): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function emailIsAdmin(email: string | null): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

/**
 * Resolve the current actor for API routes / server components.
 * Provider precedence: Google OAuth (signed session cookie) → Clerk → demo.
 * When no provider is configured (local/demo), return a stub treated as admin so
 * the app stays usable.
 */
export async function currentActor(): Promise<Actor> {
  // Google OAuth: identity comes from the MOXIE_SECRET_KEY-signed session cookie.
  if (googleAuthConfigured()) {
    const jar = await cookies();
    const session = verifySession(jar.get(SESSION_COOKIE)?.value);
    if (!session) throw new Error("Unauthorized");
    return {
      id: session.sub,
      label: session.name || session.email,
      email: session.email,
      isAdmin: emailIsAdmin(session.email),
    };
  }

  if (!clerkConfigured) {
    // Demo/local boot has no real identity — allow edits for convenience.
    return { id: "demo-user", label: "Ops (demo)", email: null, isAdmin: true };
  }
  const { auth, currentUser } = await import("@clerk/nextjs/server");
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const label = user?.fullName || email || userId;
  return { id: userId, label, email, isAdmin: emailIsAdmin(email) };
}

/** Guard for API routes: throws if not signed in (no-op in demo mode). */
export async function requireAuth(): Promise<string> {
  const actor = await currentActor();
  return actor.id;
}

/** True when the current actor may edit admin-gated config. */
export async function isAdmin(): Promise<boolean> {
  return (await currentActor()).isAdmin;
}

/** Guard for admin-only mutations. Throws AdminRequiredError when not allowed. */
export class AdminRequiredError extends Error {
  constructor() {
    super("Admin access required");
    this.name = "AdminRequiredError";
  }
}
export async function requireAdmin(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor.isAdmin) throw new AdminRequiredError();
  return actor;
}

export { clerkConfigured };
