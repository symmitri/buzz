/** Pure wire material shared with native review. References and encodings do
 * not authenticate a relay, a human decision or a publication receipt. */
export const BUZZ_REVIEWED_PUBLICATION_CAPABILITY = 'axis-reviewed-publication-v1';
export const BUZZ_REVIEWED_SOURCE_REVISION = 'a9dd4d3bd771b47f0efb4e7f6f7329a5921372b5';

export interface BuzzReviewedReaderPolicy {
  http_auth: true;
  websocket_auth: true;
  realm_membership: true;
  owner_delegation: boolean;
  mesh: false;
}

/** Every proof field except its short-lived issuance and expiry. An owner
 * decision freezes this complete material, not a channel execution roster. */
export interface BuzzReviewedDisclosureMaterial {
  version: 1;
  community_id: string;
  channel_id: string;
  root_event_id: string;
  publisher_pubkey: string;
  relay_pubkey: string;
  origin: string;
  source_revision: typeof BUZZ_REVIEWED_SOURCE_REVISION;
  source_build: string;
  realm_revision: string;
  channel_revision: string;
  policy_incarnation: string;
  reader_policy: BuzzReviewedReaderPolicy;
}

export interface BuzzReviewedDisclosureProofBody extends BuzzReviewedDisclosureMaterial {
  issued_at: number;
  expires_at: number;
}

export interface BuzzReviewedAcceptanceBody {
  version: 1;
  event_id: string;
  proof_id: string;
  community_id: string;
  channel_id: string;
  root_event_id: string;
  publisher_pubkey: string;
  relay_pubkey: string;
  origin: string;
  accepted_at: number;
  realm_revision: string;
  channel_revision: string;
  policy_incarnation: string;
}

export interface BuzzReviewedProofRequest { version: 1; channel_id: string; root_event_id: string }
export interface BuzzReviewedReceiptRequest { version: 1; event_id: string }

/** Configured operator evidence, independent of relay self-description. A
 * Gateway tenant is not implicitly the relay's community UUID. */
export interface BuzzReviewedInstallationPins {
  communityId: string;
  origin: string;
  relayPubkey: string;
  sourceBuild: string;
  ownerDelegation: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const EPOCH = /^[1-9][0-9]*$/u;
const BUILD = /^axis-[0-9a-f]{40}-[0-9a-f]{64}$/u;
const invalid = (): never => { throw new Error('Invalid reviewed Buzz disclosure material'); };

function exact(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(' ') !== names.split(' ').sort().join(' ')) invalid();
}

function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

export function parseBuzzReviewedInstallationPins(value: unknown): BuzzReviewedInstallationPins {
  exact(value, 'communityId origin relayPubkey sourceBuild ownerDelegation');
  if (typeof value.communityId !== 'string' || !UUID.test(value.communityId)
    || typeof value.relayPubkey !== 'string' || !HEX.test(value.relayPubkey)
    || !origin(value.origin) || typeof value.sourceBuild !== 'string' || !BUILD.test(value.sourceBuild)
    || typeof value.ownerDelegation !== 'boolean') return invalid();
  return { communityId: value.communityId, origin: value.origin, relayPubkey: value.relayPubkey,
    sourceBuild: value.sourceBuild, ownerDelegation: value.ownerDelegation };
}

export function parseBuzzReviewedDisclosureMaterial(value: unknown): BuzzReviewedDisclosureMaterial {
  exact(value, 'version community_id channel_id root_event_id publisher_pubkey relay_pubkey origin source_revision source_build realm_revision channel_revision policy_incarnation reader_policy');
  exact(value.reader_policy, 'http_auth websocket_auth realm_membership owner_delegation mesh');
  const policy = value.reader_policy;
  if (value.version !== 1 || ![value.community_id, value.channel_id].every(item => typeof item === 'string' && UUID.test(item))
    || ![value.root_event_id, value.publisher_pubkey, value.relay_pubkey].every(item => typeof item === 'string' && HEX.test(item))
    || !origin(value.origin) || value.source_revision !== BUZZ_REVIEWED_SOURCE_REVISION
    || typeof value.source_build !== 'string' || !BUILD.test(value.source_build)
    || ![value.realm_revision, value.channel_revision, value.policy_incarnation].every(item => typeof item === 'string' && item.length <= 256 && EPOCH.test(item))
    || policy.http_auth !== true || policy.websocket_auth !== true || policy.realm_membership !== true
    || typeof policy.owner_delegation !== 'boolean' || policy.mesh !== false) return invalid();
  return {
    version: 1, community_id: value.community_id as string, channel_id: value.channel_id as string,
    root_event_id: value.root_event_id as string, publisher_pubkey: value.publisher_pubkey as string,
    relay_pubkey: value.relay_pubkey as string, origin: value.origin, source_revision: BUZZ_REVIEWED_SOURCE_REVISION,
    source_build: value.source_build, realm_revision: value.realm_revision as string,
    channel_revision: value.channel_revision as string, policy_incarnation: value.policy_incarnation as string,
    reader_policy: { http_auth: true, websocket_auth: true, realm_membership: true,
      owner_delegation: policy.owner_delegation, mesh: false },
  };
}

/** Portable UTF-8 length frames (decimal byte length, colon, exact bytes).
 * Order: domain, version, all material scalar fields in interface order,
 * then http_auth, websocket_auth, realm_membership, owner_delegation, mesh.
 * Decimal revisions stay strings, including beyond JavaScript's safe integers. */
export function encodeBuzzReviewedDisclosureMaterial(value: BuzzReviewedDisclosureMaterial): Uint8Array {
  const material = parseBuzzReviewedDisclosureMaterial(value);
  const fields = ['axis.buzz.reviewed-disclosure-material.v1', String(material.version), material.community_id,
    material.channel_id, material.root_event_id, material.publisher_pubkey, material.relay_pubkey, material.origin,
    material.source_revision, material.source_build, material.realm_revision, material.channel_revision, material.policy_incarnation,
    String(material.reader_policy.http_auth), String(material.reader_policy.websocket_auth),
    String(material.reader_policy.realm_membership), String(material.reader_policy.owner_delegation), String(material.reader_policy.mesh)];
  const encoder = new TextEncoder();
  return encoder.encode(fields.map(field => `${encoder.encode(field).byteLength}:${field}`).join(''));
}
