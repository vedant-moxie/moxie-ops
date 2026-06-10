import { Topbar } from "@/components/layout/topbar";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { EmailSeriesCard } from "@/components/settings/email-series-card";
import { getChannels } from "@/lib/data/queries";
import { listSkuMaster } from "@/lib/services/sku-master";
import { getLocationRecipientsMap } from "@/lib/services/app-settings";
import { getSeries } from "@/lib/services/email-ref-counter";
import { isAdmin } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [channels, skus, locationRecipients, series, admin] = await Promise.all([
    getChannels(),
    listSkuMaster(),
    getLocationRecipientsMap(),
    getSeries(),
    isAdmin(),
  ]);
  return (
    <>
      <Topbar title="Settings" subtitle="Configure channels, SKUs, inventory & warehouse" />
      <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
        <EmailSeriesCard series={series} />
        <SettingsTabs
          channels={channels}
          skus={skus}
          isAdmin={admin}
          warehouseEmail={env.WAREHOUSE_EMAIL}
          spreadsheetId={env.INVENTORY_SPREADSHEET_ID ?? ""}
          locationRecipients={locationRecipients}
        />
      </main>
    </>
  );
}
