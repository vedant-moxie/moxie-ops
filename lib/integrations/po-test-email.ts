import "server-only";
import nodemailer from "nodemailer";
import { env, requireEnv } from "@/lib/env";
import { nextEmailRef, getSeries } from "@/lib/services/email-ref-counter";
import { getPoEmailRecipients } from "@/lib/services/app-settings";

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
}

function buildHtml(d: PoEmailData): string {
  const thBase = "padding:6px 10px;border:1px solid #ccc;";
  const skuTh = `${thBase}background:#F6E199;`;
  const qtyTh = `${thBase}background:#C6E0B4;`;
  const td = "padding:6px 10px;border:1px solid #ccc;";
  const rows = d.lines
    .map((l) => `<tr><td style="${td}">${l.sku}</td><td style="${td}">${l.qty}</td></tr>`)
    .join("\n");
  return `
<p>Hi Team,</p>
<p>Please prepare the mention PO:-</p>
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
<p>--<br>Regards,<br>Rishabh Kumar.</p>
`.trim();
}

function buildText(d: PoEmailData): string {
  const rows = d.lines.map((l) => `${l.sku} | ${l.qty}`).join("\n");
  return `Hi Team,

Please prepare the mention PO:-

SKU | Qty
${rows}

- PO No. - ${d.poNumber}
- Location/WH: - ${d.location}
- Channel: ${d.channel}
- Dispatch From: ${d.dispatchFrom}

--
Regards,
Rishabh Kumar.`;
}

export async function sendPoPreparationEmail(data: PoEmailData): Promise<PoPreparationEmailResult> {
  requireEnv("po-preparation-email", ["PO_TEST_EMAIL_SMTP_PASS"]);

  const user = env.PO_TEST_EMAIL_SMTP_USER;
  const pass = env.PO_TEST_EMAIL_SMTP_PASS!.replace(/\s+/g, "");

  // Resolve recipients: use caller-supplied overrides, otherwise read from settings
  const configured = await getPoEmailRecipients();
  const toList = data.to && data.to.length > 0 ? data.to : configured.to;
  const ccList = data.cc !== undefined ? data.cc : configured.cc;
  const toStr = toList.join(", ");
  const ccStr = ccList.join(", ");

  // Assign the next reference (atomic, distinct per concurrent send). The prefix is
  // the editable series prefix from the Counter, not the env default.
  const subject =
    data.refNumber != null
      ? `${(await getSeries()).prefix}${data.refNumber}`
      : (await nextEmailRef()).ref;

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
    html: buildHtml(data),
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
