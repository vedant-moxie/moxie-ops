import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getSeries, setSeries } from "@/lib/services/email-ref-counter";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    prefix: z.string().max(64).optional(),
    nextNumber: z.number().int().positive().optional(),
  })
  .refine((v) => v.prefix !== undefined || v.nextNumber !== undefined, {
    message: "Provide prefix and/or nextNumber",
  });

/** Current series config + the next number that will be issued. */
export async function GET() {
  return handler("GET /api/settings/email-series", async () => {
    await requireAuth();
    return ok(await getSeries());
  });
}

/** Update the allocation-email series prefix and/or the next number. */
export async function PUT(req: NextRequest) {
  return handler("PUT /api/settings/email-series", async () => {
    await requireAuth();
    const body = schema.parse(await req.json());
    return ok(await setSeries(body));
  });
}
