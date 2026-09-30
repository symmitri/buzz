import type { WorkAudienceReference, WorkTaskReference } from '@axis/collaboration'
import { parseWorkConsentGranolaScope, parseWorkConsentRecord } from './work-consent.js'
import type { WorkConsentExpectedOwner, WorkConsentGranolaScope, WorkConsentLookupCursor, WorkConsentLookupInput, WorkConsentRecord } from './work-consent.js'

/** Freeze task terms before a human supplies an account. No owner/account selector. */
export interface WorkConsentIntentInput {
  operationId: string
  task: WorkTaskReference
  taskSummary: string
  scope: WorkConsentGranolaScope
  expiresAt: string
  /** Trusted corrective review precondition; never a model-selected account. */
  reviewOf?: { consentId: string; expectedVersion: number; termsDigest: string; recovery?: 'accounted_failure' }
}
export interface WorkConsentIntentTerms {
  orgId: string
  applicationId: string
  workloadIdentityId: string
  task: WorkTaskReference
  taskSummary: string
  scope: WorkConsentGranolaScope
  audience: WorkAudienceReference
  expiresAt: string
}
export interface WorkConsentIntent {
  id: string
  version: number
  digest: string
  createdAt: string
  /** Availability of immutable intent, independent of each owner's binding. */
  state: 'select_account' | 'stale' | 'expired'
  terms: WorkConsentIntentTerms
}
export interface WorkConsentIntentReadInput { intentId: string; task: WorkTaskReference }
/** Runtime metadata only. Never expose these records as shared model/tool output. */
export interface WorkConsentIntentResult { intent: WorkConsentIntent; requests: WorkConsentRecord[] }
export interface WorkConsentIntentSelectionInput {
  operationId: string
  expectedVersion: number
  intentDigest: string
  accountId: string
  accountVersion: number
}
/** Current authenticated owner's eligible accounts, never management inventory. */
export interface WorkConsentIntentAccount {
  accountId: string
  accountVersion: number
  connectionId: string
  provider: 'granola'
  label?: string
  email?: string
}
export interface WorkConsentIntentOwnerResult {
  intent: WorkConsentIntent
  /** Current schema supports zero or one eligible personal Granola account.
   * An empty list means native Profile Connections setup is needed. */
  accounts: WorkConsentIntentAccount[]
  /** May be terminal or reference a disconnected/replaced account. Its frozen
   * account terms remain the cleanup view; current choices cannot replace them. */
  consent?: WorkConsentRecord
}
export type WorkConsentIntentLookupInput = WorkConsentLookupInput
export interface WorkConsentIntentLookupResult { workId: string; intents: WorkConsentIntent[]; next?: WorkConsentLookupCursor }
export interface WorkConsentIntentExpected { orgId: string; intentId?: string; workId?: string; task?: WorkTaskReference }

function invalid(): never { throw new Error('Invalid work consent intent response') }
function object(value: unknown, keys: string, optional = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const required = keys.split(' '), allowed = [...required, ...(optional ? optional.split(' ') : [])]
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.\-]{1,256}$/u.test(value)) invalid()
  return value
}
function digest(value: unknown): void { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) invalid() }
function version(value: unknown): void { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 9007199254740990) invalid() }
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) invalid()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid()
  return parsed
}
function text(value: unknown, max: number): void {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
}
// Validated frozen shapes have no undefined values. Ignore JSON key order while
// retaining every array position, exact field and number in linkage comparisons.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

export function parseWorkConsentIntent(value: unknown, expected: WorkConsentIntentExpected): WorkConsentIntent {
  const v = object(value, 'id version digest createdAt state terms')
  const terms = object(v.terms, 'orgId applicationId workloadIdentityId task taskSummary scope audience expiresAt')
  const task = object(terms.task, 'workId requestId requesterId agentId conversationId sessionId bindingVersion audienceVersion audienceDigest authorizationEpoch')
  const audience = object(terms.audience, 'digest revision version')
  id(v.id); version(v.version); digest(v.digest)
  if (typeof v.state !== 'string' || !['select_account', 'stale', 'expired'].includes(v.state) || terms.orgId !== expected.orgId || expected.intentId !== undefined && v.id !== expected.intentId || expected.workId !== undefined && task.workId !== expected.workId || expected.task !== undefined && !equal(task, expected.task)) invalid()
  for (const key of ['orgId', 'applicationId', 'workloadIdentityId']) id(terms[key])
  for (const key of ['workId', 'requestId', 'requesterId', 'agentId', 'conversationId', 'sessionId']) id(task[key])
  if (task.bindingVersion !== 1 || task.audienceVersion !== 1 || audience.version !== 1 || task.audienceDigest !== audience.digest) invalid()
  digest(task.audienceDigest); digest(audience.digest); digest(audience.revision); version(task.authorizationEpoch)
  if (typeof terms.taskSummary !== 'string' || terms.taskSummary.length === 0 || new TextEncoder().encode(terms.taskSummary).byteLength > 512) invalid()
  parseWorkConsentGranolaScope(terms.scope)
  const created = instant(v.createdAt), expires = instant(terms.expiresAt)
  if (expires <= created || expires - created > 24 * 3600_000) invalid()
  return value as WorkConsentIntent
}

