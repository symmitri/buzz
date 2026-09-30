// Symmitri modification: native company identity, separate from relay readiness.
import * as React from "react";
import { useCommunities } from "@/features/communities/useCommunities";
import { markCommunityOnboardingComplete } from "@/features/onboarding/communityOnboarding";
import { UpdateChecker } from "@/features/settings/UpdateChecker";
import { invokeTauri } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";
import { SpacesWelcomeTitle } from "@/shared/ui/SpacesBrand";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { LandingBees } from "./LandingBees";
import { ONBOARDING_LANDING_CTA_CLASS } from "./OnboardingChrome";

type Account = {
  id: string;
  name: string;
  email: string;
  server_setup_pending: true;
};

type AdmittedCommunity = {
  id: string;
  name: string;
  relay_url: string;
  pubkey: string;
};

export function SpacesGoogleSignIn({
  children,
}: {
  children: React.ReactNode;
}) {
  const { addCommunity, switchCommunity } = useCommunities();
  const communityActions = React.useRef({ addCommunity, switchCommunity });
  communityActions.current = { addCommunity, switchCommunity };
  const [connected, setConnected] = React.useState(false);
  const [account, setAccount] = React.useState<Account | null>(null);
  const [pending, setPending] = React.useState<
    "restore" | "login" | "forget" | "connect" | null
  >("restore");
  const [error, setError] = React.useState<string | null>(null);
  const [restoreFailed, setRestoreFailed] = React.useState(false);
  const generation = React.useRef(0);

  const connect = React.useCallback(async (current: number) => {
    if (generation.current !== current) return;
    setPending("connect");
    const community = await invokeTauri<AdmittedCommunity | null>(
      "spaces_connect_community",
    );
    if (generation.current !== current || !community) return;
    const id = communityActions.current.addCommunity({
      id: community.id,
      name: community.name,
      relayUrl: community.relay_url,
      pubkey: community.pubkey,
      addedAt: new Date().toISOString(),
    });
    markCommunityOnboardingComplete(community.pubkey, community.relay_url);
    communityActions.current.switchCommunity(id);
    setConnected(true);
  }, []);

  const run = React.useCallback(
    async (operation: "restore" | "login" | "forget") => {
      const current = ++generation.current;
      setPending(operation);
      setError(null);
      setRestoreFailed(false);
      // Clear public account details before a fresh authoritative read.
      setAccount(null);
      try {
        const next =
          operation === "forget"
            ? await invokeTauri<void>("spaces_forget_google_account").then(
                () => null,
              )
            : await invokeTauri<Account | null>(
                operation === "restore"
                  ? "spaces_get_google_account"
                  : "spaces_start_google_login",
              );
        if (generation.current === current) {
          setAccount(next);
          if (next) await connect(current);
        }
      } catch (cause) {
        if (generation.current === current) {
          setRestoreFailed(operation === "restore");
          setError(
            cause instanceof Error
              ? cause.message
              : typeof cause === "string"
                ? cause
                : "Alpha could not connect. Try again.",
          );
        }
      } finally {
        if (generation.current === current) setPending(null);
      }
    },
    [connect],
  );

  React.useEffect(() => {
    void run("restore");
    return () => {
      generation.current++;
      // Cancel native browser/HTTP work too; ignoring a UI result is insufficient.
      void invokeTauri<void>("spaces_cancel_google_login").catch(() => {
        // There is no mounted view to report to. Native attempts also expire.
      });
    };
  }, [run]);

  const cancel = async () => {
    const current = ++generation.current;
    try {
      await invokeTauri<void>("spaces_cancel_google_login");
      if (generation.current === current) setError(null);
    } catch {
      if (generation.current === current)
        setError("Could not cancel sign-in. Close Alpha to end this attempt.");
    } finally {
      if (generation.current === current) setPending(null);
    }
  };

  if (connected) return children;

  return (
    <div
      className="buzz-onboarding-neutral-theme buzz-startup-shell buzz-onboarding-welcome flex max-h-dvh items-start justify-center overflow-x-hidden overflow-y-auto px-4 py-8 text-foreground"
      data-testid="spaces-google-signin"
    >
      <StartupWindowDragRegion />
      <LandingBees />
      <main className="relative my-auto flex w-full max-w-[720px] flex-col items-center text-center">
        <SpacesWelcomeTitle />
        <p className="mt-4 max-w-lg text-2xl leading-tight">
          Your people, your agents, your projects.
        </p>
        <div
          className="mt-8 flex max-w-md flex-col items-center gap-4"
          aria-live="polite"
        >
          {account ? (
            <>
              <p className="text-base">
                Signed in as <strong>{account.email}</strong>
              </p>
              <div className="rounded-xl border border-current/20 bg-background/70 p-5">
                <h2 className="text-lg font-semibold">
                  {pending === "connect"
                    ? "Connecting Alpha…"
                    : "Alpha messaging is not connected"}
                </h2>
                <p className="mt-2 text-sm leading-relaxed">
                  {pending === "connect"
                    ? "Opening your community with your verified company account."
                    : "Your Google sign-in is verified. Try connecting again once Alpha’s messaging server is ready."}
                </p>
              </div>
              <Button
                disabled={pending !== null}
                onClick={() => void run("restore")}
              >
                {pending === "connect" ? "Connecting…" : "Connect Alpha"}
              </Button>
              <Button
                disabled={pending !== null}
                onClick={() => void run("forget")}
                variant="ghost"
              >
                Sign out of Alpha
              </Button>
            </>
          ) : (
            <>
              <p className="text-base">
                {restoreFailed
                  ? "We could not check your saved sign-in. Try reconnecting."
                  : "Use your Symmitri Google account."}
              </p>
              {restoreFailed ? (
                <Button
                  disabled={pending !== null}
                  onClick={() => void run("restore")}
                >
                  Retry connection
                </Button>
              ) : null}
              <Button
                className={ONBOARDING_LANDING_CTA_CLASS}
                disabled={pending !== null}
                onClick={() => void run("login")}
              >
                {pending === "restore"
                  ? "Checking saved sign-in…"
                  : pending === "login"
                    ? "Continue in your browser…"
                    : pending === "forget"
                      ? "Signing out…"
                      : "Continue with Google"}
              </Button>
              {pending === "login" ? (
                <Button onClick={() => void cancel()} variant="ghost">
                  Cancel sign-in
                </Button>
              ) : null}
              <p className="text-sm leading-relaxed">
                Sign in to open your Alpha community and messages.
              </p>
            </>
          )}
          {error ? (
            <>
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
              <Button
                disabled={pending !== null}
                onClick={() => void run("forget")}
                variant="ghost"
              >
                Forget saved sign-in
              </Button>
            </>
          ) : null}
        </div>
        {account ? (
          <div className="mt-8 w-full max-w-md text-left">
            <UpdateChecker />
          </div>
        ) : null}
      </main>
    </div>
  );
}
