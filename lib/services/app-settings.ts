import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import defaultLocationRecipients from "@/data/location-recipients.json";

const PROVIDER = "app_settings";

/** A single recipient row, kept with a display name for readability. */
export interface RecipientEntry {
  name: string;
  email: string;
}

/** Per-location To/CC recipient configuration. */
export interface LocationRecipientConfig {
  to: RecipientEntry[];
  cc: RecipientEntry[];
}

export type LocationRecipientsMap = Record<string, LocationRecipientConfig>;

/** Dispatch locations resolved from a PO's PDF GSTIN (see po-documents-helpers). */
export const DISPATCH_LOCATIONS = ["RGL NCR", "RGL BLR", "RGL MUM"] as const;

interface AppSettingsData {
  poEmailTo?: string[];
  poEmailCc?: string[];
  locationRecipients?: LocationRecipientsMap;
  /** Test-mode email sink: when on, ALL outgoing mail goes only to testEmailAddress. */
  testEmailMode?: boolean;
  testEmailAddress?: string;
}

async function getAppSettings(): Promise<AppSettingsData> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row || !row.data) return {};
  return row.data as AppSettingsData;
}

async function setAppSettings(patch: Partial<AppSettingsData>): Promise<void> {
  const current = await getAppSettings();
  const next = { ...current, ...patch } as unknown as Prisma.InputJsonObject;
  await prisma.integrationToken.upsert({
    where: { provider: PROVIDER },
    create: { provider: PROVIDER, accessToken: PROVIDER, data: next },
    update: { data: next },
  });
}

// ── Global PO email recipients (op-39) — used as the fallback ───────────────

export async function getPoEmailRecipients(): Promise<{ to: string[]; cc: string[] }> {
  const settings = await getAppSettings();
  const to =
    settings.poEmailTo && settings.poEmailTo.length > 0
      ? settings.poEmailTo
      : [env.PO_TEST_EMAIL_TO];
  return { to, cc: settings.poEmailCc ?? [] };
}

export async function setPoEmailRecipients(to: string[], cc: string[]): Promise<void> {
  await setAppSettings({ poEmailTo: to, poEmailCc: cc });
}

// ── Per-dispatch-location recipients ────────────────────────────────────────

/** Format a recipient for nodemailer: "Name <email>" when a name is present. */
function formatRecipient(r: RecipientEntry): string {
  const name = r.name?.trim();
  return name ? `${name} <${r.email.trim()}>` : r.email.trim();
}

/**
 * Full location → {to, cc} map (with display names) for the Settings editor.
 * Seeds the store from the bundled defaults on first read when unset/empty.
 */
export async function getLocationRecipientsMap(): Promise<LocationRecipientsMap> {
  const settings = await getAppSettings();
  const stored = settings.locationRecipients;
  if (!stored || Object.keys(stored).length === 0) {
    const seed = defaultLocationRecipients as LocationRecipientsMap;
    await setAppSettings({ locationRecipients: seed });
    return seed;
  }
  return stored;
}

/**
 * Resolve a dispatch location to its To/CC email lists (formatted "Name <email>").
 * Returns null when the location is unknown/unmapped or has no To recipients,
 * so callers can fall back to the global recipients.
 */
export async function getLocationRecipients(
  location: string,
): Promise<{ to: string[]; cc: string[] } | null> {
  const map = await getLocationRecipientsMap();
  const cfg = map[location];
  if (!cfg) return null;
  const to = (cfg.to ?? []).map(formatRecipient).filter(Boolean);
  if (to.length === 0) return null;
  const cc = (cfg.cc ?? []).map(formatRecipient).filter(Boolean);
  return { to, cc };
}

export async function setLocationRecipients(
  location: string,
  to: RecipientEntry[],
  cc: RecipientEntry[],
): Promise<void> {
  const map = await getLocationRecipientsMap();
  const next: LocationRecipientsMap = { ...map, [location]: { to, cc } };
  await setAppSettings({ locationRecipients: next });
}

// ── Test-mode email sink ────────────────────────────────────────────────────
// When enabled, every outgoing email (PO dispatch, GRN reminders, discrepancy
// notices, etc.) is redirected so ONLY the test address receives it — nobody
// else gets mailed. Used to safely exercise the email flows before deployment.

export async function getTestEmailMode(): Promise<{ enabled: boolean; address: string }> {
  const s = await getAppSettings();
  return { enabled: !!s.testEmailMode, address: s.testEmailAddress ?? "" };
}

export async function setTestEmailMode(enabled: boolean, address: string): Promise<void> {
  await setAppSettings({ testEmailMode: enabled, testEmailAddress: address.trim() });
}

/**
 * The single source of truth every email sender consults right before sending.
 * Returns the redirect address when test mode is on (and an address is set),
 * otherwise null (send normally). Fails safe: if reading settings throws, we
 * return null so a settings hiccup never silently swallows production mail.
 */
export async function getEmailRedirect(): Promise<string | null> {
  try {
    const { enabled, address } = await getTestEmailMode();
    return enabled && address ? address : null;
  } catch {
    return null;
  }
}