function linkedConsent(value: unknown, intent: WorkConsentIntent, expected: WorkConsentExpectedOwner): WorkConsentRecord {
  const consent = parseWorkConsentRecord(value, { ...expected, workId: intent.terms.task.workId })
  for (const key of ['orgId', 'applicationId', 'workloadIdentityId', 'task', 'taskSummary', 'scope', 'audience', 'expiresAt'] as const) {
    if (!equal(consent.terms[key], intent.terms[key])) invalid()
  }
  return consent
}

export function parseWorkConsentIntentOwnerResult(value: unknown, expected: WorkConsentExpectedOwner & { intentId?: string }): WorkConsentIntentOwnerResult {
  const v = object(value, 'intent accounts', 'consent')
  const intent = parseWorkConsentIntent(v.intent, expected)
  // An omitted projection cannot turn a known binding back into account setup.
  if (expected.consentId !== undefined && v.consent === undefined) invalid()
  if (!Array.isArray(v.accounts) || v.accounts.length > 1) invalid()
  const ids = new Set<string>()
  for (const raw of v.accounts) {
    const account = object(raw, 'accountId accountVersion connectionId provider', 'label email')
    const accountId = id(account.accountId)
    id(account.connectionId); version(account.accountVersion)
    if (account.provider !== 'granola' || ids.has(accountId)) invalid()
    ids.add(accountId)
    if (account.label !== undefined) text(account.label, 256)
    if (account.email !== undefined) text(account.email, 320)
  }
  if (v.consent !== undefined) linkedConsent(v.consent, intent, expected)
  return value as WorkConsentIntentOwnerResult
}

export function parseWorkConsentIntentLookup(value: unknown, expected: WorkConsentIntentExpected): WorkConsentIntentLookupResult {
  const v = object(value, 'workId intents', 'next')
  const workId = id(v.workId)
  if (expected.workId !== undefined && workId !== expected.workId || !Array.isArray(v.intents) || v.intents.length > 100) invalid()
  const ids = new Set<string>()
  for (const raw of v.intents) {
    const intent = parseWorkConsentIntent(raw, { ...expected, workId })
    if (ids.has(intent.id)) invalid()
    ids.add(intent.id)
  }
  if (v.next !== undefined) {
    const cursor = object(v.next, 'createdAt id')
    id(cursor.id)
    if (instant(cursor.createdAt) <= 0) invalid()
  }
  return value as WorkConsentIntentLookupResult
}

/** Current metadata for the exact original runtime/task; neither these records
 * nor a successful parse permit provider use or publication. */
export function parseWorkConsentIntentResult(value: unknown, expected: WorkConsentIntentExpected & { applicationId: string; workloadIdentityId: string; task: WorkTaskReference }): WorkConsentIntentResult {
  const v = object(value, 'intent requests')
  const intent = parseWorkConsentIntent(v.intent, expected)
  if (intent.terms.applicationId !== expected.applicationId || intent.terms.workloadIdentityId !== expected.workloadIdentityId || !Array.isArray(v.requests) || v.requests.length > 128) invalid()
  const owners = new Set<string>(), ids = new Set<string>()
  for (const raw of v.requests) {
    if (!raw || typeof raw !== 'object' || !raw.terms || typeof raw.terms !== 'object') invalid()
    const identityId = id(raw.terms.grantorId)
    const consent = linkedConsent(raw, intent, { orgId: expected.orgId, identityId })
    if (owners.has(identityId) || ids.has(consent.id)) invalid()
    owners.add(identityId); ids.add(consent.id)
  }
  return value as WorkConsentIntentResult
}
