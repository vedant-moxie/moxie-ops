"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Upload, Download, Pencil, Trash2, Search, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

export interface SkuMasterRow {
  internalCode: string;
  name: string | null;
  hsnCode: string | null;
  gstRate: number;
  mrp: number | null;
  taxableB2B: number | null;
  zeptoCode: string | null;
  nykaaCode: string | null;
  instamartCode: string | null;
  blinkitCode: string | null;
  taxableZepto: number | null;
  taxableNykaa: number | null;
  taxableInstamart: number | null;
  taxableMyntra: number | null;
  taxableBlinkit: number | null;
  taxableReliance: number | null;
  taxableAmazonNow: number | null;
  updatedBy?: string | null;
}

const BLANK: SkuMasterRow = {
  internalCode: "", name: "", hsnCode: "", gstRate: 0, mrp: null, taxableB2B: null,
  zeptoCode: "", nykaaCode: "", instamartCode: "", blinkitCode: "",
  taxableZepto: null, taxableNykaa: null, taxableInstamart: null, taxableMyntra: null,
  taxableBlinkit: null, taxableReliance: null, taxableAmazonNow: null,
};

// Channels with both a SKU-code and a taxable-value column
const CODE_CHANNELS: { key: keyof SkuMasterRow; tax: keyof SkuMasterRow; label: string }[] = [
  { key: "blinkitCode", tax: "taxableBlinkit", label: "Blinkit" },
  { key: "zeptoCode", tax: "taxableZepto", label: "Zepto" },
  { key: "instamartCode", tax: "taxableInstamart", label: "Instamart" },
  { key: "nykaaCode", tax: "taxableNykaa", label: "Nykaa" },
];
// Channels with only a taxable-value column (no code in the master)
const TAX_ONLY: { key: keyof SkuMasterRow; label: string }[] = [
  { key: "taxableMyntra", label: "Myntra" },
  { key: "taxableReliance", label: "Reliance" },
  { key: "taxableAmazonNow", label: "Amazon Now" },
];

const numOrDash = (v: number | null) => (v == null ? "—" : v.toLocaleString("en-IN"));

