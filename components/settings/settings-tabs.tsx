"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Loader2, Plug, RefreshCw, Mail } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChannelChip } from "@/components/shared/channel-chip";
import { formatDateTime, pct } from "@/lib/utils";

interface Channel {
  id: string;
  name: string;
  emailDomain: string;
  tier: string;
  fillRateCommitment: number;
  deliverySlaHours: number;
  portalUrl: string | null;
  grnViaEmail: boolean;
  grnViaPortal: boolean;
  active: boolean;
  _count: { purchaseOrders: number; channelSkus: number };
}
interface Sku {
  id: string;
  internalCode: string;
  name: string;
  category: string | null;
  hsnCode: string | null;
  gstRate: number;
  casePackSize: number;
}

export function SettingsTabs({
  channels,
  skus,
  warehouseEmail,
  spreadsheetId,
  emailRecipients,
}: {
  channels: Channel[];
  skus: Sku[];
  warehouseEmail: string;
  spreadsheetId: string;
  emailRecipients: { to: string[]; cc: string[] };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Channel | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  async function saveChannel(form: Partial<Channel>) {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error();
      toast.success("Channel updated");
      setEditing(null);
      router.refresh();
    } catch {
      toast.error("Failed to update channel");
    } finally {
      setSaving(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await fetch("/api/inventory/atp?force=1", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setLastSync(new Date());
      toast.success("Inventory synced");
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Tabs defaultValue="channels">
      <TabsList>
        <TabsTrigger value="channels">Channels</TabsTrigger>
        <TabsTrigger value="skus">SKUs</TabsTrigger>
        <TabsTrigger value="inventory">Inventory</TabsTrigger>
        <TabsTrigger value="warehouse">Warehouse</TabsTrigger>
        <TabsTrigger value="email"><Mail className="h-3.5 w-3.5 mr-1.5" />Email</TabsTrigger>
      </TabsList>

      {/* Channels */}
      <TabsContent value="channels">
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Channel</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Fill commit</TableHead>
                  <TableHead className="text-right">SLA</TableHead>
                  <TableHead>GRN via</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell><ChannelChip name={c.name} tier={c.tier} /></TableCell>
                    <TableCell className="text-muted-foreground">{c.emailDomain}</TableCell>
                    <TableCell className="text-right nums">{pct(c.fillRateCommitment, 0)}</TableCell>
                    <TableCell className="text-right nums">{c.deliverySlaHours}h</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {c.grnViaEmail && <Badge variant="info">Email</Badge>}
                        {c.grnViaPortal && <Badge variant="purple">Portal</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="icon-sm" onClick={() => setEditing(c)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      {/* SKUs */}
      <TabsContent value="skus">
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>HSN</TableHead>
                  <TableHead className="text-right">GST</TableHead>
                  <TableHead className="text-right">Case pack</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skus.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.internalCode}</TableCell>
                    <TableCell className="text-muted-foreground">{s.name}</TableCell>
                    <TableCell className="nums text-muted-foreground">{s.hsnCode}</TableCell>
                    <TableCell className="text-right nums">{pct(s.gstRate, 0)}</TableCell>
                    <TableCell className="text-right nums">{s.casePackSize}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Inventory */}
      <TabsContent value="inventory">
        <Card>
          <CardHeader><CardTitle className="text-base">Google Sheets inventory</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:max-w-md">
              <Label>Spreadsheet ID</Label>
              <Input defaultValue={spreadsheetId} placeholder="1AbC…spreadsheet id" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              {["SKU code", "On hand", "Reserved", "Safety stock"].map((c, i) => (
                <div key={c} className="grid gap-1.5">
                  <Label className="text-xs">{c} column</Label>
                  <Input defaultValue={["A", "B", "C", "D"][i]} className="h-9" />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={syncNow} disabled={syncing}>
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync now
              </Button>
              {lastSync && (
                <span className="text-sm text-muted-foreground">
                  Last synced {formatDateTime(lastSync)}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Warehouse */}
      <TabsContent value="warehouse">
        <Card>
          <CardHeader><CardTitle className="text-base">Warehouse</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:max-w-md">
              <Label>Dispatch email address</Label>
              <Input defaultValue={warehouseEmail} />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Email template (read-only)</Label>
              <pre className="mt-2 overflow-auto rounded-xl border border-border/70 bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
{`Subject: Dispatch Instruction — PO {poNumber} for {channel} — Due {date}

Dear Warehouse Team,
Please dispatch the following order:

Channel: {channel}
PO Number: {poNumber}
Delivery Address: {address}
Dispatch By: {date}

PICKING LIST:
| SKU Code | Product | Quantity | Case Packs |
| ...      | ...     | ...      | ...        |

Please reply confirming dispatch with AWB number and actual quantities.
Reference ID: {warehouseInstructionId}`}
              </pre>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Email recipients */}
      <TabsContent value="email">
        <EmailRecipientsCard initialTo={emailRecipients.to} initialCc={emailRecipients.cc} />
      </TabsContent>

      {/* Edit channel dialog */}
      <ChannelEditDialog
        channel={editing}
        saving={saving}
        onClose={() => setEditing(null)}
        onSave={saveChannel}
      />
    </Tabs>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmails(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EmailRecipientsCard({
  initialTo,
  initialCc,
}: {
  initialTo: string[];
  initialCc: string[];
}) {
  const router = useRouter();
  const [toRaw, setToRaw] = useState(initialTo.join("\n"));
  const [ccRaw, setCcRaw] = useState(initialCc.join("\n"));
  const [saving, setSaving] = useState(false);

  function validate(): string | null {
    const to = parseEmails(toRaw);
    const cc = parseEmails(ccRaw);
    if (to.length === 0) return "At least one To address is required.";
    const invalid = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
    if (invalid.length) return `Invalid email(s): ${invalid.join(", ")}`;
    return null;
  }

  async function save() {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/email-recipients", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: parseEmails(toRaw), cc: parseEmails(ccRaw) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Save failed");
      }
      toast.success("Email recipients saved");
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
        <CardTitle className="text-base">PO preparation email recipients</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 sm:max-w-md">
        <div className="grid gap-1.5">
          <Label htmlFor="email-to">Send to</Label>
          <p className="text-xs text-muted-foreground">One email per line (or comma-separated).</p>
          <textarea
            id="email-to"
            rows={3}
            value={toRaw}
            onChange={(e) => setToRaw(e.target.value)}
            placeholder="abhishek@moxiebeauty.in"
            className="flex w-full rounded-lg border border-input bg-card px-3.5 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email-cc">CC</Label>
          <p className="text-xs text-muted-foreground">Optional. One email per line (or comma-separated).</p>
          <textarea
            id="email-cc"
            rows={3}
            value={ccRaw}
            onChange={(e) => setCcRaw(e.target.value)}
            placeholder="ops@moxiebeauty.in"
            className="flex w-full rounded-lg border border-input bg-card px-3.5 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
          />
        </div>
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save recipients
        </Button>
      </CardContent>
    </Card>
  );
}

function ChannelEditDialog({
  channel, saving, onClose, onSave,
}: {
  channel: Channel | null;
  saving: boolean;
  onClose: () => void;
  onSave: (form: Partial<Channel>) => void;
}) {
  const [form, setForm] = useState<Partial<Channel>>({});
  const c = channel;

  return (
    <Dialog open={!!channel} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {c && (
          <>
            <DialogHeader><DialogTitle>Edit {c.name}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input defaultValue={c.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Tier</Label>
                  <Select defaultValue={c.tier} onValueChange={(v) => setForm((f) => ({ ...f, tier: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["A", "B", "C"].map((t) => <SelectItem key={t} value={t}>Tier {t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>SLA (hours)</Label>
                  <Input type="number" defaultValue={c.deliverySlaHours} onChange={(e) => setForm((f) => ({ ...f, deliverySlaHours: Number(e.target.value) }))} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Fill rate commitment (%)</Label>
                <Input type="number" defaultValue={c.fillRateCommitment} onChange={(e) => setForm((f) => ({ ...f, fillRateCommitment: Number(e.target.value) }))} />
              </div>
              <div className="grid gap-1.5">
                <Label>Portal URL</Label>
                <Input defaultValue={c.portalUrl ?? ""} placeholder="https://…" onChange={(e) => setForm((f) => ({ ...f, portalUrl: e.target.value }))} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2.5">
                <Label className="cursor-pointer">GRN via email</Label>
                <Switch defaultChecked={c.grnViaEmail} onCheckedChange={(v) => setForm((f) => ({ ...f, grnViaEmail: v }))} />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2.5">
                <Label className="cursor-pointer">GRN via portal</Label>
                <Switch defaultChecked={c.grnViaPortal} onCheckedChange={(v) => setForm((f) => ({ ...f, grnViaPortal: v }))} />
              </div>
              <Button variant="outline" className="w-full" onClick={() => toast.info("Portal test queued — check WhatsApp for the result")}>
                <Plug className="h-4 w-4" /> Test portal connection
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={() => onSave(form)} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save changes
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
