import type { NativeWorkOrigin } from '@axis/collaboration'
import type { BuzzEvent } from '@axis/buzz/event-contract'
import type { BuzzPublicDisclosureObservation } from '@axis/buzz/disclosure-contract'
import { encodeBuzzReleasePayload, BUZZ_RELEASE_MAX_CONTENT_BYTES } from '@axis/buzz/release-contract'
import {
  encodeBuzzReviewedDisclosureMaterial, parseBuzzReviewedDisclosureMaterial,
  type BuzzReviewedDisclosureMaterial,
} from '@axis/buzz/reviewed-publication-contract'
import { parseWorkContributionCandidateReference, type WorkContributionCandidateReference } from './work-contribution.js'

export type WorkReleaseState = 'pending' | 'approved' | 'declined' | 'revoked' | 'expired' | 'stale' | 'publishing' | 'unknown' | 'delivered'
export type WorkReleaseDecision = 'approve' | 'decline' | 'revoke'

/** Authorization metadata only. Selected Markdown and source URLs stay out of
 * Gateway records and all shared status/events until exact reviewed release. */
export interface WorkReleaseTerms {
  schemaVersion: 1
  orgId: string
  ownerId: string
  initiatorId: string
  applicationId: string
  workloadIdentityId: string
  accountId: string
  accountVersion: number
  connectionId: string
  candidate: WorkContributionCandidateReference
  originalSource: { eventId: string; pubkey: string }
  destination: NativeWorkOrigin
  disclosure: BuzzPublicDisclosureObservation
  publicationMaterial: BuzzReviewedDisclosureMaterial
  publicationMaterialDigest: string
  agentPubkey: string
  payloadTags: string[][]
  payloadDigest: string
  publicationOperationId: string
  expiresAt: string
}
export interface WorkReleaseRecord {
  id: string
  terms: WorkReleaseTerms
  termsDigest: string
  version: number
  state: WorkReleaseState
  createdAt: string
  /** Availability is not authority. Current Gateway consume remains separate. */
  publicationEnabled: boolean
}
export interface WorkReleaseCapabilities {
  enabled: boolean
  schemaVersion: 1
  publicationEnabled: boolean
  releaseBlocker: string
}
export interface WorkReleaseLookupInput { origin: NativeWorkOrigin; admissionRequestId?: string }
export interface WorkReleaseLookupResult { workId: string; releases: WorkReleaseRecord[]; truncated: boolean }
export interface WorkReleasePreviewResult { release: WorkReleaseRecord; candidate: WorkContributionCandidateReference; markdown: string }
export interface WorkReleaseDecisionInput {
  operationId: string
  expectedVersion: number
  termsDigest: string
  payloadDigest: string
  decision: WorkReleaseDecision
}
export interface WorkReleaseDecisionReceipt {
  receiptId: string
  operationId: string
  actorId: string
  releaseId: string
  termsDigest: string
  payloadDigest: string
  version: number
  decision: WorkReleaseDecision
  decidedAt: string
}
export interface WorkReleaseDecisionResult { receipt: WorkReleaseDecisionReceipt; release: WorkReleaseRecord }
export interface WorkReleaseExpectedOwner {
  identityId: string
  orgId: string
  workId?: string
  releaseId?: string
  origin?: NativeWorkOrigin
}
export interface WorkReleaseRequestInput {
  operationId: string
  candidate: WorkContributionCandidateReference
  payloadDigest: string
  destination: NativeWorkOrigin
  disclosure: BuzzPublicDisclosureObservation
  publicationOperationId: string
  expiresAt: string
  publicationProof: BuzzEvent
}
export interface WorkReleaseRecordReadInput { releaseId: string; candidate: WorkContributionCandidateReference }
/** Trusted edge only, after current native approval. No ticket or preparation
 * route is available to the renderer or to preapproval candidate preparation. */
export interface WorkReleasePrepareInput extends WorkReleaseRecordReadInput { expectedVersion: number; termsDigest: string }
export interface WorkReleasePrepareResult { ticket: string; candidate: WorkContributionCandidateReference; expiresAt: string }
/** Exact signed event crosses Gateway transiently for digest verification; only
 * event/proof IDs and authority metadata may be persisted there. */
export interface WorkReleaseConsumeInput extends WorkReleaseRecordReadInput {
  operationId: string
  expectedVersion: number
  termsDigest: string
  payloadDigest: string
  event: BuzzEvent
  proof: BuzzEvent
}
export interface WorkReleasePublicationReceiptInput { releaseId: string; operationId: string; eventId: string; receipt: BuzzEvent }
/** Gateway authorization boundary only. A delivered receipt additionally needs
 * the independently verified original relay acceptance in the private journal. */
