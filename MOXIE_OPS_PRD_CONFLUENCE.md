# Moxie Ops — Product Requirements Document
### D2C Operations Management System · Internal PRD · June 2026

---

## 🔖 CONFLUENCE DESIGN BRIEF
*This section is for the author. Remove before publishing.*

**Page layout approach:**
- Use Confluence's "Columns" macro to create a 2-column layout for the Architecture section
- Use "Info / Note / Warning" panels (coloured callout boxes) to highlight key facts
- Use "Expand" macros to collapse the dense tech stack table on first view
- Use "Divider" macros between major sections
- Paste the architecture diagram as an image (export from any diagram tool)
- Use "Status" lozenge macros for labels like LIVE, IN PROGRESS, PLANNED
- Page banner: use a warm cream (#FDF6EE) background, lime accent (#C8FF00) for the title bar
- Font: Use "Display" heading style for H1, "Heading 2" for section headers

**Color palette for diagrams:**
- Background: #FDF6EE (warm cream)
- Primary accent: #C8FF00 (Moxie lime)
- Ink/text: #1A1A1A
- Cards/surfaces: #FFFFFF with shadow
- Muted: #6B7280

---

# Moxie Ops: D2C Operations Management System

**Status:** `LIVE — Production`  
**Owner:** Engineering / Ops  
**Version:** 1.0  
**Last Updated:** June 2026

---

## 1. Motivation

> *"Before this system, every purchase order was an email, every allocation was a WhatsApp message, and every reconciliation was a spreadsheet cell someone could have edited by accident."*

### 1.1 The Problem We Were Solving

Moxie Beauty sells through multiple quick-commerce and e-commerce channel partners — Nykaa, Blinkit, Instamart, Zepto, and Tira. Each of these partners sends **Purchase Orders (POs)** via email, portal, or CSV export. The ops team was:

- Reading POs from Gmail, copy-pasting quantities into a spreadsheet
- Cross-checking inventory availability manually from another spreadsheet
- Emailing the warehouse a picking list as a typed document
- Waiting for a GRN (Goods Received Note) email from the channel, then diffing it line by line against what was dispatched
- Raising debit notes as Word documents when shortages were found
- Generating tax invoices manually per shipment
- Reporting fill rates and dispatch TAT using pivot tables, refreshed every Monday

This process was error-prone, slow, and impossible to audit. A single mis-typed quantity, a missed GRN email, or a forgotten debit note meant revenue leakage. As order volumes grew across 5+ channels, the spreadsheet workflow was simply not going to scale.

### 1.2 What We Set Out to Build

A **single, auditable, automated operations platform** that:
- Ingests POs from every channel automatically (email, portals, API)
- Uses AI to parse unstructured email content into structured records
- Shows the ops team a prioritised, live dashboard of what needs action
- Calculates inventory availability in real-time and suggests allocations
- Sends warehouse instructions and tracks dispatch and delivery
- Reconciles GRNs automatically against dispatched quantities with tolerance rules
- Raises debit notes as PDFs and emails them to the channel
- Generates tax-compliant invoices
- Tracks all of this in a live analytics layer

The system **replaces email + spreadsheet** with a structured, role-aware, fully auditable operations tool.

---

## 2. Solution Overview

Moxie Ops covers the **full order-to-cash lifecycle** for every channel partner:

```
Channel Partner
     │
     │  PO (email / portal / CSV / API)
     ▼
[PO Ingestion] ──AI Parse──► [PO Review & Prioritisation]
                                         │
                                         ▼
                              [Inventory Allocation]
                              ATP check · AI suggest · approve
                                         │
                                         ▼
                              [Warehouse Instruction]
                              Auto-email picking list
                                         │
                                         ▼
                              [Dispatch Record]
                              Log actual shipped quantities
                                         │
                                         ▼
                              [Delivery Confirmation]
                                         │
                                         ▼
                              [GRN Reconciliation]
                              2% tolerance · shortages detected
                                         │
                              ┌──────────┴──────────┐
                         Accepted               Discrepancy
                              │                      │
                              ▼                      ▼
                         [Invoice]           [Debit Note]
                         PDF → S3 → Email   PDF → S3 → Email
```

### 2.1 Key Modules

**Dashboard** — A prioritised, real-time view of all open POs. Priority scores are AI-computed. Ops team sees what needs action first, with inline editing.

**Allocation** — A spreadsheet-style grid where the ops team can see requested quantities per SKU, available ATP (from live Google Sheets inventory), AI-suggested allocation quantities, and case-pack constraints. One click sends the warehouse instruction.

**Orders** — Full lifecycle timeline per PO: ingestion → allocation → dispatch → delivery → GRN → invoice. Every state change is logged.

**GRN** — Goods Received Notes ingested via three channels: email (Gmail), portal scraping (Playwright), or manual CSV upload. System diffs them against dispatched quantities.

**Reconciliation** — When GRN quantity < dispatched quantity (outside 2% tolerance), a discrepancy is raised. Ops team can accept the shortage (auto-debit-note) or dispute it.

**Analytics** — Fill rate per channel, dispatch TAT, GRN acceptance rate, volume trends. All computed from the DB, not spreadsheets.

**Settings** — Channel configuration, SKU master management, inventory mappings, warehouse email templates.

---

## 3. System Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (Next.js App Router)                                         │
│  Server Components (direct DB reads via lib/data)                     │
│  Client Components ("use client") → fetch() to API                   │
└──────────────┬────────────────────────┬──────────────────────────────┘
               │ RSC: direct import     │ Client: HTTP fetch
               ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  API LAYER  /api/*                                                    │
│  REST routes — pos, allocations, grn, inventory, analytics            │
│  Cron routes — poll-emails · check-timers · scrape-portals            │
│  Pattern: Zod validate → auth check → service call → response         │
└──────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SERVICES  lib/services/                                              │
│  Business logic: reconcile · email-processor · analytics · audit      │
│  Channel sync: nykaa-sync · blinkit-sync · zepto-sync · tira-sync     │
│  SKU resolution, taxable validation, fill-rate computation             │
└──────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  INTEGRATIONS  lib/integrations/                                      │
│  Gmail · Sheets · Claude AI · Resend · Twilio · S3 · Playwright · PDF │
│  Channel clients: Blinkit API · Nykaa portal · Instamart · Zepto      │
│  WMS client · PDF generation · Audit log                              │
└──────────────────────────────┬──────────────────────────────────────┘
                                ▼
         ┌──────────────────────────────────────────┐
         │  PostgreSQL (Prisma)   Google Sheets       │
         │  + S3 (PDF/docs)       + Gmail             │
         └──────────────────────────────────────────┘
```

### 3.2 Key Architectural Decisions

**Server-only boundary** — Every service, data, and integration module starts with `import "server-only"`. This is a compile-time guarantee: no secrets, no Prisma client, no Node.js SDKs can ever be bundled into the browser.

**Layered separation** — Frontend → API → Services → Integrations → DB. Each layer only depends on layers below. Client components never touch the DB; they call API routes.

**Graceful degradation** — Integration clients (Gmail, Sheets, Claude, Resend, etc.) fail-safe: if their env vars are missing, they log a warning and no-op. The app boots and is fully browsable without every credential.

**Idempotency everywhere** — POs ingested from email use `gmailMessageId` as a unique key. Channel imports use `externalId`. Cron-triggered ingestion can run multiple times safely.

**Audit log** — Every state transition (PO status change, allocation approval, debit note raised) is appended to an immutable audit table with actor, timestamp, and diff.

**Multi-user allocation lock** — When two ops staff try to allocate the same PO simultaneously, a `claimedById` / `claimedAt` lock prevents double-allocation. The lock has a TTL and auto-releases.

### 3.3 Cron Architecture

| Cron Job | Schedule | What it Does |
|---|---|---|
| `/api/cron/poll-emails` | Every 10 min | Reads Gmail → Claude parses → creates POs / GRNs / dispatch records |
| `/api/cron/check-timers` | Hourly | GRN reminders, discrepancy escalation, 7 AM daily digest |
| `/api/cron/scrape-portals` | 9 AM & 5 PM | Playwright scrapes Nykaa/Blinkit portals for GRNs |

All cron routes are protected by `Authorization: Bearer $CRON_SECRET`.

### 3.4 Channel Ingestion Paths

Each channel has its own ingestion path:

| Channel | PO Source | GRN Source |
|---|---|---|
| **Nykaa** | Email (Claude parse) + Portal crawl | Email + Portal scrape (Playwright) |
| **Blinkit** | CSV import + API sync | Email + Portal |
| **Instamart** | Email | Email + Manual upload |
| **Zepto** | Email (Claude parse) | Email |
| **Tira** | API ingest (collector route) | API sync |

### 3.5 Nykaa Portal Crawler (Sub-system)

A separate Node.js sub-system (`nykaa-simulate/`) handles automated Nykaa portal access:
- Playwright for headless browser automation
- Gmail API for OTP reading during login
- GCP ingestion for scraped data
- Runs as a GitHub Actions cron (`.github/workflows/cron.yml`)
- Downloads scheduled CSV reports from Nykaa's seller portal API

---

## 4. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Framework** | Next.js 14 (App Router, TypeScript strict) | Full-stack, RSC for fast dashboards, API routes in same project |
| **Styling** | Tailwind CSS + shadcn/ui (customised) | Rapid iteration, consistent design system |
| **Database** | PostgreSQL via Prisma ORM | Relational model fits PO lifecycle; Prisma for type-safe queries |
| **AI / Parsing** | Anthropic Claude (`claude-opus-4-6`) | Structured extraction from unstructured PO/GRN emails; priority scoring |
| **Email Read** | Google Gmail API (OAuth2) | Real-time PO/GRN ingestion from ops Gmail inbox |
| **Inventory** | Google Sheets API | ATP (Available To Promise) lives in a Sheets workbook ops team already uses |
| **Email Send** | Resend | Transactional email for warehouse instructions, debit notes, invoices |
| **Alerts** | Twilio WhatsApp Business API | Real-time ops alerts to team WhatsApp group |
| **File Storage** | AWS S3 | Stores generated PDFs (debit notes, invoices, picking lists) |
| **PDF Generation** | PDFKit | Server-side PDF generation for all documents |
| **Portal Scraping** | Playwright | Wired to `scrape-portals` cron; generic selectors — channel-specific tuning needed |
| **Portal Evasion** | camoufox-js | Only in the standalone `nykaa-simulate/` subfolder; not used in the main app |
| **Validation** | Zod | Schema validation at API boundary + env var validation at boot |
| **Auth** | Clerk | Installed; runs in demo mode (all users = admin) until Clerk env vars are supplied |
| **Scheduling** | Vercel Cron Jobs | 6 crons defined in `vercel.json`, all route handlers live |
| **Deployment** | Vercel | Zero-config deploys, cron support, edge network |
| **OTP Automation** | IMAP + Gmail app password | Per-channel IMAP readers (Blinkit, Zepto, Instamart); requires `*_OTP_APP_PASSWORD` env vars |
| **WMS Integration** | REST client (`lib/integrations/wms.ts`) | Auth + `pushSalesOrder` + stock sync cron written; needs `WMS_EMAIL` / `WMS_PASSWORD` to activate |

---

## 5. Data Model (Key Entities)

The database has 21 models. The most important:

**Channel** — A partner (Nykaa, Blinkit, etc.) with config: fill rate commitment, SLA hours, billing GSTIN, portal credentials, ingestion mode.

**Sku / SkuMaster** — Internal SKU registry + per-channel SKU codes. SkuMaster is the single source of truth for code mappings (e.g. our `GCS200` = Blinkit code `BLINK-XYZ`) and per-channel taxable values.

**PurchaseOrder** — Core entity. Tracks: channel, source (EMAIL / BLINKIT / NYKAA / PORTAL / MANUAL), priority score, allocation lock, raw email body. Full status lifecycle:
`PENDING_REVIEW → PRIORITISED → ALLOCATED → APPROVED → DISPATCHED → DELIVERED → GRN_RECEIVED → CLOSED`
With side states: `DISCREPANCY` (GRN mismatch flagged) and `ON_HOLD`.

**PoLineItem → DispatchLineItem → GrnLineItem** — The three-way quantity chain. Each PO line has a requested qty; dispatch has actual shipped qty; GRN has partner-confirmed received qty.

**Discrepancy** — Raised when GRN qty deviates from dispatch qty beyond 2% tolerance. Full states: `OPEN → ACCEPTED / DEBIT_NOTE_RAISED / DISPUTED / RESOLVED`.

**Invoice** — DB record with S3 key, linked to both PO and GRN. Generated as a PDF and emailed on reconciliation. Note: there is no separate `DebitNote` model — debit notes are generated as PDFs (stored in S3 and emailed) but tracked only via the `DEBIT_NOTE_RAISED` status on the Discrepancy record, not as a separate DB entity.

**Supporting models (not mentioned above but present):** `WarehouseInstruction`, `DispatchRecord`, `DeliveryRecord`, `InventorySnapshot`, `WarehouseStock` (WMS mirror), `SkuItemMapping` (AI-resolved WMS code mapping), `Counter` (PO reference number series), `IntegrationToken` (channel OAuth tokens), `ProcessedEmail` (idempotency log for inbound emails).

**AuditLog** — Append-only table. Every action is logged with actor, entity, before/after state.

---

## 6. Current Problems & Limitations

### 6.1 Portal Scraping — Generic Selectors Don't Work 🔴 High Priority
The `scrape-portals` cron is wired and runs, but `lib/integrations/playwright.ts` uses fully generic role-based selectors (`getByRole("row")`, `getByRole("cell")`) that don't match the actual HTML of any real partner portal. It will return empty arrays for every channel until channel-specific selectors are implemented. The Nykaa crawler in `nykaa-simulate/` uses camoufox for fingerprint evasion, but that is a separate standalone project and not connected to the main app.

**Impact:** Portal-sourced GRNs are silently missed. The system falls back entirely to email-based GRN ingestion.

### 6.2 Email Parsing Edge Cases 🟡 Medium Priority
Claude parses PO emails very well for standard formats, but channel partners occasionally send non-standard formats (e.g. PDF attachments with tables, Excel attachments). The current parser handles inline email text and standard PDF layouts but can misparse:
- Multi-page PDFs with spanning tables
- Emails forwarded with quoted chains
- POs that reference a "change" vs. "new order" without explicit markers

**Impact:** Wrong quantities ingested, requiring manual correction.

### 6.3 Inventory Source Dependency 🟡 Medium Priority
ATP (Available To Promise) currently pulls from a Google Sheet maintained by the warehouse team. This is one sync cycle behind reality — when the warehouse ships an order, the Sheet is updated manually. There's no real-time hook.

**Impact:** Occasional over-allocation when two POs are allocated in quick succession.

### 6.4 Multi-User Concurrency Gaps 🟡 Medium Priority
The allocation lock (PO claim) prevents double-allocation of the same PO, but there's no protection against two users allocating different POs against the same SKU stock simultaneously. The ATP check is optimistic.

**Impact:** Rare but possible: total allocated qty for a SKU across multiple POs can exceed actual ATP.

### 6.5 No Channel API for Nykaa/Zepto POs 🟡 Medium Priority
Nykaa and Zepto do not expose a PO API — POs arrive only via email or portal. This makes the ingestion path fundamentally dependent on email delivery and portal availability. Any Gmail API outage or portal UI change directly impacts PO ingestion.

**Impact:** Operational dependency on third-party email and portal uptime.

### 6.6 WMS Integration — Credentials Not Configured 🔴 High Priority
`lib/integrations/wms.ts` is fully written — auth, `pushSalesOrder`, stock sync — and the `wms-stock-sync` cron runs every 15 minutes. However it all gates on `WMS_EMAIL` and `WMS_PASSWORD` env vars which are not set. Without credentials, `wmsConfigured()` returns false and every WMS call silently no-ops. The warehouse still receives instructions as formatted emails, not structured API pushes.

**Impact:** Stock levels are not being synced from WMS. Warehouse instructions are email-only with no machine-readable confirmation of dispatch.

### 6.7 Tira Integration Early Stage 🟢 Low Priority
Tira (Reliance's beauty platform) was added recently. The ingest and sync services exist but the channel has lower volume and some edge cases in their data format are unhandled.

---

## 7. Future Work

### 7.1 Full WMS API Integration 🔴 Planned Q3 2026
Replace the email-based warehouse instruction with a live API push to the WMS:
- `POST /wms/instructions` with structured line items
- Receive webhook/poll for dispatch confirmation → auto-update DispatchRecord
- Real-time ATP pull from WMS stock positions instead of Google Sheets
- This eliminates the single biggest manual handoff in the system.

### 7.2 Direct Channel APIs 🟡 Planned Q3–Q4 2026
Nykaa and Zepto are actively building seller APIs. When available, replace the email+crawler path with:
- Webhook listener for new POs
- API-based GRN confirmation
- This will make ingestion near-instantaneous and eliminate scraping fragility.

### 7.3 AI-Powered Anomaly Detection 🟡 Planned Q4 2026
Use Claude to flag:
- POs where requested quantities are anomalously high or low vs. historical average
- Channels approaching their fill-rate commitment threshold
- GRN shortages that form a pattern (same SKU, same channel, multiple POs)
Feed these as proactive alerts to the ops team before they become problems.

### 7.4 Demand Forecasting 🔵 Exploration Phase
Use historical PO + dispatch + GRN data (now accumulating in PostgreSQL) to build a lightweight forecast:
- Expected PO volume per channel per week
- Recommended reorder trigger per SKU
- Feed into procurement planning

### 7.5 Mobile Companion App 🔵 Planned 2027
A React Native app for:
- Warehouse staff: barcode-scan dispatch confirmation
- Ops manager: approval workflows on mobile
- Push notifications for GRN discrepancies and SLA breaches

### 7.6 Multi-Tenant / Multi-Brand 🔵 Exploration Phase
The architecture is brand-agnostic. Channel, SKU, and PO models have no hardcoded Moxie-specific logic. A future version could serve multiple brands from the same infrastructure, with row-level security per brand in PostgreSQL.

### 7.7 EDI / GSTN Integration 🟡 Planned 2027
For enterprise channels (Reliance retail, large pharmacy chains), integrate with:
- GST Network (GSTN) for e-invoicing mandate compliance
- EDI (Electronic Data Interchange) for PO and invoice exchange

---

## 8. Non-Functional Characteristics

**Auditability** — Every state change is logged. The audit log is append-only and cannot be edited through the app layer.

**Graceful degradation** — Losing Gmail, Sheets, or Claude connectivity does not crash the app. It degrades to the last-known DB state and logs the failure. Cron jobs retry on next cycle.

**Security** — Cron endpoints protected by secret. Auth via Clerk with demo fallback. Server-only boundary prevents secret leakage to browser.

**Zero-downtime deploys** — Vercel previews per branch. Prisma migrations run before deploy via a pre-deploy hook.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **PO** | Purchase Order — a formal order from a channel partner |
| **ATP** | Available To Promise — inventory quantity that can be committed |
| **GRN** | Goods Received Note — confirmation from channel that goods arrived |
| **Debit Note** | Document raised against channel for shortage in GRN vs. dispatch |
| **Fill Rate** | % of ordered quantity actually fulfilled and accepted |
| **TAT** | Turnaround Time — days from PO receipt to delivery |
| **WMS** | Warehouse Management System |
| **D2C** | Direct-to-Consumer — the business model |
| **Channel** | A partner platform (Nykaa, Blinkit, Instamart, Zepto, Tira) |
| **SKU** | Stock Keeping Unit — a unique product identifier |

---

---
# CONFLUENCE DESIGN GUIDE
## How to Present This Document

### Page Structure
Use the following Confluence page template structure:

**Page title:** `Moxie Ops — D2C Operations Platform PRD`  
**Space:** Engineering or Ops  
**Labels:** `prd`, `ops`, `moxie-ops`, `architecture`

---

### Section-by-Section Design Ideas

#### Section 1 — Motivation
**Design:** Use a large "Info" callout panel (blue border) for the opening quote.  
Then use a 2-column layout: left column lists "Before" pain points as a bullet list with ❌ icons; right column shows "After" capabilities with ✅ icons.  
This "before/after" visual contrast is immediately compelling for stakeholders.

**Confluence macro:** `Columns` (2-col) + `Info Panel` for the quote.

---

#### Section 2 — Solution Overview
**Design:** The flow diagram is the hero of this section. Options:
- **Option A:** Use Mermaid / LucidChart and embed as an image. Show the linear flow from Channel → PO → Allocation → Dispatch → GRN → Invoice with boxes in lime (#C8FF00) and arrows in dark grey.
- **Option B:** Use Confluence's built-in diagramming (Diagrams.net) directly in the page.

Below the diagram, present the 6 modules as **6 coloured cards** in a 3×2 grid:
- Each card: icon + module name + 2-line description
- Card accent colors: alternate between lime and cream

---

#### Section 3 — System Architecture
**Design:** The layered architecture diagram is the centrepiece.  
- Draw it in Figma or draw.io: 4 horizontal bands (Frontend → API → Services → DB/Integrations)
- Each band has a different shade (lightest at top, darkest at bottom)
- Inside each band, show the actual folder names in `monospace`
- Export as PNG and embed at full-width

Below the diagram, use a **3-column table** for layer responsibilities (Layer | Folder | What it does).  
Use Confluence "Note" panels (yellow) for the two key architecture decisions: server-only boundary and graceful degradation.

---

#### Section 4 — Tech Stack
**Design:** A clean table works, but consider using **technology logo icons** next to each name (easily sourced from Devicons or SimpleIcons SVGs). Present as:
- Group by category: "Core Framework", "Data", "AI & Automation", "Communications", "Infrastructure"
- Use coloured "Status" lozenges: `PRODUCTION` in green, `PARTIAL` in yellow, `PLANNED` in grey

Alternatively: a horizontal "tech radar" style visual — concentric circles with "Adopt / Trial / Assess" zones — is striking for architecture reviews.

---

#### Section 5 — Current Problems
**Design:** Use Confluence's **coloured panel macros** to signal severity:
- 🔴 Red "Warning" panel for High Priority issues
- 🟡 Yellow "Note" panel for Medium Priority
- 🟢 Green "Tip" panel for Low Priority

Each panel: problem name as bold title → 2-sentence description → "Impact:" in italic.  
This makes the severity instantly scannable.

---

#### Section 6 — Future Work
**Design:** Use a **timeline / roadmap visual**. In Confluence:
- Either use a table with columns Q3 2026 | Q4 2026 | 2027 | Exploration
- Or embed a roadmap image (build in Figma: a horizontal swim-lane roadmap with colour-coded rows per theme: Infrastructure / AI / Channels / Product)

Each initiative: title + 1-line description + status lozenge (`PLANNED` / `IN PROGRESS` / `EXPLORING`).

---

#### Overall Page Tips
- Add a **Table of Contents** macro at the very top (Confluence will auto-generate from headings)
- Use **anchor links** in the ToC so readers can jump to sections
- Add a **"Page info" panel** at the top: Status | Owner | Version | Last Updated — use the `Info` macro styled with the Moxie lime color
- For the diagram images, use **"Bordered" image style** in Confluence with a subtle shadow
- Keep the page width at "Full width" (not narrow) to accommodate the architecture diagrams
- Add **inline comments** on complex sections so team members can ask questions contextually

---

#### Architecture Diagram — Draw Instructions
If you're drawing the system architecture in draw.io / Figma:

1. **Top layer (lightest):** Label "Frontend (Browser)" — cream background. Show: `app/(dashboard)` pages, `components/` folder
2. **Second layer:** Label "API Layer" — slightly darker. Show: REST routes listed in a small font, cron routes
3. **Third layer:** Label "Services & Integrations" — medium shade. Split in two halves: left = services list, right = integrations list (Gmail, Claude, Sheets icons)
4. **Bottom layer (darkest):** Label "Data" — show PostgreSQL logo + Google Sheets logo + AWS S3 logo
5. Add **downward arrows** between layers labeled with what passes through (RSC call / HTTP fetch / Prisma query)
6. On the right side, add a **vertical "Cron" swimlane** showing the 3 cron jobs connecting into the API layer

**Color guide for layers:**
- Frontend: #FDF6EE
- API: #F0F4FF  
- Services: #E8F5E9
- Data: #F3E8FF

---
