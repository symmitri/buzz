import type { WorkTaskReference } from '@axis/collaboration'
import { parseWorkConsentGranolaScope, type WorkConsentGranolaScope } from './work-consent.js'

export const WORK_PRIVATE_EXECUTION_READ_PATH = '/v1/harness/work-consents/read-granola-contribution'
export const WORK_PRIVATE_EXECUTION_CHECK_PATH = '/v1/harness/work-consents/check-execution'

/** Deterministic private result namespace, never a capability or a session.
 * Gateway independently checks current consent and the original task on every
 * operation. A historical approval receipt cannot supply consentVersion. */
export interface WorkPrivateExecutionReference {
  id: string
  consentId: string
  consentVersion: number
  termsDigest: string
}

export interface WorkPrivateExecutionCheckInput {
  execution: WorkPrivateExecutionReference
  /** Original verified native request/session/initiator, never a private session substitute. */
  task: WorkTaskReference
}

/** This is a point-in-time check, not a reusable proof or an enabled consent record. */
export interface WorkPrivateExecutionCheckResult extends WorkPrivateExecutionCheckInput {
  current: true
}

export interface WorkGranolaContributionReadInput extends WorkPrivateExecutionCheckInput {
  /** Durable exact operation identity. A lost response must not become a fresh read. */
  operationId: string
}

/** Private selected source only. Never send this shape to shared task status,
 * telemetry or a native thread. Gateway projects permitted provider fields. */
export interface WorkGranolaContributionSource {
  noteId: string
  /** Earliest observed available segment after complete timestamp traversal;
   * this does not assert the recorder started at that instant. */
  recordingStart: string
  /** Latest observed segment end; the full selected recording may extend past the window. */
  recordingEnd: string
  note?: Record<string, unknown>
  transcript?: Array<Record<string, unknown>>
  transcriptComplete: boolean
}

export interface WorkGranolaContributionReadResult {
  execution: WorkPrivateExecutionReference
  operationId: string
  outcome: 'complete' | 'partial' | 'verified_empty' | 'provider_failed' | 'unrecoverable'
  /** Complete means the approved selection's coverage was proven, never just a terminal list page. */
  coverage: 'complete' | 'partial' | 'unknown'
  counters: { providerCalls: number; bytes: number; listPages: number }
  sources: WorkGranolaContributionSource[]
}

const maxBytes = 16 * 1024 * 1024
const taskIDs = ['workId', 'requestId', 'requesterId', 'agentId', 'conversationId', 'sessionId'] as const
const taskKeys = [...taskIDs, 'bindingVersion', 'audienceVersion', 'audienceDigest', 'authorizationEpoch'] as const

function invalid(): never { throw new Error('Invalid private execution contract') }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid()
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
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
function version(value: unknown): number { return integer(value, 1, 9007199254740989) }
function taskReference(value: unknown): WorkTaskReference {
  const v = object(value, taskKeys)
  if (v.bindingVersion !== 1 || v.audienceVersion !== 1) invalid()
  return {
    workId: id(v.workId), requestId: id(v.requestId), requesterId: id(v.requesterId),
    agentId: id(v.agentId), conversationId: id(v.conversationId), sessionId: id(v.sessionId),
    bindingVersion: 1, audienceVersion: 1, audienceDigest: digest(v.audienceDigest),
    authorizationEpoch: version(v.authorizationEpoch),
  }
}

/** Portable WebCrypto derivation of the agreed JSON-array identity. The inputs
 * must come from current approved immutable terms, not model selectors. */
export async function createWorkPrivateExecutionReference(value: Omit<WorkPrivateExecutionReference, 'id'>): Promise<WorkPrivateExecutionReference> {
  const v = object(value, ['consentId', 'consentVersion', 'termsDigest'])
  const consentId = id(v.consentId), consentVersion = version(v.consentVersion), termsDigest = digest(v.termsDigest)
  const bytes = new TextEncoder().encode(JSON.stringify([consentId, termsDigest, consentVersion]))
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const suffix = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  return { id: `contribution_${suffix}`, consentId, consentVersion, termsDigest }
}

/** Strict JSON reference validation includes recomputation, not just an ID prefix check. */
export async function parseWorkPrivateExecutionReference(value: unknown, expected?: WorkPrivateExecutionReference): Promise<WorkPrivateExecutionReference> {
  const v = object(value, ['id', 'consentId', 'consentVersion', 'termsDigest'])
  const suppliedID = id(v.id)
  const execution = await createWorkPrivateExecutionReference({ consentId: id(v.consentId), consentVersion: version(v.consentVersion), termsDigest: digest(v.termsDigest) })
  if (suppliedID !== execution.id) invalid()
  if (expected !== undefined) {
    const checked = await parseWorkPrivateExecutionReference(expected)
    if (execution.id !== checked.id || execution.consentId !== checked.consentId || execution.consentVersion !== checked.consentVersion || execution.termsDigest !== checked.termsDigest) invalid()
  }
  return execution
}

