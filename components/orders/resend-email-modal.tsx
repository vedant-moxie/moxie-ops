"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Mail, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";

/** Shape returned by GET /api/pos/[id]/email-preview (the fields we use here). */
interface Preview {
  poNumber: string;
  channel: string;
  dispatchFrom: string;
  location: string;
  refPreview: string;
  emailRef: string | null;
  emailStatus: string;
  emailHoldReason: string | null;
  to: string[];
  cc: string[];
  testMode: boolean;
  willReachNoOne: boolean;
  html: string;
}

const splitEmails = (s: string) =>
  s.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);

/**
 * Resend the PO-preparation email from an editable preview. Prefilled with the
 * recipients that would resolve today (empty when the PO reached no one), the operator
 * fixes To/Cc + subject and resends. The PO's existing reference is reused verbatim, so
 * the resent email carries the same number.
 */
export function ResendEmailModal({
  poId,
  buttonLabel = "Resend email",
  buttonVariant = "default",
}: {
  poId: string;
  buttonLabel?: string;
  buttonVariant?: "default" | "outline";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/pos/${poId}/email-preview`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Failed to load preview");
      const p = json.data as Preview;
      setPreview(p);
      setTo(p.to.join(", "));
      setCc(p.cc.join(", "));
      setSubject(p.emailRef ?? p.refPreview);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load preview");
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setPreview(null);
      void load();
    }
  }

  async function resend() {
    const toList = splitEmails(to);
    const ccList = splitEmails(cc);
    if (toList.length === 0) {
      toast.error("Add at least one To recipient before resending");
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`/api/pos/${poId}/resend-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: toList, cc: ccList, subject: subject.trim() || undefined }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Resend failed");
      toast.success(`Resent ${preview?.emailRef ?? "email"} to ${toList.length} recipient${toList.length > 1 ? "s" : ""}`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Resend failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={buttonVariant} size="sm">
          <Mail className="h-4 w-4" /> {buttonLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Resend PO email {preview?.emailRef ? <span className="font-mono text-sm text-muted-foreground">· {preview.emailRef}</span> : null}
          </DialogTitle>
        </DialogHeader>

        {loading || !preview ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Not-delivered / hold banner */}
            {(preview.willReachNoOne || preview.emailStatus === "HELD" || preview.emailStatus === "FAILED") && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950/30">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="text-amber-800 dark:text-amber-300">
                  <span className="font-semibold">This email reached no one.</span>{" "}
                  {preview.emailHoldReason ??
                    "No recipients resolved for this PO's dispatch location. Add recipients below and resend."}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 text-xs">
              <div><span className="text-muted-foreground">PO:</span> {preview.poNumber}</div>
              <div><span className="text-muted-foreground">Channel:</span> {preview.channel}</div>
              <div><span className="text-muted-foreground">Dispatch from:</span> {preview.dispatchFrom}</div>
              <div><span className="text-muted-foreground">Location/WH:</span> {preview.location}</div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="resend-to">To <span className="text-muted-foreground">(comma-separated)</span></Label>
              <Input
                id="resend-to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="ops@moxiebeauty.in, warehouse@…"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="resend-cc">Cc</Label>
              <Input id="resend-cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="resend-subject">Subject</Label>
              <Input id="resend-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>Body preview</Label>
              <div
                className="max-h-64 overflow-auto rounded-md border bg-white p-3 text-sm"
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={sending}>Cancel</Button>
          <Button onClick={resend} disabled={sending || loading || !preview}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {sending ? "Resending…" : "Resend now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
