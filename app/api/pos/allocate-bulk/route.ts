import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { allocateAndEmailPo } from "@/lib/services/allocate-and-email";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  poIds: z.array(z.string()).min(1),
});

export interface BulkAllocateResult {
  poId: string;
  ok: boolean;
  emailMessageId?: string | null;
  error?: string;
}

/**
 * POST /api/pos/allocate-bulk
 * Allocate every PO in `poIds` to its full ordered qty and send prep emails.
 * Per-PO failures are caught and returned; they never abort the whole batch.
 */
export async function POST(req: NextRequest) {
  return handler("POST /api/pos/allocate-bulk", async () => {
    const actor = await currentActor();
    const { poIds } = schema.parse(await req.json());

    const results: BulkAllocateResult[] = [];
    for (const poId of poIds) {
      try {
        const { emailMessageId } = await allocateAndEmailPo(
          poId,
          { full: true },
          actor.label,
        );
        results.push({ poId, ok: true, emailMessageId });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[allocate-bulk] PO ${poId} failed:`, err);
        results.push({ poId, ok: false, error: message });
      }
    }

    return ok({ results });
  });
}
