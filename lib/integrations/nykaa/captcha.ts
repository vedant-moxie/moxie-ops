import "server-only";
import { env } from "@/lib/env";

export class NykaaCaptchaError extends Error {}

/**
 * Solve the Nykaa seller-portal reCAPTCHA via 2captcha.
 *
 * Nykaa gates its login API (signIn / verifyTwoFaCode) behind an invisible
 * reCAPTCHA v2; both endpoints require an `x-recaptcha-token` header. There is
 * no way to mint that token server-to-server, so we delegate to 2captcha's
 * `userrecaptcha` solver: submit the sitekey + page URL, poll until a token is
 * returned, then hand it back to the caller to attach to the request.
 *
 * Ported from the standalone nykka-simulate login flow (the proven, working
 * auth). Requires TWOCAPTCHA_API_KEY; the sitekey/page URL come from env with
 * the captured defaults. The token is single-use and short-lived, so the auth
 * flow solves once per protected call (signIn and verify each get their own).
 */
export async function solveNykaaCaptcha(label = ""): Promise<string> {
  const key = env.TWOCAPTCHA_API_KEY;
  if (!key) {
    throw new NykaaCaptchaError(
      "TWOCAPTCHA_API_KEY not set — Nykaa login requires solving its reCAPTCHA. " +
        "Add a 2captcha API key to .env.local to enable Nykaa auth.",
    );
  }

  const sitekey = env.NYKAA_RECAPTCHA_SITEKEY;
  const pageUrl = env.NYKAA_LOGIN_PAGE;

  // Submit the captcha job.
  const submitUrl =
    `https://2captcha.com/in.php?key=${key}&method=userrecaptcha&invisible=1` +
    `&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
  const sub = (await fetch(submitUrl).then((r) => r.json())) as { status: number; request: string };
  if (sub.status !== 1) throw new NykaaCaptchaError(`2captcha submit failed${label}: ${sub.request}`);

  const id = sub.request;
  console.log(`[nykaa:captcha${label}] queued (id=${id}) — polling`);

  // Initial solve takes ~15-20s; poll for up to ~120s total.
  await new Promise((r) => setTimeout(r, 15_000));
  for (let i = 0; i < 21; i++) {
    const res = (await fetch(
      `https://2captcha.com/res.php?key=${key}&action=get&id=${id}&json=1`,
    ).then((r) => r.json())) as { status: number; request: string };
    if (res.status === 1) {
      console.log(`[nykaa:captcha${label}] token received`);
      return res.request;
    }
    if (res.request !== "CAPCHA_NOT_READY") {
      throw new NykaaCaptchaError(`2captcha error${label}: ${res.request}`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new NykaaCaptchaError(`2captcha timed out after ~120s${label}`);
}
