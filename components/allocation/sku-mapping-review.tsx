"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Bot, CheckCircle2, X, ChevronDown, ChevronUp, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PendingMapping } from "@/lib/services/sku-item-mapper";

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        pct >= 75 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
          : pct >= 55 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          : "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
      )}
    >
      {pct}% match
    </span>
  );
}

interface MappingCardProps {
  mapping: PendingMapping;
  onConfirm: (skuId: string, wmsCode: string) => void;
  onDismiss: (skuId: string) => void;
  busy: boolean;
}

function MappingCard({ mapping, onConfirm, onDismiss, busy }: MappingCardProps) {
  const [showAlts, setShowAlts] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const allOptions = [
    { code: mapping.wmsCode, description: mapping.wmsDescription, confidence: mapping.confidence, primary: true },
    ...mapping.alternatives.map((a) => ({ ...a, primary: false })),
  ];

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-800/40 dark:bg-amber-950/20">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-foreground truncate">{mapping.skuName}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{mapping.channelItemId}</span>
            {mapping.uom && mapping.uom !== "unit" && <span>· {mapping.uom}</span>}
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onDismiss(mapping.skuId)}
          disabled={busy}
          title="Skip — no WMS mapping for this SKU"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Primary suggestion */}
      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">AI suggestion:</p>
        <div
          className={cn(
            "flex items-center justify-between gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors",
            chosen === mapping.wmsCode
              ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
              : "border-border bg-background hover:bg-muted/50",
          )}
          onClick={() => setChosen(chosen === mapping.wmsCode ? null : mapping.wmsCode)}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-sm font-semibold text-foreground shrink-0">{mapping.wmsCode}</span>
            <span className="text-sm text-muted-foreground truncate">{mapping.wmsDescription}</span>
          </div>
          <ConfidenceBadge value={mapping.confidence} />
        </div>

        {/* Alternatives toggle */}
        {mapping.alternatives.length > 0 && (
          <>
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAlts((v) => !v)}
            >
              {showAlts ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showAlts ? "Hide" : "Show"} {mapping.alternatives.length} alternative{mapping.alternatives.length > 1 ? "s" : ""}
            </button>
            {showAlts && mapping.alternatives.map((alt) => (
              <div
                key={alt.code}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors",
                  chosen === alt.code
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                    : "border-border bg-background hover:bg-muted/50",
                )}
                onClick={() => setChosen(chosen === alt.code ? null : alt.code)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-sm font-semibold text-foreground shrink-0">{alt.code}</span>
                  <span className="text-sm text-muted-foreground truncate">{alt.description}</span>
                </div>
                <ConfidenceBadge value={alt.confidence} />
              </div>
            ))}
          </>
        )}
      </div>

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={busy || !chosen}
          onClick={() => chosen && onConfirm(mapping.skuId, chosen)}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
          Confirm {chosen ?? "selection"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => {
            setChosen(mapping.wmsCode);
            onConfirm(mapping.skuId, mapping.wmsCode);
          }}
        >
          Accept suggestion
        </Button>
      </div>
    </div>
  );
}

interface Props {
  skuIds: string[];
  onResolved: () => void;
}

export function SkuMappingReview({ skuIds, onResolved }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "review" | "done">("idle");
  const [pendingMappings, setPendingMappings] = useState<PendingMapping[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoAppliedCount, setAutoAppliedCount] = useState(0);
  const [open, setOpen] = useState(true);

  const unmappedCount = skuIds.length;
  if (unmappedCount === 0) return null;

  const resolve = async () => {
    setState("loading");
    try {
      const res = await fetch("/api/sku-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skuIds }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("[sku-mapping-review] server error:", json);
        toast.error(`Mapping failed (${res.status}): ${json?.error ?? "unknown error"}`);
        setState("idle");
        return;
      }
      const data = json as { autoApplied: string[]; pendingMappings: PendingMapping[] };
      setAutoAppliedCount(data.autoApplied.length);
      setPendingMappings(data.pendingMappings);
      if (data.pendingMappings.length === 0) {
        setState("done");
        if (data.autoApplied.length > 0) {
          toast.success(`${data.autoApplied.length} SKU${data.autoApplied.length > 1 ? "s" : ""} mapped via SKU Master / AI. Refreshing stock...`);
          onResolved();
        } else {
          toast.info("No WMS stock mappings found for these SKUs.");
        }
      } else {
        setState("review");
      }
    } catch (err) {
      setState("idle");
      toast.error(`Mapping failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };

  const confirm = async (skuId: string, wmsCode: string) => {
    setBusyId(skuId);
    try {
      await fetch("/api/sku-mappings/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skuId, wmsCode }),
      });
      const remaining = pendingMappings.filter((m) => m.skuId !== skuId);
      setPendingMappings(remaining);
      toast.success(`Mapped to ${wmsCode}`);
      if (remaining.length === 0) {
        setState("done");
        onResolved();
      }
    } catch {
      toast.error("Could not confirm mapping");
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (skuId: string) => {
    setBusyId(skuId);
    try {
      await fetch("/api/sku-mappings/confirm", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skuId }),
      });
      const remaining = pendingMappings.filter((m) => m.skuId !== skuId);
      setPendingMappings(remaining);
      if (remaining.length === 0) setState("done");
    } catch {
      toast.error("Could not dismiss mapping");
    } finally {
      setBusyId(null);
    }
  };

  if (state === "done") return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-950/20">
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-3"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2.5">
          <Bot className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-sm">
            <span className="font-semibold text-amber-800 dark:text-amber-300">
              {state === "idle"
                ? `${unmappedCount} SKU${unmappedCount > 1 ? "s" : ""} without WMS stock mapping`
                : state === "loading"
                ? "Running AI matcher…"
                : `${pendingMappings.length} mapping${pendingMappings.length > 1 ? "s" : ""} need${pendingMappings.length === 1 ? "s" : ""} review`}
            </span>
            {state === "idle" && (
              <span className="ml-1.5 text-amber-700 dark:text-amber-400">
                — Click "Resolve" to auto-map via SKU Master
              </span>
            )}
            {autoAppliedCount > 0 && state === "review" && (
              <span className="ml-1.5 text-amber-700 dark:text-amber-400">
                ({autoAppliedCount} auto-mapped)
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state === "idle" && (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={(e) => { e.stopPropagation(); resolve(); }}
            >
              <Sparkles className="h-3 w-3" />
              Resolve with AI
            </Button>
          )}
          {state === "loading" && <Loader2 className="h-4 w-4 animate-spin text-amber-600" />}
          {state === "review" && (
            <Badge variant="outline" className="text-xs">
              {pendingMappings.length} remaining
            </Badge>
          )}
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {/* Mapping cards */}
      {open && state === "review" && pendingMappings.length > 0 && (
        <div className="border-t border-amber-200 dark:border-amber-800/40 px-4 pb-4 pt-3 space-y-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            AI suggestions below — high-confidence and rule-engine matches were auto-applied; these need your confirmation.
          </p>
          {pendingMappings.map((m) => (
            <MappingCard
              key={m.skuId}
              mapping={m}
              onConfirm={confirm}
              onDismiss={dismiss}
              busy={busyId === m.skuId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