export function SkuMasterCard({ rows, isAdmin }: { rows: SkuMasterRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SkuMasterRow | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) =>
        [r.internalCode, r.name, r.blinkitCode, r.zeptoCode, r.instamartCode, r.nykaaCode]
          .some((v) => v?.toLowerCase().includes(q)),
      )
    : rows;

  function openEdit(row: SkuMasterRow) { setEditing({ ...row }); setIsNew(false); }
  function openNew() { setEditing({ ...BLANK }); setIsNew(true); }

  async function save() {
    if (!editing) return;
    if (!editing.internalCode.trim()) { toast.error("Internal SKU code is required"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/skus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Save failed");
      toast.success(`Saved ${editing.internalCode}`);
      setEditing(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(code: string) {
    if (!confirm(`Delete SKU "${code}" from the master? This affects mapping & price checks.`)) return;
    try {
      const res = await fetch(`/api/settings/skus/${encodeURIComponent(code)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Delete failed");
      toast.success(`Deleted ${code}`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setUploading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/settings/skus/import", { method: "POST", body: fd });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || (json.data?.errors?.[0]) || "Import failed");
        const d = json.data;
        toast.success(`Imported ${d.upserted} SKUs${d.skipped ? `, skipped ${d.skipped}` : ""}${d.errors?.length ? `, ${d.errors.length} errors` : ""}`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Import failed");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    }
  }

  const setField = (k: keyof SkuMasterRow, v: string) =>
    setEditing((p) => (p ? { ...p, [k]: v } : p));
  const setNum = (k: keyof SkuMasterRow, v: string) =>
    setEditing((p) => (p ? { ...p, [k]: v === "" ? null : Number(v) } : p));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code, name or channel id…"
            className="h-9 w-72 pl-8"
          />
        </div>
        <span className="text-xs text-muted-foreground">{filtered.length} of {rows.length} SKUs</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href="/api/settings/skus/export"><Download className="h-4 w-4" /> Export xlsx</a>
          </Button>
          {isAdmin && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={onUpload}
              />
              <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload xlsx/csv
              </Button>
              <Button size="sm" onClick={openNew}><Plus className="h-4 w-4" /> Add SKU</Button>
            </>
          )}
        </div>
      </div>

      {!isAdmin && (
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" /> Read-only — editing the SKU master is restricted to admins.
        </div>
      )}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>SKU code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">MRP</TableHead>
                  <TableHead className="text-right">B2B taxable</TableHead>
                  <TableHead>Blinkit</TableHead>
                  <TableHead>Zepto</TableHead>
                  <TableHead>Instamart</TableHead>
                  <TableHead>Nykaa</TableHead>
                  {isAdmin && <TableHead className="text-right">Edit</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => (
                  <TableRow key={s.internalCode}>
                    <TableCell className="font-medium">{s.internalCode}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-muted-foreground" title={s.name ?? ""}>{s.name ?? "—"}</TableCell>
                    <TableCell className="text-right nums">{numOrDash(s.mrp)}</TableCell>
                    <TableCell className="text-right nums">{numOrDash(s.taxableB2B)}</TableCell>
                    <TableCell className="nums text-xs text-muted-foreground">{s.blinkitCode ?? "—"}</TableCell>
                    <TableCell className="nums text-xs text-muted-foreground" title={s.zeptoCode ?? ""}>{s.zeptoCode ? s.zeptoCode.slice(0, 10) + (s.zeptoCode.length > 10 ? "…" : "") : "—"}</TableCell>
                    <TableCell className="nums text-xs text-muted-foreground">{s.instamartCode ?? "—"}</TableCell>
                    <TableCell className="nums text-xs text-muted-foreground">{s.nykaaCode ?? "—"}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(s)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-rose-600 hover:text-rose-700" onClick={() => remove(s.internalCode)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={isAdmin ? 9 : 8} className="py-8 text-center text-sm text-muted-foreground">No SKUs match “{query}”.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isNew ? "Add SKU" : `Edit ${editing?.internalCode}`}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Internal SKU code *</Label>
                  <Input
                    value={editing.internalCode}
                    disabled={!isNew}
                    onChange={(e) => setField("internalCode", e.target.value)}
                    placeholder="GCS200"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label className="text-xs">Product name</Label>
                  <Input value={editing.name ?? ""} onChange={(e) => setField("name", e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">HSN code</Label>
                  <Input value={editing.hsnCode ?? ""} onChange={(e) => setField("hsnCode", e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">GST rate (fraction, e.g. 0.05)</Label>
                  <Input type="number" step="0.01" value={editing.gstRate ?? 0} onChange={(e) => setNum("gstRate", e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">MRP</Label>
                  <Input type="number" step="0.01" value={editing.mrp ?? ""} onChange={(e) => setNum("mrp", e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Taxable value (B2B)</Label>
                  <Input type="number" step="0.01" value={editing.taxableB2B ?? ""} onChange={(e) => setNum("taxableB2B", e.target.value)} />
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold text-muted-foreground">Channel SKU ids & taxable values</div>
                <div className="space-y-2">
                  {CODE_CHANNELS.map((c) => (
                    <div key={c.label} className="grid grid-cols-[80px_1fr_140px] items-center gap-2">
                      <span className="text-sm">{c.label}</span>
                      <Input
                        value={(editing[c.key] as string | null) ?? ""}
                        onChange={(e) => setField(c.key, e.target.value)}
                        placeholder={`${c.label} SKU id`}
                        className="h-9"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        value={(editing[c.tax] as number | null) ?? ""}
                        onChange={(e) => setNum(c.tax, e.target.value)}
                        placeholder="taxable"
                        className="h-9"
                      />
                    </div>
                  ))}
                  {TAX_ONLY.map((c) => (
                    <div key={c.label} className="grid grid-cols-[80px_1fr_140px] items-center gap-2">
                      <span className="text-sm">{c.label}</span>
                      <span className="text-xs text-muted-foreground">no SKU id column</span>
                      <Input
                        type="number"
                        step="0.01"
                        value={(editing[c.key] as number | null) ?? ""}
                        onChange={(e) => setNum(c.key, e.target.value)}
                        placeholder="taxable"
                        className="h-9"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
