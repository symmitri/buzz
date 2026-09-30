import * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeTauri } from "@/shared/api/tauri";
import type {
  GitHubSetupResult,
  GitHubSetupView,
} from "../lib/githubCompanyConnection";

export function useGitHubCompanyConnection(active: boolean, disabled: boolean) {
  const [view, setView] = React.useState<GitHubSetupView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [requiresRefresh, setRequiresRefresh] = React.useState(false);
  const generation = React.useRef(0);
  const live = React.useRef(false);
  const pending = React.useRef<string | null>(null);
  const cancelBarrier = React.useRef(Promise.resolve());

  const cancel = React.useCallback(() => {
    const requestId = pending.current;
    pending.current = null;
    if (requestId) {
      cancelBarrier.current = cancelBarrier.current
        .then(() =>
          invokeTauri<void>("spaces_cancel_github_connection", { requestId }),
        )
        .catch(() => {});
    }
  }, []);

  const run = React.useCallback(
    async (action?: "start" | "resume") => {
      if (!live.current || disabled || pending.current) return;
      const currentView = view;
      if (action && (!currentView || requiresRefresh)) return;
      const epoch = ++generation.current;
      const requestId = crypto.randomUUID();
      pending.current = requestId;
      setBusy(true);
      setMessage("");
      const current = () =>
        live.current &&
        generation.current === epoch &&
        pending.current === requestId;
      try {
        await cancelBarrier.current;
        if (!current()) return;
        const result =
          action && currentView
            ? await invokeTauri<GitHubSetupResult>(
                "spaces_change_github_connection",
                {
                  input: {
                    requestId,
                    action,
                    expectedRevision: currentView.revision,
                    expectedAdministratorId:
                      currentView.capability.administrator_id,
                    expectedOrganisationId:
                      currentView.capability.organisation_id,
                    ...(action === "resume"
                      ? { sessionId: currentView.capability.session?.id }
                      : {}),
                  },
                },
              )
            : await invokeTauri<GitHubSetupResult>(
                "spaces_read_github_connection",
                { requestId },
              );
        if (!current()) return;
        if (result.state === "ready" || result.state === "opened") {
          setView(result.view);
          setRequiresRefresh(false);
          setMessage(
            result.state === "opened"
              ? "Continue in your browser, then check status here."
              : "",
          );
        } else {
          setView(result.state === "uncertain" ? result.view : null);
          setRequiresRefresh(true);
          setMessage(result.message);
        }
      } catch {
        if (!current()) return;
        setView(null);
        setRequiresRefresh(true);
        setMessage(
          action
            ? "Setup could not be confirmed. Check status before continuing."
            : "Company GitHub setup could not be checked. Try again.",
        );
      } finally {
        if (current()) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [disabled, requiresRefresh, view],
  );

  // Reads start only when the company setup disclosure opens. Late reads and
  // browser-operation responses cannot repopulate hidden or revoked details.
  const runRef = React.useRef(run);
  runRef.current = run;
  React.useEffect(() => {
    live.current = active && !disabled;
    if (!live.current) return;
    void runRef.current();
    return () => {
      live.current = false;
      generation.current++;
      cancel();
      setView(null);
      setMessage("");
      setBusy(false);
      setRequiresRefresh(false);
    };
  }, [active, disabled, cancel]);

  React.useEffect(() => {
    let disposed = false;
    const listener = listen("spaces-connections-invalidated", () => {
      if (disposed) return;
      live.current = false;
      generation.current++;
      cancel();
      setView(null);
      setBusy(false);
      setRequiresRefresh(true);
      setMessage("Check your company sign-in before continuing.");
    });
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [cancel]);

  return {
    view,
    busy,
    message,
    requiresRefresh,
    refresh: () => run(),
    change: (action: "start" | "resume") => run(action),
  };
}
