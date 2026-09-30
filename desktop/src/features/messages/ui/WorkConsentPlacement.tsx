import * as React from "react";
import { createPortal } from "react-dom";
import type { TimelineMessage } from "../types";
import { workConsentAnchor } from "../lib/workConsentAnchor";

export interface WorkConsentTimeline {
  messages: readonly TimelineMessage[];
  container: React.RefObject<HTMLDivElement | null>;
  /** Thread-scoped correlation only; survives a temporary redacted snapshot. */
  anchors?: Map<string, { id: string; createdAt: number }>;
}

/** A stable message-owned DOM slot, never the moving end of the reply list. */
export function WorkConsentPlacement({ timeline, scopeKey, requestId, agentPubkey, requestedAt, eventAt, children }: {
  timeline?: WorkConsentTimeline;
  scopeKey?: string;
  requestId?: string;
  agentPubkey?: string;
  requestedAt?: string;
  eventAt?: string;
  children: (requestedAt?: string) => React.ReactNode;
}) {
  const observed = workConsentAnchor(timeline?.messages ?? [], requestId, agentPubkey);
  const key = JSON.stringify([scopeKey, requestId, agentPubkey]);
  const retained = React.useRef<{ key: string; anchor?: { id: string; createdAt: number } }>({ key });
  if (retained.current.key !== key) retained.current = { key };
  if (timeline?.anchors?.has(key)) retained.current.anchor = timeline.anchors.get(key);
  if (observed && (!retained.current.anchor || observed.createdAt < retained.current.anchor.createdAt))
    retained.current.anchor = { id: observed.id, createdAt: observed.createdAt };
  if (retained.current.anchor && timeline?.anchors) {
    if (!timeline.anchors.has(key) && timeline.anchors.size >= 256)
      timeline.anchors.delete(timeline.anchors.keys().next().value!);
    timeline.anchors.set(key, retained.current.anchor);
  }
  const anchor = eventAt
    ? (timeline?.messages ?? []).filter(message => !message.pending && message.createdAt * 1000 <= Date.parse(eventAt))
      .sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id))[0]
    : retained.current.anchor;
  const [target, setTarget] = React.useState<Element | null>(null);
  const place = React.useCallback(() => {
    const root = timeline?.container.current;
    const next = root?.querySelector(anchor ? `[data-work-consent-anchor="${anchor.id}"]` : "[data-work-consent-fallback]") ??
      root?.querySelector("[data-work-consent-fallback]") ?? null;
    setTarget(previous => previous === next ? previous : next);
  }, [timeline?.container, timeline?.messages, anchor?.id]);
  React.useLayoutEffect(place, [place]);
  // On first mount the parent's ref is attached after our layout effect.
  React.useEffect(place, [place]);
  const time = eventAt ?? (anchor ? new Date(anchor.createdAt * 1000).toISOString() : requestedAt);
  if (!timeline) return children(time);
  return target ? createPortal(children(time), target) : null;
}
