import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { getEmailRedirect } from "@/lib/services/app-settings";

let resend: Resend | null = null;
function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: { filename: string; content: Buffer }[];
  replyTo?: string;
}

/** Returns the provider message id, or null when Resend isn't configured. */
export async function sendEmail(params: SendEmailParams): Promise<string | null> {
  const client = getResend();
  if (!client) {
    console.log(`[resend] (skipped, not configured) → "${params.subject}" to`, params.to);
    return null;
  }

  // Test-mode sink: redirect everything to the test address; nobody else mailed.
  const redirect = await getEmailRedirect();
  let to = params.to;
  let subject = params.subject;
  let html = params.html ?? params.text ?? "";
  if (redirect) {
    const original = Array.isArray(params.to) ? params.to.join(", ") : params.to;
    console.log(`[resend] TEST MODE → redirecting "${params.subject}" (was → ${original}) to ${redirect}`);
    to = redirect;
    subject = `[TEST] ${params.subject}`;
    html = `<div style="background:#fff7d6;border:1px solid #e6cf6a;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;color:#665200">🧪 <b>Test mode</b> — this email would normally go to: <b>${original}</b></div>${html}`;
  }

  const { data, error } = await client.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to,
    subject,
    html,
    text: params.text,
    replyTo: params.replyTo,
    attachments: params.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
    })),
  });
  if (error) {
    console.error("[resend] send failed", error);
    throw new Error(error.message);
  }
  return data?.id ?? null;
}

// ── Templates ─────────────────────────────────────────────
const shell = (title: string, body: string) => `<!doctype html>
<html><body style="margin:0;background:#f5f1e6;font-family:Inter,Arial,sans-serif;color:#1a1a1a">
  <div style="max-width:640px;margin:0 auto;padding:32px">
    <div style="font-weight:800;letter-spacing:3px;font-size:18px;color:#1a1a1a">MOXIE</div>
    <div style="background:#fff;border-radius:16px;padding:28px;margin-top:16px;box-shadow:0 8px 24px -12px rgba(0,0,0,.12)">
      <h1 style="font-size:18px;margin:0 0 16px">${title}</h1>
      ${body}
    </div>
    <p style="color:#7a766a;font-size:12px;margin-top:16px">Moxie Beauty — Operations · This is an automated message.</p>
  </div>
</body></html>`;

export function warehouseInstructionEmail(input: {
  channelName: string;
  channelPoNumber: string;
  deliveryAddress: string;
  dispatchBy: string;
  dispatchFrom?: string;
  warehouseInstructionId: string;
  lines: { internalCode: string; skuName: string; qty: number; casePacks: number }[];
}): { subject: string; html: string; text: string } {
  const subject = `Dispatch Instruction — PO ${input.channelPoNumber} for ${input.channelName} — Due ${input.dispatchBy}`;
  const rows = input.lines
    .map(
      (l) => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;font-family:monospace">${l.internalCode}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${l.skuName}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${l.qty}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${l.casePacks}</td>
      </tr>`,
    )
    .join("");
  const html = shell(
    "Dispatch Instruction",
    `<p>Dear Warehouse Team,</p>
     <p>Please dispatch the following order:</p>
     <table style="margin:12px 0;font-size:14px"><tbody>
       <tr><td style="padding:2px 8px;color:#7a766a">Channel</td><td style="padding:2px 8px;font-weight:600">${input.channelName}</td></tr>
       <tr><td style="padding:2px 8px;color:#7a766a">PO Number</td><td style="padding:2px 8px;font-weight:600">${input.channelPoNumber}</td></tr>
       <tr><td style="padding:2px 8px;color:#7a766a">Delivery Address</td><td style="padding:2px 8px">${input.deliveryAddress}</td></tr>
       <tr><td style="padding:2px 8px;color:#7a766a">Dispatch By</td><td style="padding:2px 8px;font-weight:600">${input.dispatchBy}</td></tr>
       ${input.dispatchFrom ? `<tr><td style="padding:2px 8px;color:#7a766a">Dispatch From</td><td style="padding:2px 8px;font-weight:600">${input.dispatchFrom}</td></tr>` : ""}
     </tbody></table>
     <h3 style="font-size:14px;margin:16px 0 4px">Picking List</h3>
     <table style="width:100%;border-collapse:collapse;font-size:13px">
       <thead><tr style="text-align:left;color:#7a766a">
         <th style="padding:8px">SKU Code</th><th style="padding:8px">Product</th>
         <th style="padding:8px;text-align:right">Quantity</th><th style="padding:8px;text-align:right">Case Packs</th>
       </tr></thead><tbody>${rows}</tbody>
     </table>
     <p style="margin-top:16px">Please reply to this email confirming dispatch with AWB number and actual quantities per SKU.</p>
     <p style="color:#7a766a;font-size:12px">Reference ID: ${input.warehouseInstructionId}</p>`,
  );
  const text = `Dispatch Instruction — PO ${input.channelPoNumber} (${input.channelName})
Delivery: ${input.deliveryAddress}
Dispatch By: ${input.dispatchBy}${input.dispatchFrom ? `\nDispatch From: ${input.dispatchFrom}` : ""}

${input.lines.map((l) => `${l.internalCode}  ${l.skuName}  qty ${l.qty} (${l.casePacks} case packs)`).join("\n")}

Reply confirming dispatch with AWB number and actual quantities.
Reference ID: ${input.warehouseInstructionId}`;
  return { subject, html, text };
}

export function grnReminderEmail(input: {
  channelName: string;
  channelPoNumber: string;
  deliveredAt: string;
}): { subject: string; html: string } {
  return {
    subject: `GRN Reminder — PO ${input.channelPoNumber}`,
    html: shell(
      "Pending GRN",
      `<p>Hello ${input.channelName} team,</p>
       <p>PO <strong>${input.channelPoNumber}</strong> was delivered on <strong>${input.deliveredAt}</strong>,
       but we have not yet received the corresponding Goods Received Note (GRN).</p>
       <p>Kindly share the GRN at your earliest convenience so we can close the order and raise the invoice.</p>`,
    ),
  };
}
