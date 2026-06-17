"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface EmailTemplate {
  greeting: string;
  intro: string;
  signoff: string;
}

/**
 * Edit the copy of the PO dispatch email (greeting / intro / signature). The SKU
 * table and PO bullets are always auto-generated from the PO, so only these
 * surrounding lines are editable. Live preview shows exactly what gets sent.
 */
export function EmailTemplateCard({ initial }: { initial: EmailTemplate }) {
  const router = useRouter();
  const [greeting, setGreeting] = useState(initial.greeting);
  const [intro, setIntro] = useState(initial.intro);
  const [signoff, setSignoff] = useState(initial.signoff);
  const [saving, setSaving] = useState(false);

  const dirty =
    greeting !== initial.greeting || intro !== initial.intro || signoff !== initial.signoff;
  const valid = greeting.trim() && intro.trim() && signoff.trim();

  async function save() {
    if (!valid) {
      toast.error("Greeting, intro and signature are all required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/email-template", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ greeting, intro, signoff }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success("Dispatch email template saved");
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
          <Mail className="h-4 w-4 text-muted-foreground" /> Dispatch email template
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The greeting, intro line and signature below are editable. The SKU/Qty table and the
          PO details (PO No., Location/WH, Channel, Dispatch From) are filled in automatically for
          each PO. The subject is the allocation reference number.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="et-greeting">Greeting</Label>
          <Input id="et-greeting" value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder="Hi Team," />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="et-intro">Intro line</Label>
          <Input id="et-intro" value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="Please prepare the mention PO:-" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="et-signoff">Signature (one line each — e.g. “Regards,” then “Team Moxie”)</Label>
          <textarea
            id="et-signoff"
            value={signoff}
            onChange={(e) => setSignoff(e.target.value)}
            rows={2}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={"Regards,\nTeam Moxie"}
          />
        </div>

        {/* Live preview — mirrors the real email layout */}
        <div className="rounded-xl border border-border/70 bg-muted/30 p-4 text-sm">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Preview</div>
          <p className="mb-2">{greeting}</p>
          <p className="mb-2">{intro}</p>
          <table className="mb-2 border-collapse text-xs">
            <thead>
              <tr>
                <th className="border border-border bg-[#F6E199] px-3 py-1 text-left">SKU</th>
                <th className="border border-border bg-[#C6E0B4] px-3 py-1 text-left">Qty</th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="border border-border px-3 py-1 font-mono">GCS200</td><td className="border border-border px-3 py-1">24</td></tr>
              <tr><td className="border border-border px-3 py-1 font-mono">WLIC50</td><td className="border border-border px-3 py-1">12</td></tr>
            </tbody>
          </table>
          <ul className="mb-2 list-disc pl-5 text-xs text-muted-foreground">
            <li>PO No. - 5000478343</li>
            <li>Location/WH: - MUM-DRY-MH3</li>
            <li>Channel: Zepto</li>
            <li>Dispatch From: RGL NCR</li>
          </ul>
          <p className="whitespace-pre-line text-muted-foreground">{`--\n${signoff}`}</p>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || !dirty || !valid} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save template
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
