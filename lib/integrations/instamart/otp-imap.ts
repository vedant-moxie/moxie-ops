import "server-only";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "@/lib/env";

export class OtpNotFoundError extends Error {}

/**
 * Pull the 6-digit code out of a Swiggy Instamart Ads Portal OTP email.
 * The reference template reads: "Your OTP for logging into the Swiggy Instamart
 * Ads Portal is: 123456" — but we degrade gracefully to any OTP-ish 6-digit run.
 */
function extractCode(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;
  // 1) the exact reference phrasing
  const exact = hay.match(/Swiggy Instamart Ads Portal[^0-9]{0,40}(\d{6})/i);
  if (exact?.[1]) return exact[1];
  // 2) digits immediately after an OTP-ish word (strongest generic signal)
  const near = hay.match(/(?:otp|code|passcode|verification|one[- ]?time)\D{0,24}(\d{4,8})/i);
  if (near?.[1]) return near[1];
  // 3) digits immediately before an OTP-ish word ("123456 is your code")
  const before = hay.match(/(\d{4,8})\D{0,24}(?:otp|code|passcode|verification)/i);
  if (before?.[1]) return before[1];
  // 4) fall back to a standalone 4–8 digit run that isn't a recent year
  const all = [...hay.matchAll(/\b(\d{4,8})\b/g)].map((m) => m[1]!);
  const notYear = all.filter((d) => !(d.length === 4 && Number(d) >= 2022 && Number(d) <= 2030));
  return notYear.find((d) => d.length === 6) ?? notYear.find((d) => d.length === 4) ?? notYear[0] ?? null;
}

/**
 * Poll the OTP inbox over IMAP (Gmail app password) for the Swiggy Instamart Ads
 * Portal login OTP and return the code. Searches messages since `sentAfter`,
 * newest first. Falls back to the shared Blinkit OTP credentials when the
 * Instamart-specific ones aren't set (same monitored inbox in practice).
 */
export async function waitForOtpImap(opts: {
  sentAfter: Date;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string> {
  const user = env.INSTAMART_OTP_EMAIL || env.INSTAMART_LOGIN_EMAIL || env.BLINKIT_OTP_EMAIL || env.BLINKIT_LOGIN_EMAIL;
  const pass = env.INSTAMART_OTP_APP_PASSWORD || env.BLINKIT_OTP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("[instamart] OTP IMAP not configured: set INSTAMART_LOGIN_EMAIL + INSTAMART_OTP_APP_PASSWORD");
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
        const uids = await client.search(
          { since: new Date(floor), or: [{ from: "swiggy" }, { subject: "Instamart" }, { subject: "otp" }, { subject: "verification" }] },
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
          const body = parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
          const code = extractCode(subject, body);
          const allDigits = [...`${subject}\n${body}`.matchAll(/\b\d{4,8}\b/g)].map((m) => m[0]);
          console.log(
            `[instamart:otp] candidate from="${from}" subject="${subject.slice(0, 80)}" ` +
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
  throw new OtpNotFoundError("No Swiggy Instamart OTP email found within the wait window");
}
