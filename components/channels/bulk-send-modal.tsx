"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, SendHorizonal } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface BulkPo {
  id: string;
  poNumber: string;
}

interface Preview {
  poNumber: string;
  channel: string;
  location: string;
  dispatchFrom: string;
  subjectPreview: string;
  to: string[];
  cc: string[];
  testMode: boolean;
  lineCount: number;
  html: string;
}

/**
 * Review the dispatch email for each selected PO one at a time (Prev/Next), then
 * "Send all" — full-allocates + emails the whole batch via /api/pos/allocate-bulk.
 */
export function BulkSendModal({
  pos,
  open,
  onClose,
  onSent,
}: {
  pos: BulkPo[];
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  // cache previews by poId so Prev/Next is instant after first view
  const [cache, setCache] = useState<Record<string, Preview>>({});

  const current = pos[idx];
  const total = pos.length;

  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  useEffect(() => {
    if (!open || !current) return;
    const cached = cache[current.id];
    if (cached) {
      setPreview(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    fetch(`/api/pos/${current.id}/email-preview`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.error || "Preview failed");
        setCache((c) => ({ ...c, [current.id]: json.data }));
        setPreview(json.data);
      })
      .catch((e) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Preview failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.id]);

  async function sendAll() {
    setSending(true);
    const t = toast.loading(`Sending ${total} PO${total > 1 ? "s" : ""}…`);
    try {
      const res = await fetch("/api/pos/allocate-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poIds: pos.map((p) => p.id), acknowledge: true }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Send failed");
      const results = json.data.results as { ok: boolean; mismatchWithheld?: boolean }[];
      const sent = results.filter((r) => r.ok && !r.mismatchWithheld).length;
      const withheld = results.filter((r) => r.mismatchWithheld).length;
      const failed = results.filter((r) => !r.ok).length;
      toast.success(
        `Allocated & sent ${sent}/${total}` +
          (withheld ? ` · ${withheld} held (price mismatch)` : "") +
          (failed ? ` · ${failed} failed` : ""),
        { id: t },
      );
      onSent();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed", { id: t });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3">
            <span>Review &amp; send — {total} PO{total > 1 ? "s" : ""}</span>
            <span className="text-sm font-normal text-muted-foreground">
              {idx + 1} of {total}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-[360px] max-h-[60vh] overflow-auto rounded-lg border border-border/70 bg-white p-4">
          {loading || !preview ? (
            <div className="flex h-[320px] items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Building preview for {current?.poNumber}…
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 text-xs">
                <div><span className="text-muted-foreground">PO:</span> <span className="font-medium">{preview.poNumber}</span></div>
                <div><span className="text-muted-foreground">Subject:</span> <span className="font-mono">{preview.subjectPreview}</span></div>
                <div className="col-span-2"><span className="text-muted-foreground">To:</span> {preview.to.join(", ") || "—"}</div>
                {preview.cc.length > 0 && <div className="col-span-2"><span className="text-muted-foreground">Cc:</span> {preview.cc.join(", ")}</div>}
                <div><span className="text-muted-foreground">Dispatch From:</span> {preview.dispatchFrom}</div>
                <div><span className="text-muted-foreground">Location/WH:</span> {preview.location}</div>
              </div>
              {preview.testMode && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  🧪 Test mode is ON — this will go only to the test address, not the recipients above.
                </div>
              )}
              <div className="text-[11px] text-muted-foreground">Attachments: the channel PO PDF + Excel are fetched and attached at send time.</div>
              <div className="rounded-md border border-border/60 p-3 [&_table]:my-2 [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1" dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={idx >= total - 1} onClick={() => setIdx((i) => Math.min(total - 1, i + 1))}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={sendAll} disabled={sending} className="gap-2">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
            Send all ({total})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
