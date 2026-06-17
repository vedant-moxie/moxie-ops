import "server-only";
import nodemailer from "nodemailer";
import { env, requireEnv } from "@/lib/env";
import { nextEmailRef, getSeries } from "@/lib/services/email-ref-counter";
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
  /** If provided, overrides the default subject with `${PO_EMAIL_REF_PREFIX}${refNumber}`. */
  refNumber?: number;
  /** Override To recipients (skips settings lookup when provided). */
  to?: string[];
  /** Override CC recipients (skips settings lookup when provided). */
  cc?: string[];
  /** Editable copy (greeting/intro/signoff). Defaults to the saved template. */
  template?: EmailTemplate;
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

export async function sendPoPreparationEmail(data: PoEmailData): Promise<PoPreparationEmailResult> {
  requireEnv("po-preparation-email", ["PO_TEST_EMAIL_SMTP_PASS"]);

  const user = env.PO_TEST_EMAIL_SMTP_USER;
  const pass = env.PO_TEST_EMAIL_SMTP_PASS!.replace(/\s+/g, "");

  // Editable copy (greeting/intro/signoff) — caller override else the saved template.
  if (!data.template) data = { ...data, template: await getEmailTemplate() };

  // Resolve recipients: use caller-supplied overrides, otherwise read from settings
  const configured = await getPoEmailRecipients();
  const toList = data.to && data.to.length > 0 ? data.to : configured.to;
  const ccList = data.cc !== undefined ? data.cc : configured.cc;
  let toStr = toList.join(", ");
  let ccStr = ccList.join(", ");

  // Assign the next reference (atomic, distinct per concurrent send). The prefix is
  // the editable series prefix from the Counter, not the env default.
  let subject =
    data.refNumber != null
      ? `${(await getSeries()).prefix}${data.refNumber}`
      : (await nextEmailRef()).ref;

  // Test-mode sink: redirect everything to the test address; drop cc so nobody
  // else is mailed. Keep the intended recipients visible in the subject/body.
  const redirect = await getEmailRedirect();
  let testBanner = "";
  if (redirect) {
    const intended = `To: ${toStr || "(none)"}${ccStr ? ` · Cc: ${ccStr}` : ""}`;
    console.log(`[po-email] TEST MODE → redirecting "${subject}" (${intended}) to ${redirect}`);
    testBanner = `<div style="background:#fff7d6;border:1px solid #e6cf6a;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;color:#665200">🧪 <b>Test mode</b> — this email would normally go to → ${intended}</div>`;
    subject = `[TEST] ${subject}`;
    toStr = redirect;
    ccStr = "";
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const mailOptions: Parameters<typeof transport.sendMail>[0] = {
    from: `"Moxie Ops" <${user}>`,
    to: toStr,
    subject,
    html: testBanner + buildHtml(data),
    text: buildText(data),
    attachments: data.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };
  if (ccStr) mailOptions.cc = ccStr;

  const info = await transport.sendMail(mailOptions);

  return { messageId: info.messageId as string, to: toStr, cc: ccStr || undefined };
}
