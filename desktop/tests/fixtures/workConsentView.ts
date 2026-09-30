import type { WorkConsentCardView } from "../../src/features/messages/ui/WorkConsentCard";

/** Synthetic presentation data only; never an enabled account or native capability. */
export function workConsentView(
  overrides: Partial<WorkConsentCardView> = {},
): WorkConsentCardView {
  return {
    phase: "ready",
    consentState: "pending",
    availableDecisions: ["approve", "decline"],
    terms: {
      taskLabel:
        "Turn my two latest morning meetings into source-linked roadmap proposals.",
      agentLabel: "Symi",
      initiatorLabel: "Alex",
      executionScopeLabel: "This task in #engineering",
      providerId: "granola-mcp",
      providerLabel: "Granola",
      accountLabel: "alex@example.test",
      actions: ["Read meeting notes and transcripts"],
      selectionLabel: "Your two latest morning meetings",
      windowLabel: "September 17, 2026 · 8:00–12:00 · America/New_York",
      outputPolicyLabel:
        "Results stay private to you. Sharing a draft needs your separate review.",
      expiresAt: "2026-09-17T17:30:00Z",
      expiresAtLabel: "September 17, 2026 at 1:30 PM EDT",
    },
    ...overrides,
  };
}
