import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { getNavCounts } from "@/lib/data/queries";
import { currentActor } from "@/lib/auth";
import { googleAuthConfigured } from "@/lib/auth/google";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Authoritative auth gate (Node runtime — reads env at runtime, unlike Edge
  // middleware which inlines env at build time and is a no-op when the OAuth vars
  // aren't present in the build). Must run BEFORE the try/catch: redirect() throws
  // a control-flow signal that the catch would otherwise swallow.
  if (googleAuthConfigured()) {
    const jar = await cookies();
    if (!verifySession(jar.get(SESSION_COOKIE)?.value)) redirect("/sign-in");
  }

  let counts = { pendingPos: 0, openDiscrepancies: 0, openSoChecks: 0 };
  let user: { label: string; email?: string } = { label: "Ops" };
  try {
    [counts, user] = await Promise.all([
      getNavCounts(),
      currentActor().then((a) => ({ label: a.label, email: a.email ?? undefined })),
    ]);
  } catch {
    // DB unreachable (first boot before migrate) — render shell with zeros.
  }

  return (
    <div className="app-wash flex min-h-screen">
      <Sidebar counts={counts} user={user} />
      <div className="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">{children}</div>
      <MobileNav />
    </div>
  );
}
