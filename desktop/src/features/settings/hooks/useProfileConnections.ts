import * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeTauri } from "@/shared/api/tauri";
import {
  requestId,
  type ConnectionsMutationResult,
  type ConnectionsReadResult,
  type ConnectionsSnapshot,
} from "../lib/profileConnections";

type ReadState = "idle" | "loading" | "ready" | "stale" | "error";
const READ_FAILED = "Connections could not be checked. Refresh to try again.";
const CHANGE_UNCERTAIN =
  "The change could not be confirmed. Refresh to check before trying again.";
// Native cancellation covers the shared Connections state. Keep this ordering
// across complete Settings unmounts as well as tab switches.
let cancelBarrier: Promise<unknown> = Promise.resolve();

function owner(snapshot: ConnectionsSnapshot) {
  return JSON.stringify([snapshot.organisation.id, snapshot.principal.id]);
}

/** Section-local private state. Nothing is read until the section is opened. */
export function useProfileConnections(active: boolean) {
  const generation = React.useRef(0);
  const visible = React.useRef(active);
  visible.current = active;
  const snapshotRef = React.useRef<ConnectionsSnapshot | null>(null);
  const busy = React.useRef<string | null>(null);
  const subscriptionReady = React.useRef<Promise<boolean>>(
    Promise.resolve(false),
  );
  const requestIds = React.useRef(new Map<string, string>());
  const lastOwner = React.useRef<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<ConnectionsSnapshot | null>(
    null,
  );
  const [readState, setReadState] = React.useState<ReadState>("idle");
  const [message, setMessage] = React.useState("");
  const [busyConnectionId, setBusyConnectionId] = React.useState<string | null>(
    null,
  );
  const clear = React.useCallback(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    busy.current = null;
    setBusyConnectionId(null);
  }, []);
  const accept = React.useCallback((next: ConnectionsSnapshot) => {
    if (lastOwner.current !== owner(next)) requestIds.current.clear();
    lastOwner.current = owner(next);
    for (const entry of next.entries) {
      if (
        entry.request?.status === "approved" ||
        entry.request?.status === "rejected"
      )
        requestIds.current.delete(entry.connection_id);
    }
    snapshotRef.current = next;
    setSnapshot(next);
    setReadState("ready");
  }, []);
  const invalidate = React.useCallback(() => {
    generation.current++;
    clear();
    requestIds.current.clear();
    lastOwner.current = null;
    setReadState("error");
    setMessage(
      "Your account access changed. Refresh to check your connections.",
    );
  }, [clear]);
  const load = React.useCallback(async () => {
    if (!visible.current || busy.current) return;
    const current = ++generation.current;
    setReadState("loading");
    setMessage("");
    await cancelBarrier;
    const subscribed = await subscriptionReady.current;
    if (!visible.current || current !== generation.current) return;
    if (!subscribed) {
      clear();
      setReadState("error");
      setMessage(
        "Account status could not be checked. Close and reopen Settings to try again.",
      );
      return;
    }
    try {
      const result = await invokeTauri<ConnectionsReadResult>(
        "spaces_read_connections",
      );
      if (!visible.current || current !== generation.current) return;
      if (result.state === "ready") {
        accept(result.snapshot);
        setMessage(
          result.snapshot.message ??
            (result.snapshot.accounts_state === "unavailable"
              ? "Some account details could not be loaded. Refresh to check before making changes."
              : ""),
        );
      } else if (result.state === "unavailable" && snapshotRef.current) {
        setReadState("stale");
        setMessage(result.message);
      } else {
        invalidate();
        setMessage(result.message);
      }
    } catch {
      if (!visible.current || current !== generation.current) return;
      setReadState(snapshotRef.current ? "stale" : "error");
      setMessage(READ_FAILED);
    }
  }, [accept, clear, invalidate]);
  React.useEffect(() => {
    let disposed = false;
    const listener = listen("spaces-connections-invalidated", () => {
      if (!disposed) invalidate();
    });
    subscriptionReady.current = listener.then(
      () => true,
      () => false,
    );
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [invalidate]);
  React.useEffect(() => {
    clear();
    setReadState("idle");
    setMessage("");
    if (active) void load();
    return () => {
      generation.current++;
      // Complete the native cancellation before the next section read starts.
      cancelBarrier = cancelBarrier
        .then(() => invokeTauri<void>("spaces_cancel_connections"))
        .catch(() => {});
    };
  }, [active, clear, load]);
  const begin = React.useCallback((connectionId: string) => {
    if (!visible.current || busy.current || !snapshotRef.current) return null;
    const current = ++generation.current;
    const principal = owner(snapshotRef.current);
    busy.current = connectionId;
    setBusyConnectionId(connectionId);
    setMessage("");
    return {
      current,
      principal,
      valid: () =>
        visible.current &&
        generation.current === current &&
        snapshotRef.current !== null &&
        owner(snapshotRef.current) === principal,
    };
  }, []);
  const finish = React.useCallback((current: number) => {
    if (current !== generation.current) return;
    busy.current = null;
    setBusyConnectionId(null);
  }, []);
  const mutate = React.useCallback(
    async (
      command: string,
      connectionId: string,
      input: Record<string, unknown>,
      success: string,
    ) => {
      const operation = begin(connectionId);
      if (!operation) return false;
      try {
        const result = await invokeTauri<ConnectionsMutationResult>(command, {
          input,
        });
        if (!operation.valid()) return false;
        if (
          result.state === "access_lost" ||
          ("snapshot" in result &&
            result.snapshot &&
            owner(result.snapshot) !== operation.principal)
        ) {
          invalidate();
          return false;
        }
        if ("snapshot" in result && result.snapshot) accept(result.snapshot);
        if (result.state === "confirmed") {
          setMessage(success);
          return true;
        }
        setReadState(snapshotRef.current ? "stale" : "error");
        setMessage(result.message);
        return false;
      } catch {
        if (!operation.valid()) return false;
        setReadState(snapshotRef.current ? "stale" : "error");
        setMessage(CHANGE_UNCERTAIN);
        return false;
      } finally {
        finish(operation.current);
      }
    },
    [accept, begin, finish, invalidate],
  );
  const startOAuth = React.useCallback(
    async (
      connectionId: string,
      input: { connectionId: string; access?: "read_only" | "drafts" },
    ) => {
      const operation = begin(connectionId);
      if (!operation) return false;
      try {
        await invokeTauri<{ opened: true }>("spaces_start_connection_oauth", {
          input,
        });
        if (!operation.valid()) return false;
        setMessage("Continue in your browser, then return here and refresh.");
        return true;
      } catch {
        if (!operation.valid()) return false;
        setReadState("stale");
        setMessage(
          "The browser handoff could not be confirmed. Refresh before trying again.",
        );
        return false;
      } finally {
        finish(operation.current);
      }
    },
    [begin, finish],
  );
  const accessRequestId = React.useCallback((connectionId: string) => {
    const existing = requestIds.current.get(connectionId);
    if (existing) return existing;
    const id = requestId();
    requestIds.current.set(connectionId, id);
    return id;
  }, []);
  return {
    snapshot,
    readState,
    message,
    busyConnectionId,
    load,
    mutate,
    startOAuth,
    accessRequestId,
  };
}
