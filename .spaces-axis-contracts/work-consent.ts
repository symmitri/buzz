import type {
  NativeWorkOrigin,
  WorkAudienceReference,
  WorkLifecycleInput,
  WorkLifecycleReceipt,
  WorkSessionReference,
  WorkTaskReference,
} from '@axis/collaboration'

/** Native task account consent is independent of Agent enrollment and pairing.
 * These records never carry credentials or authorize a provider call. */
export type WorkConsentState = 'pending' | 'approved' | 'declined' | 'revoked' | 'expired' | 'stale'
export type WorkConsentDecision = 'approve' | 'decline' | 'revoke'

/** GET /v1/space/work-consents/capabilities: authenticated human metadata,
 * available while record routes are disabled, with no provider/storage calls. */
export interface WorkConsentCapabilities {
  enabled: boolean
  schemaVersion: 1
  lookup: 'native_origin'
}

export interface WorkConsentGranolaScope {
  mechanicsVersion: 1 | 2
  /** Bounded metadata-only timestamp traversal is separately explicit, including
   * when transcript disclosure is false. Never infer recording start from
   * creation time or a partial first page. */
  allowRecordingTimeProbes: boolean
  maxProbePagesPerNote: number
  maxProviderCalls: number
  maxTranscriptPagesPerNote: number
  maxBytes: number
  /** IANA timezone and frozen UTC bounds for actual meeting/recording time.
   * Provider created_at does not establish that a meeting falls in this window. */
  timeZone: string
  meetingStart: string
  meetingEnd: string
  /** latest_meetings has no IDs until #302 durably selects exact eligible notes.
   * exact_notes contains one or two sorted, unique IDs; no wildcard resources.
   * Selection requires terminal complete earliest-observed segment evidence.
    * A full selected recording may extend beyond meetingEnd. Mechanics-v2
    * day_meetings covers a local calendar day, retaining all eligible recordings
    * for task-specific selection; hitting maxNotes reports partial coverage. */
  selection: 'latest_meetings' | 'exact_notes' | 'day_meetings'
  noteIds: string[]
  maxNotes: number
  maxListPages: number
  pageSize: number
  allowedTools: ['list_notes', 'get_note']
  includeTranscript: boolean
}

export interface WorkConsentRequestInput {
  operationId: string
  task: WorkTaskReference
  accountId: string
  taskSummary: string
  scope: WorkConsentGranolaScope
  expiresAt: string
}

/** POST /v1/harness/work-consents/record: runtime-bound current metadata for
 * reconciliation. Returns WorkConsentRecord, always executionEnabled:false. */
export interface WorkConsentRecordReadInput {
  consentId: string
  task: WorkTaskReference
}

/** POST /v1/harness/work-consents/task: derive frozen task metadata from the
 * original immutable admission and ensured #300 fence. No actor/work selector. */
export interface WorkConsentTaskReadInput { admissionRequestId: string }
export interface WorkConsentTaskReadResult { work: WorkSessionReference; task: WorkTaskReference }

export interface WorkConsentTerms {
  orgId: string
  /** Derived from the exact saved account owner, never a model actor selector. */
  grantorId: string
  applicationId: string
  workloadIdentityId: string
  task: WorkTaskReference
  accountId: string
  accountVersion: number
  connectionId: string
  provider: 'granola'
  /** Frozen bounded task purpose, never provider transcript content. */
  taskSummary: string
  scope: WorkConsentGranolaScope
  /** Exact native execution scope / signed 39002 roster, with its unchanged
   * hash; it does not include every relay-admitted public reader. Never present
   * this reference as either complete public readers or private output scope. */
  audience: WorkAudienceReference
  outputAudience: { kind: 'private_contribution'; ownerId: string }
  sharing: 'owner_review_required'
  expiresAt: string
}

export interface WorkConsentRecord {
  id: string
  terms: WorkConsentTerms
  termsDigest: string
  version: number
  state: WorkConsentState
  createdAt: string
  /** Literal false throughout the disabled record/API slice, even if approved. */
  executionEnabled: false
}

/** POST /v1/space/work-consents/:id/decisions. The authenticated current native
 * human session supplies identity; no actor, account, or replacement terms. */
export interface WorkConsentDecisionInput {
  operationId: string
  expectedVersion: number
  termsDigest: string
  decision: WorkConsentDecision
}

export interface WorkConsentDecisionReceipt {
  receiptId: string
  operationId: string
  actorId: string
  consentId: string
  termsDigest: string
  version: number
  decision: WorkConsentDecision
  decidedAt: string
}

export interface WorkConsentDecisionResult {
  /** Historical operation outcome: retries return this same original receipt. */
  receipt: WorkConsentDecisionReceipt
  /** Current authority projection. Replayed approval can return revoked/stale. */
  consent: WorkConsentRecord
}

/** POST /v1/space/work-consents/query. Fixed native thread lookup; no account or
 * person selector. Gateway independently verifies admission and current audience. */
