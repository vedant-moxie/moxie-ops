import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const AUTO_CONFIRM_CONFIDENCE = 0.85;

// ── Resolution chain ──────────────────────────────────────────────────────────
// 1. SkuMaster.blinkitCode  — exact code lookup from the SKU Master xlsx
// 2. Text similarity        — word-recall match against SkuMaster.name (no API key needed)
//    Score = (Blinkit product words found in WMS name) / (total Blinkit product words)
//    Auto-confirms at ≥ 0.80; catches name variants like "Daily Calming Leave On Hair
//    Serum" ↔ "Daily Calming Leave On Serum" (score 0.80) without needing AI.
// 3. Gemini AI              — last resort; only invoked when GEMINI_API_KEY is set.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_MATCH_THRESHOLD = 0.80;

/** Normalize a product name for word-overlap matching. Removes brand prefix,
 *  packaging type suffixes, special characters, and short words (< 3 chars). */
function normalizeForMatch(text: string): string[] {
  return text
    .replace(/^moxie beauty\s+/i, "")
    .replace(/\([^)]*\)/g, " ")        // remove (Bottle), (Tube), (Box), (Spray) etc.
    .replace(/([a-z])([A-Z])/g, "$1 $2") // split camelCase: HydroRepair → Hydro Repair
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")      // remove dashes, slashes, etc.
    .split(/\s+/)
    .filter((w) => w.length >= 3);     // drop short words like "on", "in", "ml"
}

/** Fraction of Blinkit product words that appear in the WMS master name.
 *  Directional: we want the Blinkit description to "cover" the WMS name — not
 *  the other way around — because Blinkit names are more verbose. */
function wordRecallScore(blinkitWords: string[], masterSet: Set<string>): number {
  if (!blinkitWords.length) return 0;
  const matches = blinkitWords.filter((w) => masterSet.has(w)).length;
  return matches / blinkitWords.length;
}

interface WmsCandidate {
  code: string;
  description: string;
}

interface GeminiMatch {
  code: string;
  confidence: number;
  reasoning: string;
}

interface GeminiResponse {
  best_match: GeminiMatch | null;
  alternatives: GeminiMatch[];
}

/** Expand WMS code acronym to a readable description for the AI prompt. */
function codeHint(code: string): string {
  const prefix = code.replace(/\d+$/, "");
  const size = code.match(/\d+$/)?.[0];
  const acronyms: Record<string, string> = {
    HRHM: "HydroRepair Hair Mask",
    DDHM: "Deep Dive Hair Mask",
    GCS: "Gentle Cleansing Shampoo",
    UHC: "Ultra Hydrating Conditioner",
    SDCC: "Super Defining Curl Cream",
    FSSG: "Flexi Styling Serum Gel",
    WLIC: "Weightless Leave-in Conditioner",
    MRC: "Moisture Restoring Conditioner",
    HARS: "Hyaluronic Acid Repairing Shampoo",
    HARC: "Hyaluronic Acid Repairing Conditioner",
    HAHS: "Hyaluronic Acid Hair Serum",
    FFHS: "Frizz Fighting Hair Serum",
    DCLOS: "Daily Calming Leave-On Serum",
    CAHHO: "Strengthening Hair Oil",
    FHPS: "Heat Protection Spray",
    CDDS: "Cheat Day Dry Shampoo",
    CDDBD: "Cheat Day Dry Shampoo Brush Duo",
    DDPWT: "Dandruff Detox Pre-wash Hair Treatment",
    SRS: "Scalp Reviving Shampoo",
    TH: "The Headliner Wax Stick",
    FF: "On The Fly Hair Finishing Stick",
    SM: "Scalp Massager",
    HRWD: "HydroRepair Wash Duo",
    THRR: "HydroRepair Routine",
    CVSTD: "Curly Vibe Setter Travel Duo",
    WVSTD: "Wavy Vibe Setter Travel Duo",
  };
  const expanded = acronyms[prefix] ?? prefix;
  return size ? `${expanded} ${size}ml` : expanded;
}

async function getWmsCandidates(): Promise<WmsCandidate[]> {
  const rows = await prisma.warehouseStock.findMany({
    select: { skuCode: true },
    distinct: ["skuCode"],
  });
  const codes = rows.map((r) => r.skuCode);
  const skus = await prisma.sku.findMany({
    where: { internalCode: { in: codes } },
    select: { internalCode: true, name: true },
  });
  const nameMap = new Map(skus.map((s) => [s.internalCode, s.name]));
  return rows.map((r) => ({
    code: r.skuCode,
    description: nameMap.get(r.skuCode) ?? codeHint(r.skuCode),
  }));
}

