import "server-only";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "@/lib/env";

export class OtpNotFoundError extends Error {}

/**
 * Extract the Nykaa OTP from an email. Nykaa sends a 6-digit verification code
 * from noreply@nykaa.com with the subject "Verification Code to Login into your
 * Nykaa account". We prefer digits adjacent to an OTP-ish word and fall back to
 * a standalone 4–8 digit run that isn't a recent year. Mirrors the Zepto/Blinkit
 * extractors.
 */
function extractCode(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;
  // 1) digits immediately after an OTP-ish word (strongest signal)
  const near = hay.match(/(?:otp|code|passcode|verification|one[- ]?time)\D{0,24}(\d{4,8})/i);
  if (near?.[1]) return near[1];
  // 2) digits immediately before an OTP-ish word ("123456 is your code")
  const before = hay.match(/(\d{4,8})\D{0,24}(?:otp|code|passcode|verification)/i);
  if (before?.[1]) return before[1];
  // 3) fall back to a standalone 4–8 digit run that isn't a recent year
  const all = [...hay.matchAll(/\b(\d{4,8})\b/g)].map((m) => m[1]!);
  const notYear = all.filter((d) => !(d.length === 4 && Number(d) >= 2022 && Number(d) <= 2030));
  return notYear.find((d) => d.length === 6) ?? notYear.find((d) => d.length === 4) ?? notYear[0] ?? null;
}

/**
 * Poll the OTP inbox over IMAP (Gmail app password) for the Nykaa OTP and return
 * the code. Searches messages since `sentAfter`, newest first. Mirrors
 * zepto/otp-imap.ts but filters on Nykaa's sender (noreply@nykaa.com) and the
 * "Verification Code" subject.
 */
export async function waitForNykaaOtpImap(opts: {
  sentAfter: Date;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string> {
  const user = env.NYKAA_OTP_EMAIL || env.NYKAA_LOGIN_EMAIL;
  const pass = env.NYKAA_OTP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "[nykaa] OTP IMAP not configured: set NYKAA_OTP_EMAIL (or NYKAA_LOGIN_EMAIL) + NYKAA_OTP_APP_PASSWORD",
    );
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
        // "Verification Code" is Nykaa's exact subject; nykaa matches the sender.
        const uids = await client.search(
          { since: new Date(floor), or: [{ from: "nykaa" }, { subject: "Verification Code" }] },
          { uid: true },
        );
        const candidates = Array.isArray(uids) ? uids.slice(-10).reverse() : [];
        for (const uid of candidates) {
          const msg = await client.fetchOne(
            String(uid),
            { source: true, internalDate: true, envelope: true },
            { uid: true },
          );
          if (!msg || !msg.source) continue;
          if (msg.internalDate && msg.internalDate.getTime() < floor) continue;
          const parsed = await simpleParser(msg.source);
          const subject = parsed.subject ?? msg.envelope?.subject ?? "";
          const from = parsed.from?.text ?? "";
          // Guard: skip OTP emails from other portals that share this inbox.
          const lowFrom = from.toLowerCase();
          if (lowFrom.includes("zepto") || lowFrom.includes("swiggy") || lowFrom.includes("blinkit")) continue;
          const body = parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
          const code = extractCode(subject, body);
          const allDigits = [...`${subject}\n${body}`.matchAll(/\b\d{4,8}\b/g)].map((m) => m[0]);
          console.log(
            `[nykaa:otp] candidate from="${from}" subject="${subject.slice(0, 80)}" ` +
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
  throw new OtpNotFoundError("No Nykaa OTP email found within the wait window");
}
