import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const PROVIDER = "app_settings";

interface AppSettingsData {
  poEmailTo?: string[];
  poEmailCc?: string[];
}

async function getAppSettings(): Promise<AppSettingsData> {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row || !row.data) return {};
  return row.data as AppSettingsData;
}

async function setAppSettings(patch: Partial<AppSettingsData>): Promise<void> {
  const current = await getAppSettings();
  const next = { ...current, ...patch };
  await prisma.integrationToken.upsert({
    where: { provider: PROVIDER },
    create: { provider: PROVIDER, accessToken: PROVIDER, data: next },
    update: { data: next },
  });
}

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