export interface WorkConsentLookupInput {
  origin: NativeWorkOrigin
  /** Optional original admission pin. Native UI can start from verified origin
   * alone; Gateway resolves original admission from its own authoritative fence. */
  admissionRequestId?: string
  /** Position in this owner's history only; not authority or an account selector. */
  before?: WorkConsentLookupCursor
}

export interface WorkConsentLookupCursor {
  createdAt: string
  id: string
}

export interface WorkConsentParticipantStatus {
  grantorId: string
  state: WorkConsentState
}

export interface WorkConsentLookupResult {
  workId: string
  /** Full frozen requests for the authenticated owner only. */
  requests: WorkConsentRecord[]
  /** Other people's consent status only; no account, request ID or task terms. */
  participants: WorkConsentParticipantStatus[]
  /** Continue only own historical requests, using the same verified origin.
   * Peer status remains a separate latest summary; no peer IDs enter this cursor. */
  next?: WorkConsentLookupCursor
}

/** Harness-only inward calls. Native surfaces never receive Host credentials. */
export interface WorkConsentEnsureInput { work: WorkSessionReference; admissionRequestId: string }
export interface WorkConsentLifecycleInput { work: WorkSessionReference; admissionRequestId: string; operation: WorkLifecycleInput }
export type WorkConsentLifecycleReceipt = WorkLifecycleReceipt

export interface WorkConsentExpectedOwner {
  /** Current /v1/me identity and organisation, from the native session boundary. */
  identityId: string
  orgId: string
  consentId?: string
  workId?: string
}

const states: readonly string[] = ['pending', 'approved', 'declined', 'revoked', 'expired', 'stale']
const decisions: readonly string[] = ['approve', 'decline', 'revoke']
function invalid(): never { throw new Error('Invalid work consent response') }
function object(value: unknown, keys: string, optionalKeys = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const required = keys.split(' '), allowed = [...required, ...(optionalKeys ? optionalKeys.split(' ') : [])]
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.\-]{1,256}$/u.test(value)) invalid()
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) invalid()
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
function scope(value: unknown): void {
  const v = object(value, 'mechanicsVersion allowRecordingTimeProbes maxProbePagesPerNote maxProviderCalls maxTranscriptPagesPerNote maxBytes timeZone meetingStart meetingEnd noteIds selection maxNotes maxListPages pageSize allowedTools includeTranscript')
  if (typeof v.timeZone !== 'string' || v.timeZone.length < 1 || v.timeZone.length > 128) invalid()
  try { new Intl.DateTimeFormat('en-US', { timeZone: v.timeZone }).format(0) } catch { invalid() }
  const start = instant(v.meetingStart), end = instant(v.meetingEnd)
  const day = v.selection === 'day_meetings'
  if (end <= start || end - start > (day ? 25 : 24) * 3600_000 || version(v.maxNotes) > (day ? 150 : 2) || version(v.maxListPages) > 5 || version(v.pageSize) > 30) invalid()
  if (!Array.isArray(v.allowedTools) || v.allowedTools.length !== 2 || v.allowedTools[0] !== 'list_notes' || v.allowedTools[1] !== 'get_note' || typeof v.includeTranscript !== 'boolean' || !Array.isArray(v.noteIds)) invalid()
  if (v.mechanicsVersion !== (day ? 2 : 1) || typeof v.allowRecordingTimeProbes !== 'boolean' || version(v.maxProviderCalls) > 128 || version(v.maxBytes) > 16777216) invalid()
  if (v.allowRecordingTimeProbes ? version(v.maxProbePagesPerNote) > 8 : v.maxProbePagesPerNote !== 0) invalid()
  if (v.includeTranscript ? version(v.maxTranscriptPagesPerNote) > 32 : v.maxTranscriptPagesPerNote !== 0) invalid()
  const noteIds = v.noteIds
  if (v.selection === 'latest_meetings' || day) { if (noteIds.length !== 0 || !v.allowRecordingTimeProbes) invalid() }
  else if (v.selection === 'exact_notes') {
    if (noteIds.length < 1 || noteIds.length > Number(v.maxNotes) || noteIds.some((note, i) => typeof note !== 'string' || !/^not_[A-Za-z0-9]{14}$/u.test(note) || i > 0 && String(noteIds[i - 1]) >= note)) invalid()
  } else invalid()
  if (day) {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: String(v.timeZone), calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    const parts = (at: number) => Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]))
    const a = parts(start), b = parts(end)
    const next = new Date(Date.UTC(Number(a.year), Number(a.month) - 1, Number(a.day) + 1)).toISOString().slice(0, 10)
    if (a.hour !== '00' || a.minute !== '00' || a.second !== '00' || b.hour !== '00' || b.minute !== '00' || b.second !== '00' || `${b.year}-${b.month}-${b.day}` !== next || /\.\d*[1-9]\d*Z$/.test(String(v.meetingStart)) || /\.\d*[1-9]\d*Z$/.test(String(v.meetingEnd))) invalid()
  }
}

/** The same frozen scope decoder is shared by unbound intents and account-bound
 * consent records; selecting an account must not introduce different mechanics. */
