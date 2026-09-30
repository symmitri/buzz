import type { WorkTaskReference } from '@axis/collaboration'
import { parseWorkPrivateExecutionCheckInput, type WorkPrivateExecutionReference } from './work-private-execution.js'

/** Immutable private candidate, never a disclosure or publication capability.
 * Only the exact current owner-authorized preview transport returns its bytes. */
export interface WorkContributionCandidateReference {
  candidateId: string
  contentDigest: string
  version: 1
  execution: WorkPrivateExecutionReference
  /** Original native task, including original requester/session/admission. */
  task: WorkTaskReference
  mediaType: 'text/markdown'
  byteLength: number
  createdAt: string
}

export const MAX_PRIVATE_CONTRIBUTION_BYTES = 65_536

/** Fixed internal preview response; tickets and runtime credentials stay out. */
export interface WorkContributionPreview {
  candidate: WorkContributionCandidateReference
  markdown: string
}

/** Strict metadata binding for owner preview/release consumers. Validation does
 * not establish current authority or prove any candidate bytes were retrieved. */
export async function parseWorkContributionCandidateReference(value: unknown, expected?: WorkContributionCandidateReference): Promise<WorkContributionCandidateReference> {
  const keys = ['candidateId', 'contentDigest', 'version', 'execution', 'task', 'mediaType', 'byteLength', 'createdAt']
  const invalid = (): never => { throw new Error('Invalid private contribution candidate') }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some(key => !Object.hasOwn(value, key))) invalid()
  const raw = value as WorkContributionCandidateReference
  // Copy scalar fields before hashing; nested execution/task are copied by the
  // inward canonical parser before its asynchronous digest operations.
  const { candidateId, contentDigest, version, mediaType, byteLength, createdAt } = raw
  if (version !== 1 || mediaType !== 'text/markdown' || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_PRIVATE_CONTRIBUTION_BYTES ||
    typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(contentDigest) ||
    typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString().slice(0, 19) !== createdAt.slice(0, 19)) invalid()
  const checked = await parseWorkPrivateExecutionCheckInput({ execution: raw.execution, task: raw.task }, expected === undefined ? undefined : { execution: expected.execution, task: expected.task })
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(checked.execution.id))
  const suffix = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  if (candidateId !== `candidate_${suffix}`) invalid()
  const result: WorkContributionCandidateReference = { candidateId, contentDigest, version, ...checked, mediaType, byteLength, createdAt }
  if (expected !== undefined) {
    const original = await parseWorkContributionCandidateReference(expected)
    for (const key of ['candidateId', 'contentDigest', 'version', 'mediaType', 'byteLength', 'createdAt'] as const) {
      if (result[key] !== original[key]) invalid()
    }
  }
  return result
}
