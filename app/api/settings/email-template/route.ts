import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getEmailTemplate, setEmailTemplate } from "@/lib/services/app-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return handler("GET /api/settings/email-template", async () => {
    await requireAuth();
    return ok(await getEmailTemplate());
  });
}

export async function PUT(req: NextRequest) {
  return handler("PUT /api/settings/email-template", async () => {
    await requireAuth();
    const b = (await req.json()) as { greeting?: unknown; intro?: unknown; signoff?: unknown };
    const greeting = typeof b.greeting === "string" ? b.greeting : "";
    const intro = typeof b.intro === "string" ? b.intro : "";
    const signoff = typeof b.signoff === "string" ? b.signoff : "";
    if (!greeting.trim() || !intro.trim() || !signoff.trim()) {
      return fail(new Error("Greeting, intro and signoff are all required"), 400);
    }
    await setEmailTemplate({ greeting, intro, signoff });
    return ok({ greeting: greeting.trim(), intro: intro.trim(), signoff: signoff.trimEnd() });
  });
}
