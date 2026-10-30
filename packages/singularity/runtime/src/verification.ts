import {
  canonicalize,
  executionRecordPayloadSchema,
  parseProtocolValue,
  seal,
  sealEvidence,
  validateEvidence,
  validatePublicReceipt,
} from '@singularity/protocol'
import type {
  Evidence,
  ExecutionRecord,
  JsonValue,
  PublicReceipt,
  PublicReceiptValidation,
  Ref,
  SessionCut,
  SubmissionManifest,
  TaskContract,
  UsageRecord,
  VerifyRequest,
} from '@singularity/protocol'

import type { CasDigestDomain } from './store.ts'
import type { CasObjectReader, CasObjectWriter } from './workspace.ts'

/** Stable closure reasons used by the fixed retry policy. */
export const VERIFIER_ERROR_REASON = 'verifier-error'
export const VERIFIER_TIMEOUT_REASON = 'verifier-timeout'
export const VERIFIER_SIGNAL_REASON = 'verifier-signal'
export const VERIFIER_INVALID_REASON = 'verifier-invalid'
export const VERIFICATION_INVALID_REASON = 'verification-invalid'
export const NO_SUBMISSION_REASON = 'no-submission'
export const AGENT_ERROR_REASON = 'agent-error'
export const WAKE_REFUSED_REASON = 'wake-refused'

/** Invalid-verification subclass; invalid receipts never become Evidence. */
export type InvalidVerificationCode =
  | 'verifier-error'
  | 'verifier-timeout'
  | 'verifier-signal'
  | 'verifier-invalid'
  | 'verification-invalid'

/** Runtime-side verifier request: data fields plus read-only CAS access. */
export interface VerifierRequest extends VerifyRequest {
  /**
   * Read one frozen CAS object and verify its digest under `domain`. The
   * verifier never receives the activity workspace or a writable handle.
   */
  readonly readObject: (
    ref: Ref,
    domain: CasDigestDomain,
  ) => Promise<{ readonly bytes: Uint8Array }>
}

/** Independent domain verifier from docs/framework.md §19. */
export interface RunVerifier {
  /** This host uses the frozen acceptance object itself as provider identity. */
  readonly provider: Ref
  verify(request: VerifierRequest): Promise<PublicReceipt>
}

export interface RunVerificationInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly manifest: SubmissionManifest
  readonly inputs: readonly Ref[]
  readonly outputs: readonly Ref[]
  readonly verifier: RunVerifier
  readonly reader: CasObjectReader
  readonly writer: CasObjectWriter
}

/** Host classification plus the sealed receipt ref written before closure. */
export type RunVerification =
  | {
      readonly verdict: 'verified' | 'failed'
      readonly reason: string
      readonly receipt: PublicReceipt
      readonly receiptRef: Ref
    }
  | {
      readonly verdict: 'invalid'
      readonly reason: string
      readonly code: InvalidVerificationCode
    }

/**
 * Runs the independent verifier against frozen CAS refs and derives the
 * verdict only through the protocol host-classification table. A verifier-
 * reported total verdict is not part of the receipt and can never decide the
 * result.
 */
