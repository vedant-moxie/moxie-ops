"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Hash, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SeriesState {
  prefix: string;
  current: number;
  next: number;
}

/**
 * Edit the allocation-email reference series — the "MB - 26/27 - 1458" subject.
 * Set the prefix and/or jump the next number. The counter itself is atomic
 * server-side, so concurrent allocators always get distinct numbers.
 */
export function EmailSeriesCard({ series }: { series: SeriesState }) {
  const router = useRouter();
  const [prefix, setPrefix] = useState(series.prefix);
  const [nextNumber, setNextNumber] = useState(String(series.next));
  const [saving, setSaving] = useState(false);

  const parsedNext = Math.floor(Number(nextNumber));
  const validNext = Number.isFinite(parsedNext) && parsedNext > 0;
  const preview = `${prefix}${validNext ? parsedNext : series.next}`;
  const dirty = prefix !== series.prefix || parsedNext !== series.next;

  async function save() {
    if (!validNext) {
      toast.error("Next number must be a positive integer");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/email-series", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, nextNumber: parsedNext }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(`Series updated · next email will be "${json.data.prefix}${json.data.next}"`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hash className="h-4 w-4 text-muted-foreground" /> Allocation email reference series
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Every allocation email subject is <span className="font-mono">{"{prefix}{number}"}</span>. The number
          increments atomically per email, so two people allocating at once never get the same reference.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="series-prefix">Prefix</Label>
            <Input
              id="series-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="MB - 26/27 - "
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="series-next">Next number</Label>
            <Input
              id="series-next"
              type="number"
              min={1}
              value={nextNumber}
              onChange={(e) => setNextNumber(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Next email subject preview:</span>{" "}
            <span className="font-mono font-medium">{preview || "—"}</span>
            <span className="ml-2 text-xs text-muted-foreground">(last issued: {series.current})</span>
          </div>
          <Button onClick={save} disabled={saving || !dirty || !validNext} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save series
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