async function callGemini(
  productName: string,
  uom: string,
  candidates: WmsCandidate[],
): Promise<GeminiResponse> {
  if (!env.GEMINI_API_KEY) return { best_match: null, alternatives: [] };

  const candidateList = candidates.map((c) => `${c.code} | ${c.description}`).join("\n");

  const prompt = `You are a product SKU matching assistant for Moxie Beauty, a hair care brand.

Match this Blinkit purchase order item to a WMS warehouse SKU code.

Product: ${productName}
Size/UOM: ${uom || "unknown"}

Available WMS SKU codes (code | description):
${candidateList}

Reply ONLY with a JSON object:
{
  "best_match": {"code": "EXACT_CODE", "confidence": 0.0, "reasoning": "brief"},
  "alternatives": [{"code": "CODE", "confidence": 0.0, "reasoning": "brief"}]
}

Confidence: 0.9+ = clear match same product+size, 0.75-0.89 = same product ambiguous size,
0.5-0.74 = likely same product family, <0.5 = weak. Set best_match null if <0.4. Max 2 alternatives.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.1 },
    }),
  });
  if (!res.ok) {
    console.warn(`[sku-mapper] Gemini ${res.status}: ${await res.text()}`);
    return { best_match: null, alternatives: [] };
  }
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { best_match: null, alternatives: [] };
  try {
    return JSON.parse(jsonMatch[0]) as GeminiResponse;
  } catch {
    return { best_match: null, alternatives: [] };
  }
}

export interface PendingMapping {
  skuId: string;
  skuName: string;
  uom: string;
  channelItemId: string;
  wmsCode: string;
  wmsDescription: string;
  confidence: number;
  alternatives: { code: string; description: string; confidence: number }[];
}

/**
 * For every SKU whose internalCode is a raw Blinkit item ID (no WMS stock found):
 *
 * Step 1 — SkuMaster.blinkitCode lookup (rule engine from the SKU Master xlsx).
 *   If blinkitCode matches, the internalCode IS the WMS skuCode. Auto-confirmed.
 *
 * Step 2 — Gemini AI (only when GEMINI_API_KEY is set and step 1 failed).
 *   High confidence (≥ 0.85): auto-confirmed.
 *   Low confidence (< 0.85): flagged for human review.
 */
export async function resolveUnmappedSkus(skuIds: string[]): Promise<{
  autoApplied: string[];
  pendingMappings: PendingMapping[];
}> {
  if (!skuIds.length) return { autoApplied: [], pendingMappings: [] };

  const skus = await prisma.sku.findMany({
    where: { id: { in: skuIds } },
    select: { id: true, internalCode: true, name: true, uom: true },
  });

  // Only process SKUs whose internalCode is a raw numeric channel item ID
  const stockCodes = new Set(
    (
      await prisma.warehouseStock.findMany({
        where: { skuCode: { in: skus.map((s) => s.internalCode) } },
        select: { skuCode: true },
        distinct: ["skuCode"],
      })
    ).map((r) => r.skuCode),
  );
  const needsMapping = skus.filter(
    (s) => !stockCodes.has(s.internalCode) && /^\d{6,}$/.test(s.internalCode),
  );
  if (!needsMapping.length) return { autoApplied: [], pendingMappings: [] };

  // Skip SKUs with an already-confirmed mapping
  const existing = await prisma.skuItemMapping.findMany({
    where: { skuId: { in: needsMapping.map((s) => s.id) } },
    select: { skuId: true, confirmedAt: true, needsReview: true, wmsCode: true, wmsDescription: true, confidence: true },
  });
  const existingMap = new Map(existing.map((e) => [e.skuId, e]));

  const autoApplied: string[] = [];
  const pendingMappings: PendingMapping[] = [];

  // Re-surface already-pending-review items
  const alreadyPending = needsMapping.filter(
    (s) => existingMap.has(s.id) && existingMap.get(s.id)!.needsReview && !existingMap.get(s.id)!.confirmedAt,
  );
  for (const s of alreadyPending) {
    const e = existingMap.get(s.id)!;
    pendingMappings.push({
      skuId: s.id, skuName: s.name, uom: s.uom, channelItemId: s.internalCode,
      wmsCode: e.wmsCode, wmsDescription: e.wmsDescription ?? codeHint(e.wmsCode),
      confidence: e.confidence, alternatives: [],
    });
  }

  const toRun = needsMapping.filter(
    (s) => !existingMap.has(s.id) || (existingMap.get(s.id)!.needsReview && !existingMap.get(s.id)!.confirmedAt),
  ).filter((s) => !alreadyPending.some((p) => p.id === s.id));

  if (!toRun.length) return { autoApplied, pendingMappings };

  // ── Step 1: SkuMaster channel-code rule engine ────────────────────────────
  // Build a reverse map: raw channel SKU code → internalCode (WMS code).
  // Covers Blinkit (blinkitCode) and Tira (tiraCode = the SAP productCode on
  // Tira PO lines, e.g. "494619783"). Both are raw numeric-ish ids that won't
  // collide, so a single lookup by either column is safe.
  const channelIds = toRun.map((s) => s.internalCode); // these are raw item IDs
  const masterMatches = await prisma.skuMaster.findMany({
    where: { OR: [{ blinkitCode: { in: channelIds } }, { tiraCode: { in: channelIds } }] },
    select: { internalCode: true, blinkitCode: true, tiraCode: true, name: true },
  });
  const masterByBlinkitId = new Map<string, (typeof masterMatches)[number]>();
  for (const m of masterMatches) {
    if (m.blinkitCode) masterByBlinkitId.set(String(m.blinkitCode), m);
    if (m.tiraCode) masterByBlinkitId.set(String(m.tiraCode), m);
  }

  // Also need to verify the mapped internalCode actually exists in WarehouseStock
  const masterCodes = masterMatches.map((m) => m.internalCode);
  const wmsCodesInStock = new Set(
    (
      await prisma.warehouseStock.findMany({
        where: { skuCode: { in: masterCodes } },
        select: { skuCode: true },
        distinct: ["skuCode"],
      })
    ).map((r) => r.skuCode),
  );

  const needsAi: typeof toRun = [];
  const now = new Date();

  for (const s of toRun) {
    const master = masterByBlinkitId.get(s.internalCode);
    if (master && wmsCodesInStock.has(master.internalCode)) {
      // Rule engine match — auto-confirm immediately
      await prisma.skuItemMapping.upsert({
        where: { skuId: s.id },
        create: {
          skuId: s.id, wmsCode: master.internalCode,
          wmsDescription: master.name ?? codeHint(master.internalCode),
          confidence: 1.0, method: "exact", needsReview: false, confirmedAt: now,
        },
        update: {
          wmsCode: master.internalCode,
          wmsDescription: master.name ?? codeHint(master.internalCode),
          confidence: 1.0, method: "exact", needsReview: false, confirmedAt: now,
        },
      });
      autoApplied.push(s.id);
      console.info(`[sku-mapper] rule-engine mapped ${s.internalCode} → ${master.internalCode}`);
    } else {
      needsAi.push(s);
    }
  }

  if (!needsAi.length) return { autoApplied, pendingMappings };

  // ── Step 2: Text similarity matching ─────────────────────────────────────
  // Compare Blinkit product name against every SkuMaster name using word-recall
  // scoring. Catches name variants that the exact blinkitCode lookup misses
  // (e.g. "Daily Calming Leave On Hair Serum" ↔ "Daily Calming Leave On Serum").
  // Build candidate set from ALL WarehouseStock codes (not just SkuMaster entries).
  // SkuMaster may be incomplete — HRHM100 for example exists in WMS stock but has no
  // SkuMaster row. Use SkuMaster.name when available; fall back to codeHint() so that
  // acronym expansion (HRHM → "HydroRepair Hair Mask") still drives matching.
  const [allStockCodesRaw, allSkuMasters] = await Promise.all([
    prisma.warehouseStock.findMany({ select: { skuCode: true }, distinct: ["skuCode"] }),
    prisma.skuMaster.findMany({ select: { internalCode: true, name: true }, where: { name: { not: null } } }),
  ]);
  const skuMasterNameMap = new Map(allSkuMasters.map((m) => [m.internalCode, m.name!]));
  const allStockCodes = new Set(allStockCodesRaw.map((r) => r.skuCode));
  const masterWordSets = allStockCodesRaw.map((r) => {
    const masterName = skuMasterNameMap.get(r.skuCode);
    const hint = codeHint(r.skuCode);
    const name = masterName ?? hint;
    // Union SkuMaster words with codeHint words so that verbose/typo-ridden master names
    // (e.g. "Treatmentwith AHA-BHAComplex") still match via the clean acronym hint.
    const words = new Set([...normalizeForMatch(name), ...(masterName ? normalizeForMatch(hint) : [])]);
    return { internalCode: r.skuCode, name, words };
  });

  // Extract the size number from a Blinkit UOM string (e.g. "50 ml" → "50", "2 x 50 ml" → "50")
  function uomSize(uom: string): string | undefined {
    return uom.match(/(\d+)\s*(?:ml|g|gm|l|kg)/i)?.[1];
  }

  const stillNeedsAi: typeof needsAi = [];

  for (const s of needsAi) {
    const blinkitWords = normalizeForMatch(s.name);

    // Score every master candidate
    const scored = masterWordSets
      .map((m) => ({ m, score: wordRecallScore(blinkitWords, m.words) }))
      .filter((c) => c.score >= TEXT_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      stillNeedsAi.push(s);
      continue;
    }

    // Among candidates tied within 0.05 of the best score, prefer the one whose
    // WMS code trailing-number matches the Blinkit product UOM size.
    // e.g. WLIC50 vs WLIC500 when UOM is "50 ml" → pick WLIC50.
    const topScore = scored[0]!.score;
    const tied = scored.filter((c) => c.score >= topScore - 0.05);
    let bestMaster = tied[0]!.m;

    if (tied.length > 1 && s.uom) {
      const sz = uomSize(s.uom);
      if (sz) {
        const sizeMatch = tied.find((c) => c.m.internalCode.match(/\d+$/)?.[0] === sz);
        if (sizeMatch) bestMaster = sizeMatch.m;
      }
    }

    const inStock = allStockCodes.has(bestMaster.internalCode);
    await prisma.skuItemMapping.upsert({
      where: { skuId: s.id },
      create: {
        skuId: s.id, wmsCode: bestMaster.internalCode,
        wmsDescription: bestMaster.name,
        confidence: topScore, method: "text", needsReview: false, confirmedAt: now,
      },
      update: {
        wmsCode: bestMaster.internalCode, wmsDescription: bestMaster.name,
        confidence: topScore, method: "text", needsReview: false, confirmedAt: now,
      },
    });
    autoApplied.push(s.id);
    console.info(
      `[sku-mapper] text-match mapped ${s.internalCode} → ${bestMaster.internalCode} (${Math.round(topScore * 100)}%, uom=${s.uom})${inStock ? "" : " [no stock yet]"}`,
    );
  }

  if (!stillNeedsAi.length) return { autoApplied, pendingMappings };

  // ── Step 3: Gemini AI fallback ────────────────────────────────────────────
  if (!env.GEMINI_API_KEY) {
    console.info(`[sku-mapper] ${stillNeedsAi.length} SKUs need AI mapping but GEMINI_API_KEY is not set`);
    return { autoApplied, pendingMappings };
  }

  const candidates = await getWmsCandidates();
  const candidateMap = new Map(candidates.map((c) => [c.code, c.description]));

  for (const s of stillNeedsAi) {
    try {
      const result = await callGemini(s.name, s.uom, candidates);
      const best = result.best_match;
      if (!best || best.confidence < 0.4) {
        console.info(`[sku-mapper] no Gemini match for ${s.internalCode} (${s.name})`);
        continue;
      }

      const needsReview = best.confidence < AUTO_CONFIRM_CONFIDENCE;
      await prisma.skuItemMapping.upsert({
        where: { skuId: s.id },
        create: {
          skuId: s.id, wmsCode: best.code,
          wmsDescription: candidateMap.get(best.code) ?? codeHint(best.code),
          confidence: best.confidence, method: "ai", needsReview,
          confirmedAt: needsReview ? null : now,
        },
        update: {
          wmsCode: best.code, wmsDescription: candidateMap.get(best.code) ?? codeHint(best.code),
          confidence: best.confidence, method: "ai", needsReview,
          confirmedAt: needsReview ? null : now,
        },
      });

      if (needsReview) {
        pendingMappings.push({
          skuId: s.id, skuName: s.name, uom: s.uom, channelItemId: s.internalCode,
          wmsCode: best.code, wmsDescription: candidateMap.get(best.code) ?? codeHint(best.code),
          confidence: best.confidence,
          alternatives: result.alternatives
            .filter((a) => a.code !== best.code)
            .slice(0, 2)
            .map((a) => ({ code: a.code, description: candidateMap.get(a.code) ?? codeHint(a.code), confidence: a.confidence })),
        });
      } else {
        autoApplied.push(s.id);
        console.info(`[sku-mapper] Gemini auto-mapped ${s.internalCode} → ${best.code} (${Math.round(best.confidence * 100)}%)`);
      }
    } catch (err) {
      console.warn(`[sku-mapper] Gemini failed for ${s.internalCode} (${s.name}):`, err);
    }
  }

  return { autoApplied, pendingMappings };
}

/** Confirm a specific mapping (user-chosen code). */
export async function confirmSkuMapping(skuId: string, wmsCode: string): Promise<void> {
  const candidates = await getWmsCandidates();
  const desc = candidates.find((c) => c.code === wmsCode)?.description ?? codeHint(wmsCode);
  await prisma.skuItemMapping.upsert({
    where: { skuId },
    create: { skuId, wmsCode, wmsDescription: desc, confidence: 1.0, method: "manual", needsReview: false, confirmedAt: new Date() },
    update: { wmsCode, wmsDescription: desc, confidence: 1.0, method: "manual", needsReview: false, confirmedAt: new Date() },
  });
}

/** Remove a mapping so the SKU is treated as unmapped again. */
export async function dismissSkuMapping(skuId: string): Promise<void> {
  await prisma.skuItemMapping.deleteMany({ where: { skuId } });
}
