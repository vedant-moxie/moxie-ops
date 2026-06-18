"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { Logo } from "./logo";
import { NAV_ITEMS, SETTINGS_ITEM, type NavItem } from "./nav-config";
import { cn } from "@/lib/utils";

interface SidebarProps {
  counts: { pendingPos: number; openDiscrepancies: number };
  user: { label: string; email?: string };
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

function NavLink({
  item,
  active,
  count,
}: {
  item: NavItem;
  active: boolean;
  count?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all",
        active
          ? "bg-sidebar-accent text-[hsl(40_18%_10%)] shadow-soft"
          : "text-sidebar-foreground/80 hover:bg-white/5 hover:text-sidebar-foreground",
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2.4 : 2} />
      <span className="flex-1">{item.label}</span>
      {count != null && count > 0 && (
        <span
          className={cn(
            "grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-bold nums",
            active
              ? "bg-[hsl(40_18%_10%)] text-sidebar-accent"
              : "bg-white/10 text-sidebar-foreground",
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

export function Sidebar({ counts, user }: SidebarProps) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col bg-sidebar px-4 py-6 lg:flex">
      <div className="px-2">
        <Logo variant="light" />
      </div>

      <nav className="mt-8 flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
            count={item.badgeKey ? counts[item.badgeKey] : undefined}
          />
        ))}
        <div className="my-3 h-px bg-white/10" />
        <NavLink
          item={SETTINGS_ITEM}
          active={isActive(pathname, SETTINGS_ITEM.href)}
        />
      </nav>

      <div className="mt-4 flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sidebar-accent text-sm font-bold text-[hsl(40_18%_10%)]">
          {user.label.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium text-sidebar-foreground">
            {user.label}
          </div>
          {user.email && (
            <div className="truncate text-xs text-sidebar-muted">{user.email}</div>
          )}
        </div>
        {user.email && (
          <a
            href="/auth/logout"
            title="Sign out"
            aria-label="Sign out"
            className="shrink-0 rounded-lg p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-white/10 hover:text-sidebar-foreground"
          >
            <LogOut className="h-4 w-4" />
          </a>
        )}
      </div>
    </aside>
  );
}
