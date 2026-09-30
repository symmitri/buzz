import * as React from "react";
import { ChevronDown } from "lucide-react";
import { SettingsOptionGroup } from "./SettingsOptionGroup";

const GitHubCompanyConnection = React.lazy(() =>
  import("./GitHubCompanyConnection").then((module) => ({
    default: module.GitHubCompanyConnection,
  })),
);

/** Capabilities are requested only after opening this company setup disclosure. */
export function CompanyConnectionSetup({
  disabled,
  onBusyChange,
}: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <SettingsOptionGroup title="Company setup">
      <details
        className="group"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-sm font-medium hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          Set up a company connection
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        {open ? (
          <div className="border-t border-border/55 p-4">
            <React.Suspense
              fallback={
                <p className="text-sm text-muted-foreground" role="status">
                  Loading company setup…
                </p>
              }
            >
              <GitHubCompanyConnection
                active
                disabled={disabled}
                onBusyChange={onBusyChange}
              />
            </React.Suspense>
          </div>
        ) : null}
      </details>
    </SettingsOptionGroup>
  );
}
