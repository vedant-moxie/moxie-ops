import { NextResponse } from "next/server";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, data }, init);
}

export function fail(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json({ success: false, error: message }, { status });
}

/** Wrap a route handler with try/catch + Clerk auth (when configured). */
export function handler(
  routeName: string,
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  return (async () => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[${routeName}]`, error);
      let status = 500;
      if (error instanceof Error) {
        if (error.message === "Unauthorized") status = 401;
        else if (error.name === "AdminRequiredError") status = 403;
      }
      return fail(error, status);
    }
  })();
}
