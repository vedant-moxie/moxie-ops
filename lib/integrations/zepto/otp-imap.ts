import "server-only";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "@/lib/env";

export class OtpNotFoundError extends Error {}

/**
 * Extract the Zepto OTP from an email. Zepto OTPs are 4-digit (subject contains
 * "Email Otp", from mailer@zeptonow.com). We prefer digits adjacent to an
 * OTP-ish word and fall back to a standalone 4–8 digit run that isn't a year.
 * Mirrors the Blinkit extractor, which already handles 4-digit codes.
 */
function extractCode(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;
  // 1) digits immediately after an OTP-ish word (strongest signal)
  const near = hay.match(/(?:otp|code|passcode|verification|one[- ]?time)\D{0,24}(\d{4,8})/i);
  if (near?.[1]) return near[1];
  // 2) digits immediately before an OTP-ish word ("1234 is your code")
  const before = hay.match(/(\d{4,8})\D{0,24}(?:otp|code|passcode|verification)/i);
  if (before?.[1]) return before[1];
  // 3) fall back to a standalone 4–8 digit run that isn't a recent year
  const all = [...hay.matchAll(/\b(\d{4,8})\b/g)].map((m) => m[1]!);
  const notYear = all.filter((d) => !(d.length === 4 && Number(d) >= 2022 && Number(d) <= 2030));
  return notYear.find((d) => d.length === 4) ?? notYear.find((d) => d.length === 6) ?? notYear[0] ?? null;
}

/**
 * Poll the OTP inbox over IMAP (Gmail app password) for the Zepto OTP and return
 * the code. Searches messages since `sentAfter`, newest first. Mirrors
 * blinkit/otp-imap.ts but filters on Zepto's sender (mailer@zeptonow.com) and
 * the "Email Otp" subject.
 */
export async function waitForZeptoOtpImap(opts: {
  sentAfter: Date;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string> {
  const user = env.ZEPTO_OTP_EMAIL || env.ZEPTO_LOGIN_EMAIL;
  const pass = env.ZEPTO_OTP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("[zepto] OTP IMAP not configured: set ZEPTO_OTP_EMAIL (or ZEPTO_LOGIN_EMAIL) + ZEPTO_OTP_APP_PASSWORD");
  }

  const client = new ImapFlow({
    host: env.OTP_IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user, pass: pass.replace(/\s+/g, "") }, // app passwords are shown space-separated
    logger: false,
  });

  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const pollMs = opts.pollMs ?? 5_000;
  const floor = opts.sentAfter.getTime() - 60_000; // clock skew

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      while (Date.now() < deadline) {
        // IMAP SINCE is date-granular; we refine with internalDate below.
        // Search strictly for Zepto OTP emails. "Email Otp" is Zepto's exact subject.
        // Do NOT use the generic { subject: "otp" } — it matches Instamart OTP emails
        // ("Your Login OTP for Swiggy Instamart Ads Portal") and returns the wrong code.
        const uids = await client.search(
          { since: new Date(floor), or: [{ from: "zeptonow" }, { subject: "Email Otp" }] },
          { uid: true },
        );
        const candidates = Array.isArray(uids) ? uids.slice(-10).reverse() : [];
        for (const uid of candidates) {
          const msg = await client.fetchOne(String(uid), { source: true, internalDate: true, envelope: true }, { uid: true });
          if (!msg || !msg.source) continue;
          if (msg.internalDate && msg.internalDate.getTime() < floor) continue;
          const parsed = await simpleParser(msg.source);
          const subject = parsed.subject ?? msg.envelope?.subject ?? "";
          const from = parsed.from?.text ?? "";
          // Extra guard: skip Instamart OTP emails that leaked through.
          if (subject.toLowerCase().includes("swiggy") || subject.toLowerCase().includes("instamart")) continue;
          const body = parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
          const code = extractCode(subject, body);
          const allDigits = [...`${subject}\n${body}`.matchAll(/\b\d{4,8}\b/g)].map((m) => m[0]);
          console.log(
            `[zepto:otp] candidate from="${from}" subject="${subject.slice(0, 80)}" ` +
              `date=${msg.internalDate?.toISOString()} digits=[${allDigits.join(",")}] chosen=${code}`,
          );
          if (code) return code;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  throw new OtpNotFoundError("No Zepto OTP email found within the wait window");
}
