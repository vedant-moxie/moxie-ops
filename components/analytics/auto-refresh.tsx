"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Keeps the (server-rendered, force-dynamic) Analytics page in sync: re-runs the
 * server component on an interval via router.refresh(), plus a manual button.
 */
export function AnalyticsAutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [spinning, setSpinning] = useState(false);

  const refresh = useCallback(() => {
    setSpinning(true);
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  // Stop the spinner shortly after the server round-trip settles.
  useEffect(() => {
    if (isPending || !spinning) return;
    const t = setTimeout(() => setSpinning(false), 300);
    return () => clearTimeout(t);
  }, [isPending, spinning]);

  const busy = spinning || isPending;
  return (
    <button
      type="button"
      onClick={refresh}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  );
}
