import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const KEY = "po_email_ref_counter";

/**
 * Atomically increments and returns the next PO email reference number.
 *
 * Persisted in IntegrationToken (no migration required).
 * First call seeds from PO_EMAIL_REF_START env var (default 1457).
 */
export async function nextEmailRefNumber(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.integrationToken.findUnique({ where: { provider: KEY } });
    const current =
      row && typeof (row.data as Record<string, unknown>)?.counter === "number"
        ? ((row.data as Record<string, unknown>).counter as number)
        : env.PO_EMAIL_REF_START - 1;
    const next = current + 1;
    await tx.integrationToken.upsert({
      where: { provider: KEY },
      create: { provider: KEY, accessToken: String(next), data: { counter: next } },
      update: { accessToken: String(next), data: { counter: next } },
    });
    return next;
  });
}
