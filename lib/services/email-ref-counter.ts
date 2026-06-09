import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const KEY = "po_email_ref";
const LEGACY_PROVIDER = "po_email_ref_counter"; // pre-migration IntegrationToken row

export interface SeriesState {
  prefix: string;
  /** Zero-pad width (0 = none). "0001" → 4. */
  padWidth: number;
  /** The last number issued. */
  current: number;
  /** The number the next allocation email will use. */
  next: number;
  /** The next number rendered with padding, e.g. "0001". */
  nextFormatted: string;
}

/** Render a number with zero-padding (never truncates beyond the width). */
export function formatRefNumber(value: number, padWidth: number): string {
  return padWidth > 0 ? String(value).padStart(padWidth, "0") : String(value);
}

/**
 * Seed the Counter row exactly once — preferring the legacy IntegrationToken
 * counter (so the series doesn't reset across the migration), then env defaults.
 * Idempotent and safe under concurrency (create-then-noop upsert).
 */
async function ensureSeeded(): Promise<void> {
  const existing = await prisma.counter.findUnique({ where: { key: KEY } });
  if (existing) return;
  const legacy = await prisma.integrationToken.findUnique({ where: { provider: LEGACY_PROVIDER } });
  const legacyVal =
    legacy && typeof (legacy.data as Record<string, unknown> | null)?.counter === "number"
      ? ((legacy.data as Record<string, unknown>).counter as number)
      : env.PO_EMAIL_REF_START - 1;
  await prisma.counter.upsert({
    where: { key: KEY },
    create: { key: KEY, prefix: env.PO_EMAIL_REF_PREFIX, value: legacyVal },
    update: {}, // another concurrent caller already created it — leave as-is
  });
}

/**
 * Atomically issue the next PO email reference (e.g. "MB - 26/27 - 1458").
 *
 * The increment is a single `UPDATE Counter SET value = value + 1 … RETURNING`
 * (Prisma atomic `increment`) — concurrent allocators serialize on the row lock
 * and each receives a DISTINCT number. No read-then-write race, no duplicates.
 */
export async function nextEmailRef(): Promise<{ prefix: string; value: number; ref: string }> {
  await ensureSeeded();
  const row = await prisma.counter.update({
    where: { key: KEY },
    data: { value: { increment: 1 } },
    select: { prefix: true, value: true, padWidth: true },
  });
  return { prefix: row.prefix, value: row.value, ref: `${row.prefix}${formatRefNumber(row.value, row.padWidth)}` };
}

/** Current series config + the next number that will be issued. */
export async function getSeries(): Promise<SeriesState> {
  await ensureSeeded();
  const row = await prisma.counter.findUniqueOrThrow({ where: { key: KEY } });
  const next = row.value + 1;
  return {
    prefix: row.prefix,
    padWidth: row.padWidth,
    current: row.value,
    next,
    nextFormatted: formatRefNumber(next, row.padWidth),
  };
}

/**
 * Update the series prefix, the next number to issue, and/or the zero-pad width.
 * `nextNumber` is the value the NEXT email will use, so we store value = next - 1.
 * `padWidth` controls leading zeros ("0001" → 4); pass 0 for no padding.
 */
export async function setSeries(opts: {
  prefix?: string;
  nextNumber?: number;
  padWidth?: number;
}): Promise<SeriesState> {
  await ensureSeeded();
  const data: { prefix?: string; value?: number; padWidth?: number } = {};
  if (opts.prefix !== undefined) data.prefix = opts.prefix;
  if (opts.nextNumber !== undefined && Number.isFinite(opts.nextNumber)) {
    data.value = Math.max(0, Math.floor(opts.nextNumber) - 1);
  }
  if (opts.padWidth !== undefined && Number.isFinite(opts.padWidth)) {
    data.padWidth = Math.max(0, Math.min(12, Math.floor(opts.padWidth)));
  }
  await prisma.counter.update({ where: { key: KEY }, data });
  return getSeries();
}
