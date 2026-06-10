import "server-only";
import { env } from "@/lib/env";

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
 * When Clerk is configured, enforce auth and return a readable identity + admin flag.
 * When it isn't (local/demo), return a stub treated as admin so the app stays usable.
 */
export async function currentActor(): Promise<Actor> {
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
