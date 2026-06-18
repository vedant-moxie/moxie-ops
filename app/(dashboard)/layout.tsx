import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { getNavCounts } from "@/lib/data/queries";
import { currentActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let counts = { pendingPos: 0, openDiscrepancies: 0 };
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
