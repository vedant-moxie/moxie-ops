import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getPoEmailRecipients,
  setPoEmailRecipients,
  getLocationRecipientsMap,
  setLocationRecipients,
  DISPATCH_LOCATIONS,
  type RecipientEntry,
} from "@/lib/services/app-settings";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: NextRequest) {
  return handler("GET /api/settings/email-recipients", async () => {
    await requireAuth();
    const location = new URL(req.url).searchParams.get("location");
    if (location) {
      const map = await getLocationRecipientsMap();
      return ok(map[location] ?? { to: [], cc: [] });
    }
    const recipients = await getPoEmailRecipients();
    return ok(recipients);
  });
}

function normalizeEntries(raw: unknown): RecipientEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      name: typeof (e as RecipientEntry)?.name === "string" ? (e as RecipientEntry).name.trim() : "",
      email: typeof (e as RecipientEntry)?.email === "string" ? (e as RecipientEntry).email.trim() : "",
    }))
    .filter((e) => e.name || e.email);
}

export async function PUT(req: NextRequest) {
  return handler("PUT /api/settings/email-recipients", async () => {
    await requireAuth();
    const location = new URL(req.url).searchParams.get("location");
    const body = (await req.json()) as { to: unknown; cc: unknown };

    // ── Per-location recipients: entries are { name, email } ──────────────────
    if (location) {
      if (!(DISPATCH_LOCATIONS as readonly string[]).includes(location)) {
        return fail(new Error(`Unknown dispatch location: ${location}`), 400);
      }
      const to = normalizeEntries(body.to);
      const cc = normalizeEntries(body.cc);
      if (to.length === 0) {
        return fail(new Error("At least one To recipient is required"), 400);
      }
      const invalid = [...to, ...cc].filter((e) => !EMAIL_RE.test(e.email));
      if (invalid.length) {
        return fail(new Error(`Invalid email(s): ${invalid.map((e) => e.email || "(blank)").join(", ")}`), 400);
      }
      await setLocationRecipients(location, to, cc);
      return ok({ location, to, cc });
    }

    // ── Global fallback recipients (op-39): plain email strings ───────────────
    const { to, cc } = body;
    if (!Array.isArray(to) || !Array.isArray(cc)) {
      return fail(new Error("to and cc must be arrays"), 400);
    }
    if ((to as string[]).length === 0) {
      return fail(new Error("At least one To recipient is required"), 400);
    }
    const invalid = [...(to as string[]), ...(cc as string[])].filter(
      (e) => typeof e !== "string" || !EMAIL_RE.test(e),
    );
    if (invalid.length) {
      return fail(new Error(`Invalid email(s): ${invalid.join(", ")}`), 400);
    }
    await setPoEmailRecipients(to as string[], cc as string[]);
    return ok({ to, cc });
  });
}
