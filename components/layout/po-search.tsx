"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

type PoResult = {
  id: string;
  channelPoNumber: string | null;
  status: string;
  channel: { name: string; logoColor: string };
};

const STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: "Review",
  APPROVED: "Approved",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  PENDING_GRN: "Pending GRN",
};

export function PoSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PoResult[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const fetchResults = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    try {
      const res = await fetch(`/api/pos/search?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (json.success) {
        setResults(json.data);
        setOpen(json.data.length > 0);
        setSelected(0);
      }
    } catch {
      // silently ignore network errors
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchResults(val), 250);
  };

  const navigate = (po: PoResult) => {
    router.push(`/orders/${po.id}`);
    setOpen(false);
    setQuery("");
    setResults([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[selected]) navigate(results[selected]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Close on outside click
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  return (
    <div ref={wrapperRef} className="relative hidden md:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Search POs, SKUs…"
        autoComplete="off"
        className="h-10 w-56 rounded-full border border-input bg-card pl-9 pr-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No PO found</p>
          ) : (
            <ul>
              {results.map((po, i) => (
                <li key={po.id}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors ${
                      i === selected ? "bg-accent" : "hover:bg-accent/60"
                    }`}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => navigate(po)}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold uppercase text-white"
                      style={{ background: po.channel.logoColor }}
                    >
                      {po.channel.name.slice(0, 2)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {po.channelPoNumber ?? po.id}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      {STATUS_LABEL[po.status] ?? po.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
