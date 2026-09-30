import * as React from "react";
import { RefreshCw, Search } from "lucide-react";
import {
  filterConnectionEntries,
  type ConnectionAccount,
  type ConnectionScope,
} from "@/features/settings/lib/profileConnections";
import { useProfileConnections } from "@/features/settings/hooks/useProfileConnections";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsOptionGroupList } from "./SettingsOptionGroup";
import { CompanyConnectionSetup } from "./CompanyConnectionSetup";
import { ProfileConnectionRow } from "./ProfileConnectionRow";

const PAGE_SIZE = 40;

export function ProfileConnectionsCard({ active }: { active: boolean }) {
  const {
    snapshot,
    readState,
    message,
    busyConnectionId,
    load,
    mutate,
    startOAuth,
    accessRequestId,
  } = useProfileConnections(active);
  const [companyBusy, setCompanyBusy] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [scope, setScope] = React.useState<ConnectionScope>("all");
  const [page, setPage] = React.useState(0);
  React.useEffect(() => {
    setPage(0);
  }, [scope, search]);
  const filtered = React.useMemo(
    () => (snapshot ? filterConnectionEntries(snapshot, scope, search) : []),
    [scope, search, snapshot],
  );
  const accountsByConnection = React.useMemo(() => {
    const grouped = new Map<string, ConnectionAccount[]>();
    for (const account of snapshot?.accounts ?? []) {
      const accounts = grouped.get(account.connection_id);
      if (accounts) accounts.push(account);
      else grouped.set(account.connection_id, [account]);
    }
    return grouped;
  }, [snapshot]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const actionsDisabled =
    readState !== "ready" ||
    busyConnectionId !== null ||
    companyBusy ||
    snapshot?.accounts_state !== "ready";

  if (!active) return null;

  return (
    <section
      aria-busy={readState === "loading" ? true : undefined}
      className="min-w-0 space-y-8"
      data-testid="profile-connections"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search connections</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            disabled={!snapshot}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search providers or saved accounts"
            type="search"
            value={search}
          />
        </label>
        <Button
          disabled={
            readState === "loading" || busyConnectionId !== null || companyBusy
          }
          onClick={() => void load()}
          type="button"
          variant="outline"
        >
          <RefreshCw
            className={cn("h-4 w-4", readState === "loading" && "animate-spin")}
          />
          {readState === "loading" ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <div
        aria-label="Connection ownership"
        className="inline-flex rounded-lg bg-muted p-1"
        role="group"
      >
        {(
          [
            ["all", "All"],
            ["personal", "Personal"],
            ["company", "Company"],
          ] as const
        ).map(([value, label]) => (
          <button
            aria-pressed={scope === value}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors",
              scope === value &&
                "bg-background text-foreground shadow-sm dark:bg-background/80",
            )}
            key={value}
            onClick={() => setScope(value)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {message ? (
        <p
          className={cn(
            "rounded-xl border px-3 py-2 text-sm",
            readState === "ready"
              ? "border-border/70 bg-muted/25 text-muted-foreground"
              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
          role={readState === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}

      {snapshot && readState === "stale" ? (
        <p className="text-sm text-muted-foreground">
          Showing the last checked accounts. Refresh before making changes.
        </p>
      ) : null}

      {!snapshot && readState === "loading" ? (
        <div
          className="rounded-xl border border-border/70 bg-background/70 p-8 text-center text-sm text-muted-foreground"
          role="status"
        >
          Loading your connections…
        </div>
      ) : null}

      {!snapshot && readState === "error" ? (
        <div className="rounded-xl border border-border/70 bg-background/70 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Your connection catalog is not available.
          </p>
          <Button
            className="mt-4"
            onClick={() => void load()}
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : null}

      {snapshot ? (
        <SettingsOptionGroupList className="space-y-6">
          {visible.map((entry) => (
            <ProfileConnectionRow
              accounts={accountsByConnection.get(entry.connection_id) ?? []}
              accountsAvailable={snapshot.accounts_state === "ready"}
              busy={busyConnectionId === entry.connection_id}
              disabled={actionsDisabled}
              entry={entry}
              key={JSON.stringify([
                snapshot.organisation.id,
                snapshot.principal.id,
                entry.connection_id,
              ])}
              mutate={mutate}
              startOAuth={startOAuth}
              accessRequestId={accessRequestId}
            />
          ))}
        </SettingsOptionGroupList>
      ) : null}

      {snapshot && filtered.length === 0 ? (
        <div
          className="rounded-xl border border-border/70 bg-background/70 p-8 text-center"
          role="status"
        >
          <p className="font-medium">
            {search.trim() ? "No matching connections" : "No connections here"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {search.trim()
              ? "Try another provider, account, or owner."
              : "No connections are available to you in this category."}
          </p>
        </div>
      ) : null}

      {snapshot && scope !== "personal" ? (
        <CompanyConnectionSetup
          disabled={readState !== "ready" || busyConnectionId !== null}
          key={JSON.stringify([
            snapshot.organisation.id,
            snapshot.principal.id,
          ])}
          onBusyChange={setCompanyBusy}
        />
      ) : null}

      {filtered.length > PAGE_SIZE ? (
        <nav
          aria-label="Connection pages"
          className="flex items-center justify-between gap-3"
        >
          <Button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            variant="outline"
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            {currentPage * PAGE_SIZE + 1}–
            {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <Button
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
            variant="outline"
          >
            Next
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
