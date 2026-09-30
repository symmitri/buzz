import * as React from "react";
import { Check, RefreshCw } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { invokeTauri } from "@/shared/api/tauri";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { cn } from "@/shared/lib/cn";

type ChannelAgent = {
  id: string;
  name: string;
  description: string;
  pubkey: string | null;
  in_channel: boolean;
  ready: boolean;
  can_add: boolean;
  unavailable_reason?: string | null;
};

type ChannelAgents = {
  channel_id: string;
  relay_url: string;
  human_pubkey: string;
  agents: ChannelAgent[];
};

type AddResult = { state: "confirmed" | "not_confirmed"; message?: string };

function failureMessage(error: unknown, fallback: string) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : fallback;
}

/** Existing company identities only; native code owns membership and access. */
export function SpacesChannelAgentsDialog({
  channelId,
  relayUrl,
  humanPubkey,
  open,
  onOpenChange,
  onAdded,
}: {
  channelId: string | null;
  relayUrl: string;
  humanPubkey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [directory, setDirectory] = React.useState<ChannelAgents | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [requiresRefresh, setRequiresRefresh] = React.useState(false);
  const [error, setError] = React.useState("");
  const generation = React.useRef(0);
  const live = React.useRef(false);
  const pending = React.useRef(false);
  const pendingCompletion = React.useRef(Promise.resolve());
  const subscription = React.useRef(Promise.resolve(false));

  const refresh = React.useCallback(async () => {
    if (!live.current) return;
    const epoch = ++generation.current;
    setDirectory(null);
    setSelectedId(null);
    setLoading(true);
    setError("");
    try {
      await pendingCompletion.current;
      const subscribed = await subscription.current;
      if (!live.current || generation.current !== epoch) return;
      if (!subscribed || !channelId || !relayUrl || !humanPubkey)
        throw new Error(
          "Your company connection is not ready. Close and reopen this dialog to try again.",
        );
      const next = await invokeTauri<ChannelAgents>(
        "spaces_list_channel_agents",
        { channelId },
      );
      if (!live.current || generation.current !== epoch) return;
      if (
        next.channel_id !== channelId ||
        next.relay_url !== relayUrl ||
        next.human_pubkey !== humanPubkey
      )
        throw new Error(
          "Your company connection changed. Close and reopen this dialog to try again.",
        );
      setDirectory(next);
      setRequiresRefresh(false);
    } catch (failure) {
      if (!live.current || generation.current !== epoch) return;
      setError(
        failureMessage(
          failure,
          "Company agents could not be checked. Refresh to try again.",
        ),
      );
    } finally {
      if (live.current && generation.current === epoch) setLoading(false);
    }
  }, [channelId, relayUrl, humanPubkey]);

  React.useEffect(() => {
    let disposed = false;
    const listener = listen("spaces-connections-invalidated", () => {
      if (disposed) return;
      generation.current++;
      setDirectory(null);
      setSelectedId(null);
      setLoading(false);
      setAdding(false);
      setRequiresRefresh(true);
      setError(
        "Your account access changed. Close and reopen this dialog to check again.",
      );
    });
    subscription.current = listener.then(
      () => true,
      () => false,
    );
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  React.useEffect(() => {
    live.current = open;
    if (open) void refresh();
    return () => {
      live.current = false;
      generation.current++;
      setDirectory(null);
      setSelectedId(null);
      setError("");
      setAdding(false);
      setLoading(false);
    };
  }, [open, refresh]);

  const selected = directory?.agents.find((agent) => agent.id === selectedId);
  async function add() {
    if (
      !live.current ||
      pending.current ||
      loading ||
      requiresRefresh ||
      !directory ||
      !selected?.pubkey ||
      !selected.can_add ||
      selected.ready
    )
      return;
    pending.current = true;
    let complete: () => void = () => {};
    pendingCompletion.current = new Promise<void>((resolve) => {
      complete = resolve;
    });
    setAdding(true);
    setError("");
    const epoch = generation.current;
    try {
      const result = await invokeTauri<AddResult>("spaces_add_channel_agent", {
        channelId,
        agentId: selected.id,
        expectedPubkey: selected.pubkey,
        expectedRelayUrl: directory.relay_url,
        expectedSignerPubkey: directory.human_pubkey,
      });
      if (!live.current || generation.current !== epoch) return;
      if (result.state === "confirmed") {
        onAdded();
        onOpenChange(false);
      } else {
        setRequiresRefresh(true);
        setError(
          result.message ||
            "The addition could not be confirmed. Refresh before trying again.",
        );
      }
    } catch (failure) {
      if (!live.current || generation.current !== epoch) return;
      setRequiresRefresh(true);
      setError(
        failureMessage(
          failure,
          "The addition could not be confirmed. Refresh before trying again.",
        ),
      );
    } finally {
      pending.current = false;
      complete();
      if (live.current && generation.current === epoch) setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChooserDialogContent
        title="Add agents"
        headerSubtitle="Choose a company agent to read and reply in this channel."
        className="max-w-xl"
        data-testid="add-channel-bot-dialog"
        footerClassName="justify-end gap-2"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={loading || adding}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                loading ||
                adding ||
                requiresRefresh ||
                !selected?.pubkey ||
                !selected.can_add ||
                selected.ready
              }
              onClick={() => void add()}
            >
              {adding
                ? "Adding…"
                : selected?.in_channel
                  ? "Enable replies"
                  : "Add agent"}
            </Button>
          </>
        }
      >
        {error ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Checking company agents…
          </p>
        ) : null}
        {directory?.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No company agents are available to this account yet.
          </p>
        ) : null}
        <fieldset className="space-y-1" aria-label="Company agents">
          {directory?.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              aria-pressed={selectedId === agent.id}
              disabled={
                adding ||
                loading ||
                requiresRefresh ||
                agent.ready ||
                !agent.can_add ||
                !agent.pubkey
              }
              onClick={() => setSelectedId(agent.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                selectedId === agent.id
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/60",
              )}
            >
              <ProfileAvatar
                avatarUrl={null}
                label={agent.name}
                shape="squircle"
                className="h-9 w-9 shrink-0 text-xs"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{agent.name}</span>
                <span className="block text-xs text-muted-foreground">
                  Company agent
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {agent.ready
                    ? "In channel"
                    : agent.unavailable_reason ||
                      (agent.in_channel
                        ? "In channel · Replies need access"
                        : agent.description || "Available to add")}
                </span>
              </span>
              {agent.ready || selectedId === agent.id ? (
                <Check aria-hidden className="h-4 w-4 shrink-0" />
              ) : null}
            </button>
          ))}
        </fieldset>
        {directory ? (
          <p className="mt-5 text-xs text-muted-foreground">
            After adding an agent, @mention it in the channel to ask for a
            reply.
          </p>
        ) : null}
      </ChooserDialogContent>
    </Dialog>
  );
}
