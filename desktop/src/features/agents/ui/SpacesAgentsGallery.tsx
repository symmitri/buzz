import * as React from "react";
import { MessageCircle, RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { AgentIdentityCard } from "./AgentIdentityCard";

type Agent = {
  id: string;
  name: string;
  description: string;
  private: boolean;
  pubkey: string | null;
};

export type AgentDirectory = {
  relay_url: string;
  human_pubkey: string;
  agents: Agent[];
};

type Props = {
  relayUrl: string;
  humanPubkey: string;
  readDirectory: () => Promise<AgentDirectory>;
  onDirectory?: (directory: AgentDirectory | null) => void;
  openConversation: (pubkey: string) => Promise<string>;
  openProfile?: (pubkey: string) => void;
  avatar?: (pubkey: string, name: string) => React.ReactNode;
  navigate: (channel: string) => void;
};

export function SpacesAgentsGallery({
  relayUrl,
  humanPubkey,
  readDirectory,
  onDirectory,
  openConversation,
  openProfile,
  avatar,
  navigate,
}: Props) {
  const [directory, setDirectory] = React.useState<AgentDirectory | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  const request = React.useRef(0);
  const actionPending = React.useRef(false);

  const refresh = React.useCallback(async () => {
    const current = generation.current;
    const requested = ++request.current;
    setDirectory(null);
    setLoading(true);
    setError(null);
    try {
      if (!relayUrl || !humanPubkey)
        throw new Error("Your Alpha connection is not ready.");
      const result = await readDirectory();
      if (generation.current !== current || request.current !== requested)
        return null;
      if (
        result.relay_url !== relayUrl ||
        result.human_pubkey !== humanPubkey
      ) {
        throw new Error(
          "Your Alpha connection changed. Refresh to check your agents.",
        );
      }
      setDirectory(result);
      onDirectory?.(result);
      return result;
    } catch {
      if (generation.current === current && request.current === requested) {
        onDirectory?.(null);
        setError("Could not load your agents. Refresh to try again.");
      }
      return null;
    } finally {
      if (generation.current === current && request.current === requested)
        setLoading(false);
    }
  }, [relayUrl, humanPubkey, readDirectory, onDirectory]);

  React.useEffect(() => {
    generation.current += 1;
    void refresh();
    const check = () => {
      if (document.visibilityState === "visible" && !actionPending.current)
        void refresh();
    };
    const timer = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [refresh]);

  async function openAgent(agent: Agent, action: "message" | "profile") {
    if (!agent.pubkey || actionPending.current) return;
    if (action === "profile" && !openProfile) return;
    actionPending.current = true;
    const current = generation.current;
    setOpening(agent.id);
    setError(null);
    try {
      // Both native destinations require the current canonical binding. Viewing
      // Profile only navigates; it never consents, creates a DM or starts work.
      const fresh = await refresh();
      if (generation.current !== current) return;
      const selected = fresh?.agents.find((entry) => entry.id === agent.id);
      if (!selected?.pubkey || selected.pubkey !== agent.pubkey) {
        setError(
          "This agent is not currently connected to Alpha. Refresh to check again.",
        );
        return;
      }
      if (action === "profile") {
        openProfile?.(selected.pubkey);
        return;
      }
      const channel = await openConversation(selected.pubkey);
      if (generation.current === current) navigate(channel);
    } catch (failure) {
      if (generation.current === current) {
        setError(
          typeof failure === "string"
            ? failure
            : failure instanceof Error
              ? failure.message
              : "Could not open this conversation. Try again.",
        );
      }
    } finally {
      actionPending.current = false;
      if (generation.current === current) setOpening(null);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-7 sm:px-6 sm:py-8">
      <div
        className="mx-auto w-full max-w-6xl space-y-8"
        data-testid="agents-page-content"
      >
        <PageHeader
          title="Agents"
          description="Your agents and company teammates."
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={loading || opening !== null}
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw />
              Refresh
            </Button>
          }
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking your agents…
          </p>
        ) : null}
        {directory?.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents are available to your account yet.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {directory?.agents.map((agent) => (
            <AgentIdentityCard
              key={agent.id}
              dataTestId={`agent-${agent.id}`}
              label={agent.name}
              avatar={
                agent.pubkey ? avatar?.(agent.pubkey, agent.name) : undefined
              }
              subtitle={
                agent.description ||
                (agent.private ? "Only you" : "Company agent")
              }
              ariaLabel={
                agent.pubkey
                  ? `Message ${agent.name}`
                  : `${agent.name} is not connected to Alpha`
              }
              disabled={!agent.pubkey || opening !== null}
              onClick={() => {
                void openAgent(agent, "message");
              }}
              actions={
                openProfile ? (
                  <Button
                    aria-label={`View ${agent.name}'s profile`}
                    disabled={!agent.pubkey || opening !== null}
                    size="sm"
                    variant="outline"
                    onClick={() => void openAgent(agent, "profile")}
                  >
                    Profile
                  </Button>
                ) : null
              }
              statusBadge={
                <span className="text-xs text-muted-foreground">
                  {agent.pubkey
                    ? agent.private
                      ? "Message privately"
                      : "Message"
                    : "Not connected to Alpha"}
                </span>
              }
              footerAccessory={
                agent.pubkey ? <MessageCircle size={14} /> : null
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
