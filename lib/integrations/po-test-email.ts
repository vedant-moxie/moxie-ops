import "server-only";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env, requireEnv } from "@/lib/env";
import { nextEmailRef } from "@/lib/services/email-ref-counter";
import { getPoEmailRecipients, getEmailRedirect, getEmailTemplate, DEFAULT_EMAIL_TEMPLATE, type EmailTemplate } from "@/lib/services/app-settings";

/** Escape HTML and turn newlines into <br> for safe insertion into the email body. */
function htmlLines(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

export interface PoPreparationEmailResult {
  messageId: string;
  to: string;
  cc?: string;
  /** The reference issued (or reused) for this email, e.g. "MB - 26/27 - 1458". */
  ref: string;
}

export interface PoEmailLine {
  sku: string;
  qty: number;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface PoEmailData {
  poNumber: string;
  channel: string;
  location: string;
  dispatchFrom: string;
  lines: PoEmailLine[];
  attachments?: EmailAttachment[];
  /** Operator-edited subject (free text). Defaults to the saved template subject.
   *  The reference number is tracked on the PO, not forced into the subject. */
  subjectOverride?: string;
  /** Reuse this exact reference verbatim instead of issuing a new one from the
   *  series (used when resending an email that already has a reference). */
  presetRef?: string;
  /** Override To recipients (skips settings lookup when provided). */
  to?: string[];
  /** Override CC recipients (skips settings lookup when provided). */
  cc?: string[];
  /** Editable copy (greeting/intro/signoff). Defaults to the saved template. */
  template?: EmailTemplate;
  /**
   * Operator-edited body HTML from the review modal. When present it's sent as the
   * email body verbatim (still under the test-mode banner) instead of rendering
   * from the template + lines. Recipients/subject/attachments are unaffected.
   */
  bodyHtmlOverride?: string;
}

/** Crude HTML→text for the plaintext alternative when a body override is used. */
function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>\s*<td[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildHtml(d: PoEmailData): string {
  const thBase = "padding:6px 10px;border:1px solid #ccc;";
  const skuTh = `${thBase}background:#F6E199;`;
  const qtyTh = `${thBase}background:#C6E0B4;`;
  const td = "padding:6px 10px;border:1px solid #ccc;";
  const t = d.template ?? DEFAULT_EMAIL_TEMPLATE;
  const rows = d.lines
    .map((l) => `<tr><td style="${td}">${l.sku}</td><td style="${td}">${l.qty}</td></tr>`)
    .join("\n");
  return `
<p>${htmlLines(t.greeting)}</p>
<p>${htmlLines(t.intro)}</p>
<table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
  <thead>
    <tr>
      <th style="${skuTh}">SKU</th>
      <th style="${qtyTh}">Qty</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<ul>
  <li>PO No. - ${d.poNumber}</li>
  <li>Location/WH: - ${d.location}</li>
  <li>Channel: ${d.channel}</li>
  <li>Dispatch From: ${d.dispatchFrom}</li>
</ul>
<p>--<br>${htmlLines(t.signoff)}</p>
`.trim();
}

function buildText(d: PoEmailData): string {
  const t = d.template ?? DEFAULT_EMAIL_TEMPLATE;
  const rows = d.lines.map((l) => `${l.sku} | ${l.qty}`).join("\n");
  return `${t.greeting}

${t.intro}

SKU | Qty
${rows}

- PO No. - ${d.poNumber}
- Location/WH: - ${d.location}
- Channel: ${d.channel}
- Dispatch From: ${d.dispatchFrom}

--
${t.signoff}`;
}

/**
 * One pooled Gmail SMTP connection reused across all sends, instead of opening a
 * fresh TCP/TLS connection per email (which under a bulk run made Gmail drop
 * sends). `pool` reuses connections; `rateLimit` paces sends so we never burst
 * Gmail. Created lazily on first send and kept for the process lifetime.
 */
let _transport: Transporter | null = null;
function getTransport(): Transporter {
  if (_transport) return _transport;
  const user = env.PO_TEST_EMAIL_SMTP_USER;
  const pass = env.PO_TEST_EMAIL_SMTP_PASS!.replace(/\s+/g, "");
  _transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    // ≤ 4 messages per second across the pool — gentle on Gmail's rate limits.
    rateDelta: 1000,
    rateLimit: 4,
  });
  return _transport;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send with bounded retry — Gmail occasionally drops a connection mid-batch; one
 *  transient failure shouldn't silently lose the email. */
async function sendWithRetry(
  transport: Transporter,
  mailOptions: Parameters<Transporter["sendMail"]>[0],
  attempts = 3,
): Promise<Awaited<ReturnType<Transporter["sendMail"]>>> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await transport.sendMail(mailOptions);
    } catch (err) {
      lastErr = err;
      console.warn(`[po-email] send attempt ${i + 1}/${attempts} failed:`, err instanceof Error ? err.message : err);
      if (i < attempts - 1) await sleep(700 * 2 ** i); // 0.7s, 1.4s
    }
  }
  throw lastErr;
}

