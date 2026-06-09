import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { allocateAndEmailPo } from "@/lib/services/allocate-and-email";

export const dynamic = "force-dynamic";

const schema = z.object({
  allocations: z.array(
    z.object({ skuId: z.string(), approvedQty: z.number().int().nonnegative() }),
  ),
  // Set true to send the email even when channel prices differ from the rate sheet.
  acknowledge: z.boolean().optional(),
});

/** Persist per-SKU approved quantities for one PO and email abhishek@ about preparation. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/allocate", async () => {
    const actor = await currentActor();
    const { allocations, acknowledge } = schema.parse(await req.json());

    const result = await allocateAndEmailPo(
      params.id,
      { allocations },
      actor.label,
      acknowledge ?? false,
    );

    return ok({ poId: params.id, lines: allocations.length, ...result });
  });
}
