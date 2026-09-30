import * as React from "react";
import { Button } from "@/shared/ui/button";

export type AgentConnections = {
  relay_url: string;
  human_pubkey: string;
  agent_pubkey: string;
  agent_name: string;
  connections: { label: string; provider: string; ownership: string }[];
};

type Props = {
  relayUrl: string;
  humanPubkey: string;
  agentPubkey: string;
  read: () => Promise<AgentConnections>;
  subscribeInvalidation: (clear: () => void) => Promise<() => void>;
};

export function AgentConnectionsSection({
  relayUrl,
  humanPubkey,
  agentPubkey,
  read,
  subscribeInvalidation,
}: Props) {
  const [result, setResult] = React.useState<AgentConnections | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const sequence = React.useRef(0);
  const observing = React.useRef(false);
  const pending = React.useRef<number | null>(null);
  const clear = React.useCallback(() => {
    sequence.current++;
    pending.current = null;
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);
  const refresh = React.useCallback(async () => {
    if (!observing.current || pending.current !== null) return;
    const request = ++sequence.current;
    pending.current = request;
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      const value = await read();
      if (request !== sequence.current) return;
      if (
        value.relay_url !== relayUrl ||
        value.human_pubkey !== humanPubkey ||
        value.agent_pubkey !== agentPubkey
      )
        throw new Error(
          "This agent's Alpha identity changed. Reopen its profile.",
        );
      setResult(value);
    } catch (failure) {
      if (request === sequence.current)
        setError(
          typeof failure === "string"
            ? failure
            : failure instanceof Error
              ? failure.message
              : "Could not load agent connections.",
        );
    } finally {
      if (pending.current === request) pending.current = null;
      if (request === sequence.current) setLoading(false);
    }
  }, [read, relayUrl, humanPubkey, agentPubkey]);
  React.useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    // Subscribe before reading so sign-out/account invalidation cannot leave
    // previously visible Agent details in an open profile.
    void subscribeInvalidation(clear)
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
        observing.current = true;
        void refresh();
      })
      .catch(() => {
        if (active) {
          clear();
          setError("Reopen the profile to load agent connections.");
        }
      });
    const visibility = () => {
      if (document.visibilityState === "hidden") clear();
      else void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", visibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => {
      active = false;
      observing.current = false;
      sequence.current++;
      pending.current = null;
      stop?.();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", visibility);
    };
  }, [refresh, clear, subscribeInvalidation]);
  // Also bind rendered state: a prop change must not expose the previous scope
  // for a frame while React runs effect cleanup.
  const visible =
    result?.relay_url === relayUrl &&
    result?.human_pubkey === humanPubkey &&
    result?.agent_pubkey === agentPubkey
      ? result
      : null;
  return (
    <section
      aria-label="Agent connections"
      className="space-y-3 rounded-2xl border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">Connections</h4>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking agent connections…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
      {visible ? (
        <>
          <p className="text-xs text-muted-foreground">
            Configured for {visible.agent_name}. Access is checked for each
            request; these grants do not confirm a working connection.
          </p>
          {visible.connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No connections are visible to you for this agent.
            </p>
          ) : (
            <ul className="divide-y">
              {visible.connections.map((connection, index) => (
                <li key={index} className="py-2 text-sm">
                  <div className="font-medium">{connection.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {connection.provider} ·{" "}
                    {connection.ownership === "company"
                      ? "Company account"
                      : connection.ownership === "agent"
                        ? "Agent account"
                        : connection.ownership === "delegated"
                          ? "Delegated account"
                          : "Account ownership unavailable"}{" "}
                    · Configured
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
