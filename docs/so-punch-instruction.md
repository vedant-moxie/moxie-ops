# Sales Order punch — how to enter a PO into the WMS

**For:** warehouse team (NCR / MUM / BLR) · **From:** Moxie ops
**Why:** the portal now cross-checks every punched SO against the approved PO,
SKU-wise. Following these three rules means your punch passes the check first time.

---

## English

1. **Punch the SO the same working day the PO-preparation email arrives.**
   After 24 hours with no SO, the PO is flagged "Missing SO" and ops is notified.

2. **Put both numbers on the sales order.** Both are in the email:
   - `order_no` (Order No.) ← **channel PO number**, e.g. `BLK-PO-99812`
   - `salesorder_ref_no` (Reference No.) ← **MB reference**, e.g. `MB - 26/27 - 1458`

   An SO with only one of the two is flagged "PO ref missing" — the quantities may be
   right, but nobody can trace the SO back to the PO.

3. **Use our internal SKU codes, exactly as in the email table** — `GCS200`, `DRM300`,
   `HRHM100`. Not the channel's code, not the barcode.

4. **Quantities must equal the approved quantity per SKU** — the number in the
   *Approved* column of the email, not what the channel originally asked for.

### Things that are fine

- **Splitting one PO across several SOs** — the check adds them up. Just put both
  reference numbers on every one of them.
- **Fixing a wrong SO in the WMS** — the check re-runs hourly and the flag clears by
  itself. No need to tell anyone.

### Things that cause a problem

- **Punching the same PO twice** → stock gets double-blocked and the PO is flagged
  "Duplicate SO". If you punched twice by mistake, delete the extra SO in the WMS.
- **Typing the quantity the channel asked for** instead of the approved quantity.

---

## हिंदी

1. **PO का email जिस दिन आए, उसी working day SO punch करें.** 24 घंटे तक SO न हो तो
   PO पर "Missing SO" flag लग जाता है और ops को पता चल जाता है.

2. **Sales order पर दोनों number डालें.** दोनों email में दिए होते हैं:
   - `order_no` (Order No.) ← **channel का PO number**, जैसे `BLK-PO-99812`
   - `salesorder_ref_no` (Reference No.) ← **MB reference**, जैसे `MB - 26/27 - 1458`

   सिर्फ़ एक number डालने पर "PO ref missing" flag लगेगा — quantity सही हो सकती है,
   पर SO को PO से जोड़ा नहीं जा सकता.

3. **SKU code हमारा internal code ही लिखें, email की table में जैसा है वैसा** —
   `GCS200`, `DRM300`, `HRHM100`. Channel का code या barcode नहीं.

4. **Quantity हर SKU की approved quantity के बराबर होनी चाहिए** — email के *Approved*
   column का number, channel ने जो माँगा था वो नहीं.

### ये करना ठीक है

- **एक PO को कई SO में बाँटना** — check जोड़ लेता है. बस हर SO पर दोनों reference
  number डालना ज़रूरी है.
- **WMS में ग़लत SO ठीक करना** — check हर घंटे चलता है, flag अपने आप हट जाएगा.
  किसी को बताने की ज़रूरत नहीं.

### इनसे दिक़्क़त होती है

- **एक ही PO दो बार punch करना** → stock दो बार block हो जाता है और "Duplicate SO"
  flag लगता है. ग़लती से दो बार हो गया हो तो WMS में extra SO delete कर दें.
- **Channel की माँगी हुई quantity** डाल देना, approved quantity की जगह.

---

## What ops sees

Portal → **SO Entry Check** — every approved PO with its approved quantity next to the
punched quantity, SKU-wise, and one of these flags:

| Flag | Meaning |
| --- | --- |
| Matched | SO matches the PO to the unit |
| Qty mismatch | punched quantities differ from approved |
| Duplicate SO | punched more than once — stock double-blocked |
| Missing SO | no SO punched, past the 24h window |
| PO ref missing | quantities fine, one of the two reference numbers absent |

Flags clear automatically on the next hourly run once the SO is corrected in the WMS.

| SO found | SO is punched and traceable, but hasn't dispatched yet — quantities are checked once it ships |

**On timing:** missing SOs, references and duplicates are checked **every hour**.
Quantities are read from the WMS Outward LOI Report, which only lists dispatched orders,
so the SKU-wise quantity match lands on the **daily** pass after the SO ships. Until then
the row shows "SO found".
