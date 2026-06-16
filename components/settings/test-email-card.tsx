"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FlaskConical, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Test-mode email sink. When ON, every outgoing email (PO dispatch, GRN
 * reminders, discrepancy notices, etc.) is redirected so ONLY the test address
 * receives it — nobody else gets mailed. Lets you exercise the email flows
 * safely before deployment.
 */
export function TestEmailCard({
  initial,
}: {
  initial: { enabled: boolean; address: string };
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [address, setAddress] = useState(initial.address);
  const [saving, setSaving] = useState(false);

  const validAddress = EMAIL_RE.test(address.trim());
  const dirty = enabled !== initial.enabled || address.trim() !== initial.address;

  async function save() {
    if (enabled && !validAddress) {
      toast.error("Enter a valid test email address before enabling test mode");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/test-email", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, address: address.trim() }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success(
        json.data.enabled
          ? `Test mode ON — all email now goes only to ${json.data.address}`
          : "Test mode OFF — email sends to real recipients again",
      );
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
          <FlaskConical className="h-4 w-4 text-muted-foreground" /> Test email mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When ON, <strong>every outgoing email</strong> (PO dispatch, GRN reminders, discrepancy
          notices, alerts) is redirected to the test address below — vendors, warehouses, and everyone
          else receive <strong>nothing</strong>. The real recipients are shown in the email body so you
          can verify routing. Turn OFF to resume normal delivery.
        </p>

        <div className="flex items-center justify-between rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
          <div className="space-y-0.5">
            <Label htmlFor="test-email-toggle" className="text-sm font-medium">
              Redirect all email to the test address
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {enabled ? "ON — only the test address is mailed" : "OFF — email sends to real recipients"}
            </p>
          </div>
          <Switch id="test-email-toggle" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="test-email-address">Test email address</Label>
          <Input
            id="test-email-address"
            type="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="you@moxiebeauty.in"
            className={enabled && !validAddress ? "border-destructive" : ""}
          />
          {enabled && !validAddress && (
            <p className="text-[11px] text-destructive">A valid address is required to enable test mode.</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          {enabled && validAddress ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              ⚠️ Test mode is set to ON — only <span className="font-medium">{address.trim()}</span> will be mailed once saved.
            </p>
          ) : (
            <span className="text-xs text-muted-foreground">Saves immediately on click.</span>
          )}
          <Button onClick={save} disabled={saving || !dirty} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