export interface WorkReleasePublicationReceipt {
  operationId: string
  releaseId: string
  eventId: string
  proofId: string
  materialDigest: string
  termsDigest: string
  payloadDigest: string
  approverId: string
  version: number
  consumedAt: string
  deadline: string
  proofIssuedAt: number
  proofExpiresAt: number
  /** ID of the signed relay acceptance event, distinct from eventId (message). */
  acceptedEventId?: string
  acceptedAt?: string
}
export interface WorkReleaseConsumeResult {
  receipt: WorkReleasePublicationReceipt
  release: WorkReleaseRecord
  dispatchAllowed: boolean
}
export interface WorkReleasePreviewCheckInput { ticket: string; candidate: WorkContributionCandidateReference }
export interface WorkReleasePreviewCheckResult { current: true }

const originKeys = 'orgId tenantId relayUrl relayPubkey channelId rootEventId'
const taskKeys = 'workId requestId requesterId agentId conversationId sessionId bindingVersion audienceVersion audienceDigest authorizationEpoch'
const candidateKeys = 'candidateId contentDigest version execution task mediaType byteLength createdAt'
const disclosureKeys = 'predicate readers tenantId relayOrigin relayPubkey channelId channelType sourceEventId threadRootId channelMetadataEventId realmMembershipEventId deploymentEvidenceDigest observedAt expiresAt disclosureDigest publicationSupported releaseBlocker'
const termsKeys = 'schemaVersion orgId ownerId initiatorId applicationId workloadIdentityId accountId accountVersion connectionId candidate originalSource destination disclosure publicationMaterial publicationMaterialDigest agentPubkey payloadTags payloadDigest publicationOperationId expiresAt'
const states: readonly string[] = ['pending', 'approved', 'declined', 'revoked', 'expired', 'stale', 'publishing', 'unknown', 'delivered']
const decisions: readonly string[] = ['approve', 'decline', 'revoke']
const encoder = new TextEncoder()
function invalid(): never { throw new Error('Invalid work release response') }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(' ') !== keys.split(' ').sort().join(' ')) invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.\-]{1,256}$/u.test(value)) invalid()
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid()
  return value
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 9007199254740990) invalid()
  return value
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) invalid()
  const at = Date.parse(value)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid()
  return at
}
function ordered(value: unknown, keys: string): Record<string, unknown> {
  const v = object(value, keys)
  return Object.fromEntries(keys.split(' ').map(key => [key, v[key]]))
}
function snapshot(value: unknown): unknown {
  // Native HTTP is separately bounded. Copy before the first hash await so
  // concurrent UI updates cannot substitute a suffix or different terms.
  try {
    let nodes = 0
    const jsonValue = (item: unknown, depth: number): void => {
      if (++nodes > 100_000 || depth > 64) invalid()
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return
      if (typeof item === 'number' && Number.isFinite(item)) return
      if (!item || typeof item !== 'object') invalid()
      const array = Array.isArray(item)
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid()
      const keys = Reflect.ownKeys(item)
      if (array && keys.length !== (item as unknown[]).length + 1) invalid()
      for (const key of keys) {
        if (array && key === 'length') continue
        const prop = Object.getOwnPropertyDescriptor(item, key)!
        if (typeof key !== 'string' || !prop.enumerable || !Object.hasOwn(prop, 'value')
          || array && !/^(0|[1-9][0-9]*)$/u.test(key)) invalid()
        jsonValue(prop.value, depth + 1)
      }
    }
    jsonValue(value, 0)
    const raw = JSON.stringify(value)
    if (!raw || encoder.encode(raw).byteLength > 512 * 1024) invalid()
    return JSON.parse(raw)
  } catch { return invalid() }
}
async function sha(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')
}
function canonicalTerms(terms: WorkReleaseTerms): Record<string, unknown> {
  const candidate = ordered(terms.candidate, candidateKeys)
  candidate.execution = ordered(candidate.execution, 'id consentId consentVersion termsDigest')
  candidate.task = ordered(candidate.task, taskKeys)
  return {
    ...ordered(terms, termsKeys), candidate,
    originalSource: ordered(terms.originalSource, 'eventId pubkey'),
    destination: ordered(terms.destination, originKeys),
    disclosure: ordered(terms.disclosure, disclosureKeys),
    publicationMaterial: parseBuzzReviewedDisclosureMaterial(terms.publicationMaterial),
  }
}
export async function workReleaseTermsDigest(terms: WorkReleaseTerms): Promise<string> {
  return sha(encoder.encode(JSON.stringify(canonicalTerms(terms))))
}
function nativeOrigin(value: unknown): NativeWorkOrigin {
  const v = object(value, originKeys)
  id(v.orgId); id(v.tenantId); digest(v.relayPubkey); digest(v.rootEventId)
  if (typeof v.channelId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v.channelId)) invalid()
  if (typeof v.relayUrl !== 'string') invalid()
  const origin = new URL(v.relayUrl)
  if (origin.protocol !== 'https:' || origin.origin !== v.relayUrl || origin.username || origin.password) invalid()
  return v as unknown as NativeWorkOrigin
}
function ownerPins<T extends WorkReleaseExpectedOwner>(value: T): T {
  return { ...value, ...(value.origin === undefined ? {} : { origin: nativeOrigin({ ...value.origin }) }) }
}
async function record(value: unknown, expected: WorkReleaseExpectedOwner): Promise<WorkReleaseRecord> {
  const v = object(value, 'id terms termsDigest version state createdAt publicationEnabled')
  const raw = object(v.terms, termsKeys)
  for (const key of ['orgId', 'ownerId', 'initiatorId', 'applicationId', 'workloadIdentityId', 'accountId', 'connectionId', 'publicationOperationId']) id(raw[key])
  if (raw.orgId !== expected.orgId || raw.ownerId !== expected.identityId || raw.schemaVersion !== 1
    || expected.releaseId !== undefined && v.id !== expected.releaseId) invalid()
  id(v.id); digest(v.termsDigest); version(v.version); version(raw.accountVersion)
  if (typeof v.state !== 'string' || !states.includes(v.state) || typeof v.publicationEnabled !== 'boolean') invalid()
  const candidate = await parseWorkContributionCandidateReference(raw.candidate)
  if (candidate.byteLength > BUZZ_RELEASE_MAX_CONTENT_BYTES || candidate.task.requesterId !== raw.initiatorId
    || expected.workId !== undefined && candidate.task.workId !== expected.workId) invalid()
  const destination = nativeOrigin(raw.destination)
  if (destination.orgId !== expected.orgId || expected.origin !== undefined
    && JSON.stringify(ordered(destination, originKeys)) !== JSON.stringify(ordered(expected.origin, originKeys))) invalid()
  const source = object(raw.originalSource, 'eventId pubkey')
  digest(source.eventId); digest(source.pubkey)
  const requestId = 'buzz_' + await sha(encoder.encode(JSON.stringify([
    destination.tenantId, destination.relayPubkey, digest(raw.agentPubkey), source.eventId,
  ])))
  if (candidate.task.requestId !== requestId) invalid()
  const disclosure = object(raw.disclosure, disclosureKeys)
  if (disclosure.predicate !== 'buzz-native-public-realm-v1' || disclosure.publicationSupported !== false
    || disclosure.releaseBlocker !== 'relay-compare-consume-unavailable' || !['stream', 'forum'].includes(String(disclosure.channelType))) invalid()
  for (const key of ['sourceEventId', 'threadRootId', 'channelMetadataEventId', 'realmMembershipEventId', 'deploymentEvidenceDigest', 'disclosureDigest']) digest(disclosure[key])
  if (disclosure.sourceEventId !== source.eventId || disclosure.tenantId !== destination.tenantId
    || disclosure.relayOrigin !== destination.relayUrl || disclosure.relayPubkey !== destination.relayPubkey
    || disclosure.channelId !== destination.channelId || disclosure.threadRootId !== destination.rootEventId
    || version(disclosure.expiresAt) <= version(disclosure.observedAt)
    || Number(disclosure.expiresAt) - Number(disclosure.observedAt) > 30) invalid()
  const material = parseBuzzReviewedDisclosureMaterial(raw.publicationMaterial)
  if (material.origin !== destination.relayUrl || material.relay_pubkey !== destination.relayPubkey
    || material.channel_id !== destination.channelId || material.root_event_id !== destination.rootEventId
    || material.publisher_pubkey !== digest(raw.agentPubkey)
    || disclosure.readers !== (material.reader_policy.owner_delegation ? 'admitted-realm-members-and-owner-delegated-agents' : 'admitted-realm-members')) invalid()
  if (await sha(encodeBuzzReviewedDisclosureMaterial(material)) !== digest(raw.publicationMaterialDigest)) invalid()
  const expectedTags = [['h', destination.channelId], ['e', destination.rootEventId, '', 'root'], ['e', destination.rootEventId, '', 'reply'], ['axis-reviewed', '1']]
  if (JSON.stringify(raw.payloadTags) !== JSON.stringify(expectedTags)) invalid()
  digest(raw.payloadDigest)
  const created = instant(v.createdAt), expiry = instant(raw.expiresAt)
  // The Gateway permits at most five seconds of Host clock skew when freezing
  // the candidate reference. Keep accepted immutable records readable here.
  if (expiry <= created || expiry - created > 24 * 3600_000 || instant(candidate.createdAt) > created + 5000) invalid()
  const result = v as unknown as WorkReleaseRecord
  if (await workReleaseTermsDigest(result.terms) !== result.termsDigest) invalid()
  return result
}

