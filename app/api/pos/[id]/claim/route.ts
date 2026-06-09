import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { claimPo, releasePo } from "@/lib/services/po-claim";

export const dynamic = "force-dynamic";

/** Acquire the allocation claim for this PO (called when a user opens it). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/claim", async () => {
    const actor = await currentActor();
    const result = await claimPo(params.id, actor);
    return ok(result);
  });
}

/** Release the claim (called on cancel / navigate-away) — only if this actor holds it. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("DELETE /api/pos/[id]/claim", async () => {
    const actor = await currentActor();
    await releasePo(params.id, actor.id);
    return ok({ released: true });
  });
}