export function parseWorkConsentGranolaScope(value: unknown): WorkConsentGranolaScope {
  scope(value)
  return value as WorkConsentGranolaScope
}

/** Reject cross-owner/context or undeclared data before rendering frozen terms.
 * Authentication and fresh authority remain Gateway/native-boundary decisions. */
export function parseWorkConsentRecord(value: unknown, expected: WorkConsentExpectedOwner): WorkConsentRecord {
  const v = object(value, 'id terms termsDigest version state createdAt executionEnabled')
  const terms = object(v.terms, 'orgId grantorId applicationId workloadIdentityId task accountId accountVersion connectionId provider taskSummary scope audience outputAudience sharing expiresAt')
  const task = object(terms.task, 'workId requestId requesterId agentId conversationId sessionId bindingVersion audienceVersion audienceDigest authorizationEpoch')
  const audience = object(terms.audience, 'digest revision version')
  const outputAudience = object(terms.outputAudience, 'kind ownerId')
  id(v.id); digest(v.termsDigest); version(v.version)
  if (terms.orgId !== expected.orgId || terms.grantorId !== expected.identityId || expected.consentId !== undefined && v.id !== expected.consentId || expected.workId !== undefined && task.workId !== expected.workId) invalid()
  for (const key of ['orgId', 'grantorId', 'applicationId', 'workloadIdentityId', 'accountId', 'connectionId']) id(terms[key])
  for (const key of ['workId', 'requestId', 'requesterId', 'agentId', 'conversationId', 'sessionId']) id(task[key])
  if (task.bindingVersion !== 1 || task.audienceVersion !== 1 || audience.version !== 1 || digest(task.audienceDigest) !== digest(audience.digest)) invalid()
  version(task.authorizationEpoch); version(terms.accountVersion); digest(audience.revision)
  if (outputAudience.kind !== 'private_contribution' || outputAudience.ownerId !== expected.identityId) invalid()
  if (typeof v.state !== 'string' || !states.includes(v.state) || v.executionEnabled !== false || terms.provider !== 'granola' || terms.sharing !== 'owner_review_required') invalid()
  if (typeof terms.taskSummary !== 'string' || terms.taskSummary.length < 1 || new TextEncoder().encode(terms.taskSummary).byteLength > 512) invalid()
  scope(terms.scope)
  const created = instant(v.createdAt), expires = instant(terms.expiresAt)
  if (expires <= created || expires - created > 24 * 3600_000) invalid()
  return value as WorkConsentRecord
}

/** Validate the historical receipt against its current record without deriving
 * current authority from that receipt's original success. */
export function parseWorkConsentDecisionResult(value: unknown, expected: WorkConsentExpectedOwner & { operationId: string; termsDigest: string; decision: WorkConsentDecision }): WorkConsentDecisionResult {
  const v = object(value, 'receipt consent')
  const consent = parseWorkConsentRecord(v.consent, expected)
  const receipt = object(v.receipt, 'receiptId operationId actorId consentId termsDigest version decision decidedAt')
  id(receipt.receiptId); id(receipt.operationId); id(receipt.actorId); id(receipt.consentId); digest(receipt.termsDigest); instant(receipt.decidedAt)
  if (receipt.actorId !== expected.identityId || receipt.operationId !== expected.operationId || receipt.consentId !== consent.id || receipt.termsDigest !== consent.termsDigest || receipt.termsDigest !== expected.termsDigest || version(receipt.version) > consent.version || receipt.decision !== expected.decision || typeof receipt.decision !== 'string' || !decisions.includes(receipt.decision)) invalid()
  return value as WorkConsentDecisionResult
}

export function parseWorkConsentLookup(value: unknown, expected: WorkConsentExpectedOwner): WorkConsentLookupResult {
  const v = object(value, 'workId requests participants', 'next')
  const workId = id(v.workId)
  if (expected.workId !== undefined && expected.workId !== workId || !Array.isArray(v.requests) || !Array.isArray(v.participants)) invalid()
  if (v.requests.length > 100 || v.participants.length > 128) invalid()
  if (v.next !== undefined) {
    const cursor = object(v.next, 'createdAt id')
    if (instant(cursor.createdAt) <= 0) invalid()
    id(cursor.id)
  }
  const ids = new Set<string>()
  for (const raw of v.requests) {
    const consent = parseWorkConsentRecord(raw, { ...expected, workId })
    if (ids.has(consent.id)) invalid()
    ids.add(consent.id)
  }
  for (const raw of v.participants) {
    const participant = object(raw, 'grantorId state')
    if (id(participant.grantorId) === expected.identityId || typeof participant.state !== 'string' || !states.includes(participant.state)) invalid()
  }
  return value as WorkConsentLookupResult
}

export function parseWorkConsentCapabilities(value: unknown): WorkConsentCapabilities {
  const v = object(value, 'enabled schemaVersion lookup')
  if (typeof v.enabled !== 'boolean' || v.schemaVersion !== 1 || v.lookup !== 'native_origin') invalid()
  return value as WorkConsentCapabilities
}
