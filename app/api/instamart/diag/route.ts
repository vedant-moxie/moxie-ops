import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api";
import { getTokens } from "@/lib/integrations/instamart/auth";
import { InstamartClient } from "@/lib/integrations/instamart/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Diagnostic: probe a candidate Swiggy seller-portal endpoint with the live
 * Bearer token to discover/validate the PO-listing path. Returns status + body
 * so we can see exactly how the portal authorizes each path.
 *   GET /api/instamart/diag?path=/api/v1/.../purchase-orders&offset=0&limit=20
 * The whole query string (minus `path`) is forwarded to the probed endpoint.
 */
export async function GET(req: NextRequest) {
  return handler("GET /api/instamart/diag", async () => {
    const url = new URL(req.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return ok({
        hint: "pass ?path=<seller-portal path> (optionally with extra query params) to probe it with the live Bearer token",
      });
    }
    url.searchParams.delete("path");
    const forwarded = url.searchParams.toString();
    const target = forwarded ? `${path}${path.includes("?") ? "&" : "?"}${forwarded}` : path;

    const tokens = await getTokens(false);
    const client = new InstamartClient(tokens);
    const res = await client.probe(target);
    return ok({ target, ...res });
  });
}
