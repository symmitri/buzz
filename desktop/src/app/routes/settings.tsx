import { createFileRoute } from "@tanstack/react-router";

import {
  type SettingsSection,
  type SettingsProfileTab,
  isSettingsSection,
  isSettingsProfileTab,
} from "@/features/settings/ui/SettingsPanels";

type SettingsRouteSearch = {
  section?: SettingsSection;
  profileTab?: SettingsProfileTab;
};

function validateSettingsSearch(
  search: Record<string, unknown>,
): SettingsRouteSearch {
  if (search.section === "doctor") {
    return { section: "agents" };
  }

  return {
    section: isSettingsSection(search.section) ? search.section : undefined,
    profileTab:
      search.section === "profile" && isSettingsProfileTab(search.profileTab)
        ? search.profileTab
        : undefined,
  };
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsRouteComponent,
});

// Settings renders at the AppShell level (it replaces the sidebar, top
// chrome, and router outlet wholesale), keyed off this route's presence —
// see AppShell. The outlet is unmounted while settings is open, so this
// component never actually renders.
function SettingsRouteComponent() {
  return null;
}