export async function parseWorkReleaseRecord(value: unknown, expected: WorkReleaseExpectedOwner): Promise<WorkReleaseRecord> {
  try { return await record(snapshot(value), ownerPins(expected)) } catch { return invalid() }
}
export async function parseWorkReleaseLookup(value: unknown, expected: WorkReleaseExpectedOwner): Promise<WorkReleaseLookupResult> {
  try {
    expected = ownerPins(expected)
    const v = object(snapshot(value), 'workId releases truncated')
    const workId = id(v.workId)
    if (expected.workId !== undefined && expected.workId !== workId || !Array.isArray(v.releases) || v.releases.length > 100 || typeof v.truncated !== 'boolean') invalid()
    const releases: WorkReleaseRecord[] = [], ids = new Set<string>()
    for (const item of v.releases) {
      const current = await record(item, { ...expected, workId })
      if (ids.has(current.id)) invalid()
      ids.add(current.id); releases.push(current)
    }
    return { workId, releases, truncated: v.truncated }
  } catch { return invalid() }
}
export async function verifyWorkReleasePreview(value: WorkReleasePreviewResult): Promise<boolean> {
  try {
    const v = object(snapshot(value), 'release candidate markdown')
    const release = v.release as WorkReleaseRecord
    const candidate = await parseWorkContributionCandidateReference(v.candidate, release.terms.candidate)
    if (typeof v.markdown !== 'string' || encoder.encode(v.markdown).byteLength !== candidate.byteLength
      || await sha(encoder.encode(v.markdown)) !== candidate.contentDigest) return false
    return await sha(encodeBuzzReleasePayload({ agentPubkey: release.terms.agentPubkey, content: v.markdown, tags: release.terms.payloadTags })) === release.terms.payloadDigest
  } catch { return false }
}
export async function parseWorkReleasePreview(value: unknown, expected: WorkReleaseExpectedOwner): Promise<WorkReleasePreviewResult> {
  try {
    expected = ownerPins(expected)
    const v = object(snapshot(value), 'release candidate markdown')
    const release = await record(v.release, { ...expected })
    const candidate = await parseWorkContributionCandidateReference(v.candidate, release.terms.candidate)
    if (typeof v.markdown !== 'string') invalid()
    const preview = { release, candidate, markdown: v.markdown }
    if (!await verifyWorkReleasePreview(preview)) invalid()
    return preview
  } catch { return invalid() }
}
export async function parseWorkReleaseDecisionResult(value: unknown, expected: WorkReleaseExpectedOwner & {
  operationId: string; termsDigest: string; payloadDigest: string; decision: WorkReleaseDecision
}): Promise<WorkReleaseDecisionResult> {
  try {
    expected = ownerPins(expected)
    const v = object(snapshot(value), 'receipt release')
    const release = await record(v.release, { ...expected })
    const r = object(v.receipt, 'receiptId operationId actorId releaseId termsDigest payloadDigest version decision decidedAt')
    id(r.receiptId); id(r.operationId); id(r.actorId); id(r.releaseId); instant(r.decidedAt)
    if (r.operationId !== expected.operationId || r.actorId !== expected.identityId || r.releaseId !== release.id
      || digest(r.termsDigest) !== expected.termsDigest || r.termsDigest !== release.termsDigest
      || digest(r.payloadDigest) !== expected.payloadDigest || r.payloadDigest !== release.terms.payloadDigest
      || r.decision !== expected.decision || !decisions.includes(String(r.decision)) || version(r.version) > release.version) invalid()
    return { receipt: r as unknown as WorkReleaseDecisionReceipt, release }
  } catch { return invalid() }
}
export function parseWorkReleaseCapabilities(value: unknown): WorkReleaseCapabilities {
  try {
    const v = object(value, 'enabled schemaVersion publicationEnabled releaseBlocker')
    if (v.schemaVersion !== 1 || typeof v.enabled !== 'boolean' || typeof v.publicationEnabled !== 'boolean'
      || typeof v.releaseBlocker !== 'string' || !/^[a-z_-]{0,128}$/u.test(v.releaseBlocker)) invalid()
    return v as unknown as WorkReleaseCapabilities
  } catch { return invalid() }
}