export async function sendPoPreparationEmail(data: PoEmailData): Promise<PoPreparationEmailResult> {
  requireEnv("po-preparation-email", ["PO_TEST_EMAIL_SMTP_PASS"]);

  const user = env.PO_TEST_EMAIL_SMTP_USER;

  // Editable copy (subject/greeting/intro/signoff) — caller override else the saved template.
  if (!data.template) data = { ...data, template: await getEmailTemplate() };

  // Resolve recipients: use caller-supplied overrides, otherwise read from settings.
  const configured = await getPoEmailRecipients();
  const toList = data.to && data.to.length > 0 ? data.to : configured.to;
  const ccList = data.cc !== undefined ? data.cc : configured.cc;

  // Never send to nobody. Callers (buildAndSendPoEmail) withhold + flag before reaching
  // here; this is a hard backstop so a PO email can never silently misroute to a
  // fallback/personal inbox again.
  if (toList.length === 0) {
    throw new Error("NO_RECIPIENTS: refusing to send a PO email with no To recipients");
  }

  let toStr = toList.join(", ");
  let ccStr = ccList.join(", ");

  // Reference number: reuse the preset one (resend) or atomically issue the next from
  // the series (distinct per concurrent send). Also tracked on the PO by the caller.
  const ref = data.presetRef ?? (await nextEmailRef()).ref;

  // Subject defaults to this PO's reference number (how each PO is marked); the
  // operator can override it with free text per send in the preview.
  let subject = data.subjectOverride?.trim() || ref;

  // Test-mode sink: redirect everything to the test address; drop cc so nobody
  // else is mailed. Keep the intended recipients visible in the subject/body.
  const redirect = await getEmailRedirect();
  let testBanner = "";
  if (redirect) {
    const intended = `To: ${toStr || "(none)"}${ccStr ? ` · Cc: ${ccStr}` : ""}`;
    console.log(`[po-email] TEST MODE → redirecting "${subject}" [${ref}] (${intended}) to ${redirect}`);
    testBanner = `<div style="background:#fff7d6;border:1px solid #e6cf6a;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;color:#665200">🧪 <b>Test mode</b> — this email would normally go to → ${intended}</div>`;
    subject = `[TEST] ${subject}`;
    toStr = redirect;
    ccStr = "";
  }

  const transport = getTransport();
  const mailOptions: Parameters<typeof transport.sendMail>[0] = {
    from: `"Moxie Ops" <${user}>`,
    to: toStr,
    subject,
    html: testBanner + (data.bodyHtmlOverride ?? buildHtml(data)),
    text: data.bodyHtmlOverride ? htmlToText(data.bodyHtmlOverride) : buildText(data),
    attachments: data.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };
  if (ccStr) mailOptions.cc = ccStr;

  const info = await sendWithRetry(transport, mailOptions);

  return { messageId: info.messageId as string, to: toStr, cc: ccStr || undefined, ref };
}
