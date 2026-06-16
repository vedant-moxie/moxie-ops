import "server-only";
import { prisma } from "@/lib/db";

/**
 * EAN/barcode → internalCode, read straight from the SkuMaster table.
 *
 * Why a DB query and not the in-memory `skuMasterMaps()`: the DB-backed runtime
 * maps are only refreshed in the instrumentation layer, and Next bundles server
 * components / route handlers in a separate module instance where those maps are
 * still the file defaults (no EAN data). Querying the table is authoritative and
 * cheap (indexed, one query per render for a handful of EANs).
 */
export async function mapEansToInternal(
  eans: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const clean = [...new Set(eans.filter((e): e is string => !!e && e.trim() !== "").map((e) => e.trim()))];
  if (clean.length === 0) return new Map();
  const rows = await prisma.skuMaster.findMany({
    where: { ean: { in: clean } },
    select: { ean: true, internalCode: true },
  });
  const m = new Map<string, string>();
  for (const r of rows) if (r.ean) m.set(r.ean, r.internalCode);
  return m;
}