/** Exact immutable consume replay may return its old authority receipt beside
 * a newer current state. Only a fresh dispatchAllowed and the private journal's
 * sole dispatch claim can advance a never-dispatched event. */
export async function parseWorkReleaseConsumeResult(value: unknown, expected: {
  approved: WorkReleaseRecord; input: WorkReleaseConsumeInput
  /** Exact independently verified relay acceptance, required for delivery. */
  acceptance?: BuzzEvent
}): Promise<WorkReleaseConsumeResult> {
  try {
    const pins = snapshot(expected) as typeof expected
    const v = object(snapshot(value), 'receipt release dispatchAllowed')
    const approved = pins.approved, input = pins.input
    if (approved.state !== 'approved' || input.expectedVersion !== approved.version) invalid()
    const { issued_at: issuedAt, expires_at: expiresAt, ...proofMaterial } = JSON.parse(input.proof.content)
    if (await sha(encodeBuzzReviewedDisclosureMaterial(parseBuzzReviewedDisclosureMaterial(proofMaterial))) !== approved.terms.publicationMaterialDigest) invalid()
    const release = await record(v.release, { identityId: approved.terms.ownerId, orgId: approved.terms.orgId,
      workId: approved.terms.candidate.task.workId, releaseId: approved.id, origin: approved.terms.destination })
    if (release.termsDigest !== approved.termsDigest || input.releaseId !== approved.id
      || input.termsDigest !== approved.termsDigest || input.payloadDigest !== approved.terms.payloadDigest
      || input.operationId !== approved.terms.publicationOperationId || typeof v.dispatchAllowed !== 'boolean') invalid()
    await parseWorkContributionCandidateReference(input.candidate, approved.terms.candidate)
    const raw = v.receipt as Record<string, unknown>
    const accepted = raw?.acceptedEventId !== undefined || raw?.acceptedAt !== undefined
    if (accepted !== (release.state === 'delivered')) invalid()
    const r = object(raw, 'operationId releaseId eventId proofId materialDigest termsDigest payloadDigest approverId version consumedAt deadline proofIssuedAt proofExpiresAt'
      + (accepted ? ' acceptedEventId acceptedAt' : ''))
    if (r.operationId !== input.operationId || r.releaseId !== input.releaseId || r.eventId !== digest(input.event.id)
      || r.proofId !== digest(input.proof.id) || r.termsDigest !== input.termsDigest || r.payloadDigest !== input.payloadDigest
      || r.materialDigest !== approved.terms.publicationMaterialDigest || r.approverId !== approved.terms.ownerId
      || version(r.version) !== input.expectedVersion + 1 || Number(r.version) > release.version
      || version(r.proofIssuedAt) !== input.proof.created_at || r.proofIssuedAt !== issuedAt || r.proofExpiresAt !== expiresAt
      || version(r.proofExpiresAt) <= Number(r.proofIssuedAt)
      || Number(r.proofExpiresAt) - Number(r.proofIssuedAt) > 120) invalid()
    const consumed = instant(r.consumedAt), deadline = instant(r.deadline)
    if (consumed < Number(r.proofIssuedAt) * 1000 || deadline <= consumed
      || deadline > Number(r.proofExpiresAt) * 1000 || deadline > instant(approved.terms.expiresAt)
      || v.dispatchAllowed && (release.state !== 'publishing' || release.version !== r.version || accepted)) invalid()
    if (accepted && (!pins.acceptance || digest(r.acceptedEventId) !== digest(pins.acceptance.id)
      || instant(r.acceptedAt) !== version(pins.acceptance.created_at) * 1000
      || instant(r.acceptedAt) < Math.floor(consumed / 1000) * 1000
      || instant(r.acceptedAt) >= deadline || release.version <= Number(r.version) || v.dispatchAllowed)) invalid()
    return { receipt: r as unknown as WorkReleasePublicationReceipt, release, dispatchAllowed: v.dispatchAllowed }
  } catch { return invalid() }
}
