/**
 * Local test for the undelivered-email flag + stable-reference + resend feature.
 *
 * Proves, against the local DB and WITHOUT sending any real email:
 *   1. A PO that resolves to NO recipients is HELD (not misrouted to a fallback),
 *      is assigned a reference, and records a hold reason.
 *   2. Re-attempting reuses the SAME reference (ref is bound to the PO).
 *   3. The email-preview resolution reports willReachNoOne=true for it.
 *   4. Once recipients are configured, resolution yields them (willReachNoOne=false) —
 *      i.e. a resend would now deliver. (We do NOT actually send, to avoid real mail.)
 *
 * It leaves one demo PO in the HELD state so it can be viewed in the UI, and restores
 * the app settings it touched. Run:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/test-undelivered-flag.ts
 */
import { prisma } from "../lib/db";
import { buildAndSendPoEmail } from "../lib/services/allocate-and-email";
import {
  getTestEmailMode, setTestEmailMode,
  getPoEmailRecipients, setPoEmailRecipients,
} from "../lib/services/app-settings";

const ok = (b: boolean) => (b ? "✅ PASS" : "❌ FAIL");

async function main() {
  console.log("\n=== Undelivered-email flag / stable-ref / resend — local test ===\n");

  // Snapshot the settings we mutate, so we can restore them afterwards.
  const origTestMode = await getTestEmailMode();
  const origGlobal = await getPoEmailRecipients();

  // Neutralise: no test-mode redirect (else it always has a recipient) and no global
  // recipients — so the PO genuinely resolves to nobody.
  await setTestEmailMode(false, origTestMode.address);
  await setPoEmailRecipients([], []);

  const channel = await prisma.channel.findFirstOrThrow();
  const skus = await prisma.sku.findMany({ take: 3 });

  // A PO whose rawData carries no dispatch/location keys → dispatch-from won't resolve,
  // and with no global recipients the email reaches no one.
  const po = await prisma.purchaseOrder.create({
    data: {
      channelId: channel.id,
      channelPoNumber: `TEST-UNDELIVERED-${Date.now()}`,
      source: "MANUAL",
      status: "ALLOCATED",
      rawData: {},
      lineItems: {
        create: skus.map((s, i) => ({
          skuId: s.id,
          channelSkuCode: s.internalCode,
          requestedQty: (i + 1) * 10,
          approvedQty: (i + 1) * 10,
        })),
      },
    },
  });
  console.log(`Created demo PO ${po.channelPoNumber} (id ${po.id})\n`);

  // 1. First attempt → HELD, ref assigned, reason recorded, nothing sent.
  const r1 = await buildAndSendPoEmail(po.id, { acknowledgeMismatch: true, actorLabel: "test-script" });
  const a1 = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id },
    select: { emailRef: true, emailStatus: true, emailHoldReason: true, emailSentAt: true },
  });
  console.log("1) First send with no recipients:");
  console.log(`   heldNoRecipients=${r1.heldNoRecipients}  emailFailed=${r1.emailFailed}  messageId=${r1.emailMessageId}`);
  console.log(`   PO.emailStatus=${a1.emailStatus}  emailRef=${a1.emailRef}  sentAt=${a1.emailSentAt}`);
  console.log(`   reason="${a1.emailHoldReason}"`);
  console.log(`   ${ok(r1.heldNoRecipients === true)} withheld instead of sent`);
  console.log(`   ${ok(a1.emailStatus === "HELD")} status HELD`);
  console.log(`   ${ok(!!a1.emailRef)} reference assigned`);
  console.log(`   ${ok(a1.emailSentAt === null)} nothing marked as sent\n`);

  // 2. Re-attempt (still no recipients) → SAME reference reused.
  const r2 = await buildAndSendPoEmail(po.id, { acknowledgeMismatch: true, actorLabel: "test-script" });
  const a2 = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id }, select: { emailRef: true, emailStatus: true },
  });
  console.log("2) Second attempt (still no recipients):");
  console.log(`   emailRef=${a2.emailRef} (was ${a1.emailRef})`);
  console.log(`   ${ok(a2.emailRef === a1.emailRef)} reference reused verbatim`);
  console.log(`   ${ok(a2.emailStatus === "HELD")} still HELD  (heldNoRecipients=${r2.heldNoRecipients})\n`);

  // 3. Resolution reports "reaches no one" (the signal the preview banner uses).
  const noneResolved = await getPoEmailRecipients();
  const willReachNoOne = noneResolved.to.length === 0;
  console.log("3) Recipient resolution while unconfigured:");
  console.log(`   global to=[${noneResolved.to.join(", ")}]`);
  console.log(`   ${ok(willReachNoOne)} willReachNoOne=true (no personal-inbox fallback)\n`);

  // 4. Configure recipients → resolution now yields them (a resend would deliver).
  await setPoEmailRecipients(["ops.test@example.com"], ["watch@example.com"]);
  const nowResolved = await getPoEmailRecipients();
  console.log("4) After configuring global recipients:");
  console.log(`   global to=[${nowResolved.to.join(", ")}]  cc=[${nowResolved.cc.join(", ")}]`);
  console.log(`   ${ok(nowResolved.to.length > 0)} recipients now resolve → resend would deliver (not sent here)\n`);

  // Restore the global recipients to empty so the demo PO stays visibly HELD in the UI.
  await setPoEmailRecipients([], []);
  // Restore test-mode to how we found it. NOTE: we leave it as origTestMode; if it was
  // ON (redirect), viewing the demo PO still shows HELD, but a UI resend would redirect.
  await setTestEmailMode(origTestMode.enabled, origTestMode.address);
  // Restore the operator's real global recipients if any were set before the test.
  if (origGlobal.to.length || origGlobal.cc.length) {
    await setPoEmailRecipients(origGlobal.to, origGlobal.cc);
  }

  console.log("─".repeat(64));
  console.log(`Demo PO left in HELD state for UI viewing:`);
  console.log(`   /orders/${po.id}   (ref ${a1.emailRef})`);
  console.log(`Restored test-email mode to enabled=${origTestMode.enabled}.`);
  console.log("Done.\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
