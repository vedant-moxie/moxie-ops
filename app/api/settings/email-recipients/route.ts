import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getPoEmailRecipients, setPoEmailRecipients } from "@/lib/services/app-settings";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  return handler("GET /api/settings/email-recipients", async () => {
    await requireAuth();
    const recipients = await getPoEmailRecipients();
    return ok(recipients);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PUT(req: NextRequest) {
  return handler("PUT /api/settings/email-recipients", async () => {
    await requireAuth();
    const body = await req.json() as { to: unknown; cc: unknown };
    const { to, cc } = body;
    if (!Array.isArray(to) || !Array.isArray(cc)) {
      return fail(new Error("to and cc must be arrays"), 400);
    }
    if ((to as string[]).length === 0) {
      return fail(new Error("At least one To recipient is required"), 400);
    }
    const invalid = ([...(to as string[]), ...(cc as string[])]).filter(
      (e) => typeof e !== "string" || !EMAIL_RE.test(e),
    );
    if (invalid.length) {
      return fail(new Error(`Invalid email(s): ${invalid.join(", ")}`), 400);
    }
    await setPoEmailRecipients(to as string[], cc as string[]);
    return ok({ to, cc });
  });
}
