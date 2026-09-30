/** This parser pin is independent of the execution roster / WorkAudienceReference. */
export const BUZZ_DISCLOSURE_SOURCE = '81fba7bda4da0f2c5891eec31852c4f98a6949bf';
/** The coordinator compared the disclosure-relevant source trees at both pins. */
export const BUZZ_DISCLOSURE_SOURCES = Object.freeze([BUZZ_DISCLOSURE_SOURCE, 'a9dd4d3bd771b47f0efb4e7f6f7329a5921372b5'] as const);
export const BUZZ_DISCLOSURE_OBSERVATION_SECONDS = 30;

/**
 * Trusted operator evidence, selected outside this codec. Never construct this
 * from NIP-11, caller claims, repository defaults, or a channel's membership list.
 * Its digest references reviewed metadata about the effective deployed policy.
 */
export interface BuzzDisclosureDeploymentEvidence {
  readonly evidenceDigest: string;
  readonly sourceCommit: (typeof BUZZ_DISCLOSURE_SOURCES)[number];
  readonly imageDigest: string;
  readonly tenantId: string;
  readonly relayOrigin: string;
  readonly relayPubkey: string;
  readonly checkedAt: number;
  readonly expiresAt: number;
  readonly httpAuthentication: 'required';
  readonly websocketAuthentication: 'required';
  readonly relayMembership: 'required';
  readonly ownerDelegation: 'nip-oa' | 'disabled';
  readonly mesh: 'disabled';
  readonly networkExposure: 'authenticated-relay-routes-only';
}

export interface BuzzPublicDisclosureObservation {
  readonly predicate: 'buzz-native-public-realm-v1';
  readonly readers: 'admitted-realm-members' | 'admitted-realm-members-and-owner-delegated-agents';
  readonly tenantId: string;
  readonly relayOrigin: string;
  readonly relayPubkey: string;
  readonly channelId: string;
  readonly channelType: 'stream' | 'forum';
  readonly sourceEventId: string;
  readonly threadRootId: string;
  readonly channelMetadataEventId: string;
  readonly realmMembershipEventId: string;
  readonly deploymentEvidenceDigest: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  /** UTF-8/SHA-256 over the domain-separated array documented in README.md. */
  readonly disclosureDigest: string;
  /** A fresh observation is not an atomic publication lease. */
  readonly publicationSupported: false;
  readonly releaseBlocker: 'relay-compare-consume-unavailable';
}
