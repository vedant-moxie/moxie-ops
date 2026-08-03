import {
  LayoutDashboard,
  ClipboardCheck,
  ClipboardList,
  Package,
  CheckCircle2,
  Zap,
  TrendingUp,
  Settings,
  Boxes,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badgeKey?: "pendingPos" | "openDiscrepancies" | "openSoChecks";
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Channels", href: "/channels", icon: Boxes },
  { label: "Allocation", href: "/allocate", icon: ClipboardList, badgeKey: "pendingPos" },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "GRN", href: "/grn", icon: CheckCircle2, badgeKey: "openDiscrepancies" },
  { label: "Reconciliation", href: "/reconciliation", icon: Zap },
  { label: "SO Entry Check", href: "/reconciliation/so-check", icon: ClipboardCheck, badgeKey: "openSoChecks" },
  { label: "Analytics", href: "/analytics", icon: TrendingUp },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * The most specific matching nav href — so /reconciliation/so-check highlights only
 * its own item, not its /reconciliation parent as well.
 */
export function activeHref(pathname: string, items: NavItem[]): string | undefined {
  return items
    .filter((i) => isActive(pathname, i.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export const SETTINGS_ITEM: NavItem = {
  label: "Settings",
  href: "/settings",
  icon: Settings,
};
