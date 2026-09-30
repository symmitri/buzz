import { ExternalLink, RefreshCw } from "lucide-react";
import * as React from "react";
import { Button } from "@/shared/ui/button";
import { useGitHubCompanyConnection } from "../hooks/useGitHubCompanyConnection";
import { githubSetupStatus } from "../lib/githubCompanyConnection";
import { ConnectionProviderLogo } from "./ConnectionProviderLogo";

export function GitHubCompanyConnection({
  active,
  disabled = false,
  onBusyChange,
}: {
  active: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { view, busy, message, requiresRefresh, refresh, change } =
    useGitHubCompanyConnection(active, disabled);
  React.useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  if (!active) return null;
  const capability = view?.capability;
  const current = capability?.session;
  const canChange = !disabled && !busy && !requiresRefresh;
  return (
    <section
      aria-busy={busy}
      aria-label="Company GitHub setup"
      className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 font-medium">
            <ConnectionProviderLogo provider="github" />
            Company GitHub
          </p>
          <p className="text-muted-foreground">
            {view
              ? githubSetupStatus(view)
              : busy
                ? "Checking setup…"
                : "Company setup"}
          </p>
        </div>
        <Button
          disabled={disabled || busy}
          onClick={() => void refresh()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Check status
        </Button>
      </div>
      {capability ? (
        <div className="space-y-2 text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">
              {capability.account_login}
            </span>
            {" · "}
            {capability.repository_scope === "all"
              ? "All repositories, including future repositories"
              : `${capability.repositories.length} selected ${capability.repositories.length === 1 ? "repository" : "repositories"}`}
          </p>
          {capability.repository_scope === "selected" ? (
            <ul
              aria-label="Included repositories"
              className="max-h-28 list-inside list-disc overflow-y-auto break-words"
            >
              {capability.repositories.map((repository) => (
                <li key={repository}>{repository}</li>
              ))}
            </ul>
          ) : null}
          {current?.phase === "completed" ? (
            <p>
              The company connection is saved. Provider access has not been
              tested here.
            </p>
          ) : null}
          {canChange && capability.can_start ? (
            <Button
              onClick={() => void change("start")}
              size="sm"
              type="button"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Set up GitHub
            </Button>
          ) : null}
          {canChange && current?.can_resume ? (
            <Button
              onClick={() => void change("resume")}
              size="sm"
              type="button"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Resume in GitHub
            </Button>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p className="text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      {busy && capability ? (
        <p className="text-muted-foreground" role="status">
          Checking GitHub setup…
        </p>
      ) : null}
    </section>
  );
}
