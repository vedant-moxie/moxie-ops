import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getTestEmailMode, setTestEmailMode } from "@/lib/services/app-settings";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  return handler("GET /api/settings/test-email", async () => {
    await requireAuth();
    return ok(await getTestEmailMode());
  });
}

export async function PUT(req: NextRequest) {
  return handler("PUT /api/settings/test-email", async () => {
    await requireAuth();
    const body = (await req.json()) as { enabled?: unknown; address?: unknown };
    const enabled = body.enabled === true;
    const address = typeof body.address === "string" ? body.address.trim() : "";

    // An address is required to turn it on — otherwise we'd silently swallow mail.
    if (enabled && !EMAIL_RE.test(address)) {
      return fail(new Error("Enter a valid test email address before enabling test mode"), 400);
    }
    await setTestEmailMode(enabled, address);
    return ok({ enabled, address });
  });
}
