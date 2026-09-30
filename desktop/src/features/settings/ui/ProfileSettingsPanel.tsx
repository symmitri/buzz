import { PRODUCT_NAME } from "@/shared/lib/product-brand";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { SettingsProfileTab } from "./SettingsPanels";
import { ProfileConnectionsCard } from "./ProfileConnectionsCard";
import { ProfileSettingsCard } from "./ProfileSettingsCard";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

export function ProfileSettingsPanel({
  currentPubkey,
  fallbackDisplayName,
  tab,
  onTabChange,
}: {
  currentPubkey?: string;
  fallbackDisplayName?: string;
  tab: SettingsProfileTab;
  onTabChange: (tab: SettingsProfileTab) => void;
}) {
  return (
    <section className="min-w-0" data-testid="settings-profile-panel">
      <SettingsSectionHeader
        description={`Manage how you appear across ${PRODUCT_NAME} and manage your connected accounts.`}
        title="Profile"
      />
      <Tabs
        className="min-w-0"
        onValueChange={(value) => onTabChange(value as SettingsProfileTab)}
        value={tab}
      >
        <TabsList aria-label="Profile sections" className="mb-8">
          <TabsTrigger data-testid="profile-tab-overview" value="overview">
            Overview
          </TabsTrigger>
          <TabsTrigger
            data-testid="profile-tab-connections"
            value="connections"
          >
            Connections
          </TabsTrigger>
        </TabsList>
        <TabsContent
          className="mt-0 data-[state=inactive]:hidden"
          forceMount
          value="overview"
        >
          <ProfileSettingsCard
            active={tab === "overview"}
            currentPubkey={currentPubkey}
            fallbackDisplayName={fallbackDisplayName}
            showHeader={false}
          />
        </TabsContent>
        <TabsContent
          className="mt-0 data-[state=inactive]:hidden"
          forceMount
          value="connections"
        >
          <ProfileConnectionsCard active={tab === "connections"} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
