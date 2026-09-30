import type { WorkTaskReference } from '@axis/collaboration'
import type { WorkPrivateExecutionReference } from './work-private-execution.js'
import type { WorkConsentExpectedOwner, WorkConsentLookupCursor, WorkConsentLookupInput, WorkConsentState } from './work-consent.js'

/** Actual durable private contribution progress, never consent or publication. */
export type WorkTaskCheckpointState = 'queued' | 'running' | 'candidate_ready' | 'failed'
export type WorkTaskStatusState = WorkTaskCheckpointState | Exclude<WorkConsentState, 'approved'> | 'unconfirmed'

/** Authenticated runtime POST /v1/harness/work-consents/task-status.
 * The original task is immutable; execution is the separate private incarnation.
 * Current approved authority is checked inside the checkpoint transaction. */
export interface WorkTaskCheckpointInput {
  execution: WorkPrivateExecutionReference
  task: WorkTaskReference
  operationId: string
  /** Zero creates; every accepted update increments the server revision by one. */
  expectedRevision: number
  state: WorkTaskCheckpointState
  /** Required only for queued/running, from 1 through 120 seconds. */
  leaseSeconds?: number
}

export interface WorkTaskCheckpointReceipt {
  operationId: string
  executionId: string
  revision: number
  state: WorkTaskCheckpointState
  updatedAt: string
  leaseExpiresAt?: string
}

/** No account, source text, errors, artifact identifiers or private storage path.
 * Consent identifiers are restricted to this authenticated owner's projection. */
export interface WorkTaskStatus {
  consentId: string
  consentVersion: number
  termsDigest: string
  state: WorkTaskStatusState
  /** Zero means no checkpoint under this current consent incarnation. */
  revision: number
  updatedAt?: string
  leaseExpiresAt?: string
  /** Owner-only outcome metadata, never a source body or permission. */
  failureReason?: 'coverage_incomplete'
}

export interface WorkTaskCheckpointResult {
  /** Exact original operation receipt; replay never restores old authority. */
  receipt: WorkTaskCheckpointReceipt
  current: WorkTaskStatus
}

/** Native owner POST /v1/space/work-consents/task-status/query. Uses the same
 * current signed origin check and owner history cursor as consent lookup. */
export type WorkTaskStatusLookupInput = WorkConsentLookupInput
export interface WorkTaskStatusLookupResult {
  orgId: string
  ownerId: string
  workId: string
  observedAt: string
  statuses: WorkTaskStatus[]
  next?: WorkConsentLookupCursor
}

const states: readonly string[] = ['queued', 'running', 'candidate_ready', 'failed', 'pending', 'declined', 'revoked', 'expired', 'stale', 'unconfirmed']
const lossStates: readonly string[] = ['pending', 'declined', 'revoked', 'expired', 'stale']
function invalid(): never { throw new Error('Invalid work task status response') }
function object(value: unknown, required: string, optional = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const keys = required.split(' '), allowed = [...keys, ...optional.split(' ')]
  if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:.\-]{1,256}$/u.test(value)) invalid()
  return value
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value >= 9007199254740990) invalid()
  return value
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) invalid()
  const at = Date.parse(value)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19)) invalid()
  return at
}

/** Apply at render time as well as after a response; an expired execution lease
 * cannot remain displayed as queued/running while native refresh is offline. */
export function currentWorkTaskStatus(status: WorkTaskStatus, now = Date.now()): WorkTaskStatus {
  if ((status.state === 'queued' || status.state === 'running') && (!Number.isFinite(now) || status.leaseExpiresAt === undefined || Date.parse(status.leaseExpiresAt) <= now || !Number.isFinite(Date.parse(status.leaseExpiresAt)))) {
    const { leaseExpiresAt: _, ...rest } = status
    return { ...rest, state: 'unconfirmed' }
  }
  return status
}

/** Decode only the authenticated owner's metadata. A lease that expires during
 * transport is explicitly unconfirmed; clients must also expire displayed leases.
 * This decoder does not turn status into execution or disclosure authority. */
export function parseWorkTaskStatusLookup(value: unknown, expected: WorkConsentExpectedOwner, now = Date.now()): WorkTaskStatusLookupResult {
  const v = object(value, 'orgId ownerId workId observedAt statuses', 'next')
  if (id(v.orgId) !== expected.orgId || id(v.ownerId) !== expected.identityId || expected.workId !== undefined && v.workId !== expected.workId) invalid()
  id(v.workId)
  const observed = instant(v.observedAt)
  if (!Number.isFinite(now) || observed > now + 5_000 || !Array.isArray(v.statuses) || v.statuses.length > 100) invalid()
  if (v.next !== undefined) {
    const cursor = object(v.next, 'createdAt id')
    if (instant(cursor.createdAt) <= 0) invalid()
    id(cursor.id)
  }
  const ids = new Set<string>()
  const statuses = v.statuses.map(raw => {
    const status = object(raw, 'consentId consentVersion termsDigest state revision', 'updatedAt leaseExpiresAt failureReason')
    const consentId = id(status.consentId)
    if (ids.has(consentId) || expected.consentId !== undefined && consentId !== expected.consentId) invalid()
    ids.add(consentId)
    integer(status.consentVersion, 1)
    const revision = integer(status.revision, 0)
    if (typeof status.termsDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(status.termsDigest) || typeof status.state !== 'string' || !states.includes(status.state)) invalid()
    const updated = status.updatedAt === undefined ? undefined : instant(status.updatedAt)
    if (updated !== undefined && updated > observed || revision === 0 && updated !== undefined || revision > 0 && updated === undefined) invalid()
    if (lossStates.includes(status.state) && (revision !== 0 || status.leaseExpiresAt !== undefined)) invalid()
    const active = status.state === 'queued' || status.state === 'running'
    if (active && (revision === 0 || status.leaseExpiresAt === undefined) || !active && status.leaseExpiresAt !== undefined) invalid()
    if (status.state === 'candidate_ready' || status.state === 'failed') { if (revision === 0) invalid() }
    if (status.failureReason !== undefined && (status.state !== 'failed' || status.failureReason !== 'coverage_incomplete')) invalid()
    if (active) {
      const lease = instant(status.leaseExpiresAt)
      if (updated === undefined || lease <= updated || lease - updated > 120_000 || lease <= observed) invalid()
    }
    return currentWorkTaskStatus(raw as WorkTaskStatus, now)
  })
  return { ...value as WorkTaskStatusLookupResult, statuses }
}