export async function verifyRunSubmission(
  input: RunVerificationInput,
  clock: () => number = Date.now,
): Promise<RunVerification> {
  if (input.verifier.provider.id !== input.contract.acceptance.id
    || input.verifier.provider.digest !== input.contract.acceptance.digest) {
    return {
      verdict: 'invalid',
      code: 'verification-invalid',
      reason: `${VERIFICATION_INVALID_REASON}: verifier provider does not match the frozen acceptance`,
    }
  }
  const operationId = `${input.runId}:verify`
  const requiredCriteria = input.contract.spec.criteria
    .filter(criterion => criterion.required)
    .map(criterion => criterion.id)

  let receipt: PublicReceipt
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const startedAt = clock()
    const remaining = input.contract.limits.deadlineAt - startedAt
    if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new DOMException('verifier deadline', 'TimeoutError')
    receipt = await Promise.race([input.verifier.verify({
      operationId,
      task: input.contract,
      inputs: input.inputs,
      outputs: input.outputs,
      readObject: (ref, domain) => input.reader.readObject(ref, domain),
    }), new Promise<PublicReceipt>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new DOMException('verifier deadline', 'TimeoutError')) },
        Math.min(2_147_483_647, remaining))
    })])
    const finishedAt = clock()
    if (!Number.isSafeInteger(finishedAt) || finishedAt < startedAt || finishedAt >= input.contract.limits.deadlineAt) {
      throw new DOMException('verifier deadline', 'TimeoutError')
    }
  } catch (error) {
    const code = error instanceof DOMException && error.name === 'TimeoutError' ? VERIFIER_TIMEOUT_REASON : VERIFIER_ERROR_REASON
    return {
      verdict: 'invalid',
      code,
      reason: `${code}: ${errorMessage(error)}`,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  const validation = validatePublicReceipt(receipt, {
    provider: input.contract.acceptance,
    operationId,
    contractDigest: input.contract.digest,
    inputDigests: input.inputs.map(ref => ref.digest),
    outputDigests: input.outputs.map(ref => ref.digest),
    requiredCriteria,
  })
  if (validation.verdict === 'invalid') {
    return invalidFromValidation(validation, receipt)
  }

  const receiptRef = await input.writer.putObject(
    `${input.runId}:receipt`,
    new TextEncoder().encode(canonicalize(receipt as unknown as JsonValue)),
    'object',
  )
  if (receiptRef.digest !== validation.receipt.digest) {
    return {
      verdict: 'invalid',
      code: 'verification-invalid',
      reason: `${VERIFICATION_INVALID_REASON}: receipt CAS digest does not match its seal`,
    }
  }
  return {
    verdict: validation.verdict,
    reason: validation.reason,
    receipt: validation.receipt,
    receiptRef,
  }
}

/** Alias used by app-level conformance checks. */
export const validateRunVerification = verifyRunSubmission

function invalidFromValidation(
  validation: Extract<PublicReceiptValidation, { readonly verdict: 'invalid' }>,
  receipt: unknown,
): RunVerification {
  if (isRecord(receipt) && receipt.timedOut === true) {
    return { verdict: 'invalid', code: 'verifier-timeout', reason: `${VERIFIER_TIMEOUT_REASON}: ${validation.reason}` }
  }
  if (isRecord(receipt) && isRecord(receipt.exit) && typeof receipt.exit.signal === 'string') {
    return { verdict: 'invalid', code: 'verifier-signal', reason: `${VERIFIER_SIGNAL_REASON}: ${validation.reason}` }
  }
  if (isRecord(receipt) && Array.isArray(receipt.criteria)) {
    const invalidCriterion = receipt.criteria.some(criterion =>
      isRecord(criterion) && criterion.verdict === 'invalid'
    )
    if (invalidCriterion) {
      return { verdict: 'invalid', code: 'verifier-invalid', reason: `${VERIFIER_INVALID_REASON}: ${validation.reason}` }
    }
  }
  return {
    verdict: 'invalid',
    code: 'verification-invalid',
    reason: `${VERIFICATION_INVALID_REASON}: ${validation.reason}`,
  }
}

export interface BuildEvidenceOptions {
  readonly contract: TaskContract
  readonly runId: string
  readonly composition: Ref
  readonly outputs: readonly Ref[]
  readonly receipt: PublicReceipt
  readonly receiptRef: Ref
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly environmentMode: string
}

/** Seals Evidence in the evidence domain and checks its frozen identities. */
export function buildEvidence(options: BuildEvidenceOptions): Evidence {
  const evidence = sealEvidence({
    v: 1,
    task: { id: options.contract.taskId, digest: options.contract.digest },
    runId: options.runId,
    contractDigest: options.contract.digest,
    method: options.contract.method,
    inputs: options.contract.spec.inputs.map(input => input.object),
    outputs: options.outputs,
    composition: options.composition,
    verification: {
      provider: options.receipt.provider,
      operationId: options.receipt.operationId,
      publicReceipt: options.receiptRef,
    },
    usage: options.usage,
    sessionCut: options.sessionCut,
    environment: { seed: options.contract.environment.seed.digest, mode: options.environmentMode },
  })
  const validation = validateEvidence(evidence, {
    contract: options.contract,
    runId: options.runId,
    composition: options.composition,
  })
  if (!validation.valid) {
    throw new Error(`Evidence failed validation: ${validation.reason}`)
  }
  return evidence
}

export interface BuildExecutionRecordOptions {
  readonly contract: TaskContract
  readonly runId: string
  readonly composition: Ref
  readonly outputs?: readonly Ref[]
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly reason: string
  readonly drainPending?: boolean
}

/** Seals a non-Evidence closure record in the object digest domain. */
export function buildExecutionRecord(
  options: BuildExecutionRecordOptions,
): ExecutionRecord {
  const payload = parseProtocolValue(executionRecordPayloadSchema, {
    v: 1,
    taskId: options.contract.taskId,
    runId: options.runId,
    contractDigest: options.contract.digest,
    method: options.contract.method,
    composition: options.composition,
    inputs: options.contract.spec.inputs.map(input => input.object),
    ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
    usage: options.usage,
    sessionCut: options.sessionCut,
    reason: options.reason,
    ...(options.drainPending === undefined ? {} : { drainPending: options.drainPending }),
  })
  return seal('object', payload)
}

/** Evidence outputs must exactly mirror the frozen manifest order. */
export function manifestOutputRefs(manifest: SubmissionManifest): readonly Ref[] {
  const refs: Ref[] = []
  for (const output of manifest.outputs) {
    if (output.object !== undefined) refs.push(output.object)
  }
  for (const draft of manifest.learningDrafts) refs.push(draft.object)
  return refs
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown verifier error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
