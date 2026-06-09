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
  padWidth: number;
  current: number;
  next: number;
  nextFormatted: string;
}

/** Zero-pad a number to a width (never truncates). Mirrors the server formatter. */
function pad(value: number, width: number): string {
  return width > 0 ? String(value).padStart(width, "0") : String(value);
}

/**
 * Edit the allocation-email reference series — the "MB - 26/27 - 0001" subject.
 * Set the prefix, the next number, and its zero-padding (typing "0001" keeps the
 * leading zeros — the number of digits you type becomes the pad width). The counter
 * itself is atomic server-side, so concurrent allocators always get distinct numbers.
 */
export function EmailSeriesCard({ series }: { series: SeriesState }) {
  const router = useRouter();
  const [prefix, setPrefix] = useState(series.prefix);
  // Text (not number) so leading zeros survive; the digit count = pad width.
  const [nextStr, setNextStr] = useState(series.nextFormatted);
  const [saving, setSaving] = useState(false);

  const digits = nextStr.replace(/\D/g, "");
  const parsedNext = digits === "" ? NaN : parseInt(digits, 10);
  const padWidth = digits.length;
  const validNext = Number.isFinite(parsedNext) && parsedNext > 0;
  const preview = `${prefix}${validNext ? pad(parsedNext, padWidth) : series.nextFormatted}`;
  const dirty = prefix !== series.prefix || parsedNext !== series.next || padWidth !== series.padWidth;

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
        body: JSON.stringify({ prefix, nextNumber: parsedNext, padWidth }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(`Series updated · next email will be "${json.data.prefix}${json.data.nextFormatted}"`);
      setNextStr(json.data.nextFormatted);
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
              inputMode="numeric"
              value={nextStr}
              onChange={(e) => setNextStr(e.target.value.replace(/\D/g, ""))}
              placeholder="0001"
            />
            <p className="text-[11px] text-muted-foreground">
              Leading zeros are kept — typing <span className="font-mono">0001</span> pads every reference to {Math.max(padWidth, 1)} digits.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Next email subject preview:</span>{" "}
            <span className="font-mono font-medium">{preview || "—"}</span>
            <span className="ml-2 text-xs text-muted-foreground">(last issued: {pad(series.current, series.padWidth)})</span>
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
