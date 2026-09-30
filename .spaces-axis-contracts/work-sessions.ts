/** References are metadata, never capabilities. Gateway owns the authorization
 * fence; native execution proofs and current personal consent remain separate. */
export interface NativeWorkOrigin {
  orgId: string;
  tenantId: string;
  relayUrl: string;
  relayPubkey: string;
  channelId: string;
  rootEventId: string;
}

export interface NativeWorkBinding {
  channelId: string;
  rootEventId: string;
  version: number;
}

export interface WorkAudienceReference {
  /** Native execution membership digest, including silent channel members.
   * This is not a public-disclosure audience contract. */
  digest: string;
  /** Signed native membership event ID. No inherited space authority is asserted. */
  revision: string;
  version: number;
}

export interface WorkSessionReference {
  id: string;
  origin: NativeWorkOrigin;
  /** First authenticated source; later speakers never replace this provenance. */
  createdFrom: { sourceEventId: string; sourcePubkey: string; actorId: string; requestId: string };
  binding: NativeWorkBinding;
  audience: WorkAudienceReference;
  state: 'open' | 'closed';
  /** Gateway must advance its fence before a lifecycle change is acknowledged. */
  authorizationEpoch: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** Frozen task preconditions; preserve the exact ephemeral native execution too. */
export interface WorkTaskReference {
  workId: string;
  requestId: string;
  requesterId: string;
  agentId: string;
  conversationId: string;
  sessionId: string;
  bindingVersion: number;
  audienceVersion: number;
  audienceDigest: string;
  authorizationEpoch: number;
}

export interface WorkLifecycleInput {
  requestId: string;
  expectedVersion: number;
  expectedAuthorizationEpoch: number;
  closed: boolean;
}

/** Returned only by a trusted Gateway adapter after its authoritative fence has
 * advanced. Retry an uncertain transition with the identical operation, actor,
 * previous versions and audience. A local projection is not revocation proof. */
export interface WorkLifecycleReceipt {
  workId: string;
  requestId: string;
  actorId: string;
  previousVersion: number;
  previousAuthorizationEpoch: number;
  version: number;
  authorizationEpoch: number;
  state: 'open' | 'closed';
  bindingVersion: number;
  audienceVersion: number;
  audienceDigest: string;
}
