import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { allocateAndEmailPo } from "@/lib/services/allocate-and-email";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  poIds: z.array(z.string()).min(1),
  // Set true to send emails even when channel prices differ from the rate sheet
  // (the bulk UI sets this after the operator confirms the review dialog).
  acknowledge: z.boolean().optional(),
  // Per-PO SKU removals from the review step: { [poId]: skuId[] } → those lines are
  // allocated 0 and left out of the email (e.g. unmapped/new SKUs we won't sell).
  removals: z.record(z.string(), z.array(z.string())).optional(),
  // Per-PO operator-edited email body HTML from the review modal: { [poId]: html }.
  // When present for a PO, that body is sent verbatim instead of the template render.
  bodies: z.record(z.string(), z.string()).optional(),
  // Per-PO operator-edited free-text subject: { [poId]: subject }.
  subjects: z.record(z.string(), z.string()).optional(),
});

export interface BulkAllocateResult {
  poId: string;
  ok: boolean;
  emailMessageId?: string | null;
  /** Allocation saved but email held back due to an unacknowledged price mismatch. */
  mismatchWithheld?: boolean;
  /** Allocation saved but the email send failed (after retries). */
  emailFailed?: boolean;
  /** Allocation saved but the email reached no one — PO flagged HELD, needs resend. */
  heldNoRecipients?: boolean;
  /** Why the email was held (shown in the resend preview). */
  emailHoldReason?: string;
  emailRef?: string | null;
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
    const { poIds, acknowledge, removals, bodies, subjects } = schema.parse(await req.json());

    const results: BulkAllocateResult[] = [];
    for (const poId of poIds) {
      try {
        const { emailMessageId, mismatchWithheld, emailFailed, emailRef, heldNoRecipients, emailHoldReason } =
          await allocateAndEmailPo(
            poId,
            { full: true, excludeSkuIds: removals?.[poId] ?? [] },
            actor,
            acknowledge ?? false,
            { bodyHtml: bodies?.[poId], subject: subjects?.[poId] },
          );
        results.push({ poId, ok: true, emailMessageId, mismatchWithheld, emailFailed, heldNoRecipients, emailHoldReason, emailRef });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[allocate-bulk] PO ${poId} failed:`, err);
        results.push({ poId, ok: false, error: message });
      }
    }

    return ok({ results });
  });
}
