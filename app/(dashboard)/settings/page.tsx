import { Topbar } from "@/components/layout/topbar";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { getChannels, getSkus } from "@/lib/data/queries";
import { getPoEmailRecipients, getLocationRecipientsMap } from "@/lib/services/app-settings";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [channels, skus, emailRecipients, locationRecipients] = await Promise.all([
    getChannels(),
    getSkus(),
    getPoEmailRecipients(),
    getLocationRecipientsMap(),
  ]);
  return (
    <>
      <Topbar title="Settings" subtitle="Configure channels, SKUs, inventory & warehouse" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <SettingsTabs
          channels={channels}
          skus={skus}
          warehouseEmail={env.WAREHOUSE_EMAIL}
          spreadsheetId={env.INVENTORY_SPREADSHEET_ID ?? ""}
          emailRecipients={emailRecipients}
          locationRecipients={locationRecipients}
        />
      </main>
    </>
  );
}