async function checkInput(value: unknown, expected?: WorkPrivateExecutionCheckInput): Promise<WorkPrivateExecutionCheckInput> {
  const v = object(value, ['execution', 'task'])
  const task = taskReference(v.task)
  const execution = await parseWorkPrivateExecutionReference(v.execution, expected?.execution)
  if (expected !== undefined) {
    const checkedTask = taskReference(expected.task)
    if (taskKeys.some(key => task[key] !== checkedTask[key])) invalid()
  }
  return { execution, task }
}

export async function parseWorkPrivateExecutionCheckInput(value: unknown, expected?: WorkPrivateExecutionCheckInput): Promise<WorkPrivateExecutionCheckInput> {
  return checkInput(value, expected)
}

export async function parseWorkGranolaContributionReadInput(value: unknown, expected?: WorkGranolaContributionReadInput): Promise<WorkGranolaContributionReadInput> {
  const v = object(value, ['execution', 'task', 'operationId'])
  const operationId = id(v.operationId)
  if (expected !== undefined && operationId !== id(expected.operationId)) invalid()
  return { ...await checkInput({ execution: v.execution, task: v.task }, expected), operationId }
}

export async function parseWorkPrivateExecutionCheckResult(value: unknown, expected: WorkPrivateExecutionCheckInput): Promise<WorkPrivateExecutionCheckResult> {
  const v = object(value, ['execution', 'task', 'current'])
  if (v.current !== true) invalid()
  return { ...await checkInput({ execution: v.execution, task: v.task }, expected), current: true }
}

function instant(value: unknown): string {
  if (typeof value !== 'string') invalid()
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value)
  if (!match) invalid()
  const at = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== match[1]) invalid()
  // Compare full nanoseconds; Date alone would round sub-millisecond evidence.
  return `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`
}

/** Reject non-JSON bodies and avoid retaining caller-mutable objects across hash awaits. */
function privateJSON(value: unknown, depth = 0): unknown {
  if (depth > 64) invalid()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value }
  if (!value || typeof value !== 'object') invalid()
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1 || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))) invalid()
    return value.map(item => privateJSON(item, depth + 1))
  }
  const v = object(value, [], Object.keys(value))
  return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, privateJSON(item, depth + 1)]))
}

function privateObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return privateJSON(value) as Record<string, unknown>
}

export async function parseWorkGranolaContributionReadResult(value: unknown, expected: WorkGranolaContributionReadInput, scope?: WorkConsentGranolaScope): Promise<WorkGranolaContributionReadResult> {
  if (scope) parseWorkConsentGranolaScope(scope)
  const v = object(value, ['execution', 'operationId', 'outcome', 'coverage', 'counters', 'sources'])
  const operationId = id(v.operationId)
  if (operationId !== id(expected.operationId)) invalid()
  const outcome = v.outcome, coverage = v.coverage
  if (outcome !== 'complete' && outcome !== 'partial' && outcome !== 'verified_empty' && outcome !== 'provider_failed' && outcome !== 'unrecoverable') invalid()
  if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'unknown') invalid()
  const c = object(v.counters, ['providerCalls', 'bytes', 'listPages'])
  const counters = { providerCalls: integer(c.providerCalls, 0, 128), bytes: integer(c.bytes, 0, maxBytes), listPages: integer(c.listPages, 0, 5) }
  if (counters.listPages > counters.providerCalls || !Array.isArray(v.sources) || v.sources.length > (scope?.maxNotes ?? 2) || Object.keys(v.sources).length !== v.sources.length) invalid()
  const seen = new Set<string>()
  const sources = v.sources.map(raw => {
    const source = object(raw, ['noteId', 'recordingStart', 'recordingEnd', 'transcriptComplete'], ['note', 'transcript'])
    const noteId = id(source.noteId)
    if (!/^not_[A-Za-z0-9]{14}$/u.test(noteId) || seen.has(noteId) || instant(source.recordingEnd) < instant(source.recordingStart) || typeof source.transcriptComplete !== 'boolean') invalid()
    seen.add(noteId)
    if (scope && (instant(source.recordingStart) < instant(scope.meetingStart) || instant(source.recordingStart) >= instant(scope.meetingEnd))) invalid()
    const result: WorkGranolaContributionSource = { noteId, recordingStart: source.recordingStart as string, recordingEnd: source.recordingEnd as string, transcriptComplete: source.transcriptComplete }
    if (Object.hasOwn(source, 'note')) {
      result.note = privateObject(source.note)
    }
    if (Object.hasOwn(source, 'transcript')) {
      if (!Array.isArray(source.transcript)) invalid()
      const transcript = privateJSON(source.transcript) as unknown[]
      result.transcript = transcript.map(privateObject)
    }
    return result
  })
  if ((outcome === 'complete' || outcome === 'verified_empty') && coverage !== 'complete') invalid()
  if (outcome === 'complete' && (sources.length === 0 || sources.some(source => source.note === undefined || !source.transcriptComplete))) invalid()
  if ((outcome === 'verified_empty' || outcome === 'provider_failed' || outcome === 'unrecoverable') && sources.length !== 0) invalid()
  const execution = await parseWorkPrivateExecutionReference(v.execution, expected.execution)
  taskReference(expected.task)
  const result: WorkGranolaContributionReadResult = { execution, operationId, outcome, coverage, counters, sources }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) invalid()
  return result
}
