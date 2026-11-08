import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import type { ShellExecutor,ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {
Evidence,
ExecutionRecord,
JsonValue,
PublicReceipt,
PublicCriterionResult,
PublicReceiptValidation,
Ref,
SessionCut,
TaskContract,
TaskCriterion,
UsageRecord,
VerifyRequest,
} from '@singularity/protocol'
import {
canonicalize,
errorMessage,
executionRecordPayloadSchema,
parseProtocolValue,
publicMetricSchema,
seal,
sealEvidence,
sealPublicReceipt,
validateEvidence,
validatePublicReceipt,
} from '@singularity/protocol'
import { SingleRunError } from './errors.ts'
import { readTreeBundle } from './resource-bundle.ts'

import type { CasDigestDomain } from './store.ts'
import { prepareWorkspace } from './workspace.ts'
import type { CasObjectReader,CasObjectWriter } from './workspace.ts'

/** Stable closure reasons used by the fixed retry policy. */
export const VERIFIER_TIMEOUT_REASON = 'verifier-timeout'
export const VERIFIER_SIGNAL_REASON = 'verifier-signal'
export const VERIFIER_INVALID_REASON = 'verifier-invalid'
export const VERIFICATION_INVALID_REASON = 'verification-invalid'
export const NO_SUBMISSION_REASON = 'no-submission'
export const AGENT_ERROR_REASON = 'agent-error'

/** Invalid-verification subclass; invalid receipts never become Evidence. */
export type InvalidVerificationCode =
  | 'verifier-error'
  | 'verifier-timeout'
  | 'verifier-signal'
  | 'verifier-invalid'
  | 'verification-invalid'

/** Runtime-side verifier request: data fields plus read-only CAS access. */
export interface VerifierRequest extends VerifyRequest {
  /** The host-owned verifier adapter forwards cancellation and settles after its work stops. */
  readonly signal: AbortSignal
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
export type RunVerifier = {
  /** This host uses the frozen acceptance object itself as provider identity. */
  readonly provider: Ref
  readonly checksOnly?: false
  verify(request: VerifierRequest): Promise<PublicReceipt>
} | {
  readonly provider: Ref
  readonly checksOnly: true
}

/** Worker, trace and comparator views never expose the opaque private receipt. */
export function publicVerificationOf(verification: Evidence['verification']): Omit<Evidence['verification'], 'privateReceipt'> {
  return {
    provider: verification.provider,
    operationId: verification.operationId,
    publicReceipt: verification.publicReceipt,
  }
}

export interface RunVerificationInput {
  readonly shell: ShellExecutor
  readonly contract: TaskContract
  readonly runId: string
  readonly inputs: readonly Ref[]
  readonly outputs: readonly Ref[]
  readonly verifier: RunVerifier
  readonly reader: CasObjectReader
  readonly writer: CasObjectWriter
  readonly signal?: AbortSignal
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
    throw new SingleRunError('COMPOSITION_MISMATCH', 'verifier provider does not match the frozen acceptance')
  }
  const operationId = `${input.runId}:verify`
  const requiredCriteria = input.contract.spec.criteria
    .filter(criterion => criterion.required)
    .map(criterion => criterion.id)

  let receipt: PublicReceipt
  const remaining = input.contract.limits.deadlineAt - clock()
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, remaining)))
  const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline])
  const timeout = new DOMException('verifier deadline', 'TimeoutError')
  try {
    signal.throwIfAborted()
    if (remaining <= 0) throw timeout
    if (input.verifier.checksOnly === true
      && input.contract.spec.criteria.some(criterion => criterion.required && criterion.check === undefined)) {
      throw new SingleRunError('COMPOSITION_MISMATCH', 'check-only acceptance requires one frozen check per required criterion')
    }
    const checks = await rerunChecks(input, signal)
    if (input.verifier.checksOnly === true) {
      receipt = sealPublicReceipt({ v: 1, provider: input.contract.acceptance, operationId,
        contractDigest: input.contract.digest, inputDigests: input.inputs.map(ref => ref.digest), outputDigests: input.outputs.map(ref => ref.digest),
        criteria: input.contract.spec.criteria.flatMap(criterion => {
          const check = checks.get(criterion.id)
          return check === undefined ? [] : [checkCriterionResult(criterion, check)]
        }),
        exit: { code: 0, signal: null }, timedOut: false })
    } else {
      receipt = await input.verifier.verify({
        operationId,
        task: input.contract,
        inputs: input.inputs,
        outputs: input.outputs,
        signal,
        readObject: (ref, domain) => input.reader.readObject(ref, domain),
      })
    }
    signal.throwIfAborted()
    if (clock() >= input.contract.limits.deadlineAt) throw timeout
    if (checks.size > 0 && input.verifier.checksOnly !== true && validatePublicReceipt(receipt, {
      provider: input.contract.acceptance, operationId, contractDigest: input.contract.digest,
      inputDigests: input.inputs.map(ref => ref.digest), outputDigests: input.outputs.map(ref => ref.digest), requiredCriteria,
    }).verdict !== 'invalid') {
      const { digest, ...payload } = receipt
      void digest
      receipt = sealPublicReceipt({ ...payload, criteria: receipt.criteria.map(criterion => {
        const check = checks.get(criterion.id)
        const definition = input.contract.spec.criteria.find(value => value.id === criterion.id)
        if (check !== undefined && definition?.checkOutput === 'metric-json') {
          const measured = checkCriterionResult(definition, check)
          const reason = `${criterion.reason}\n${measured.reason}`
          return measured.verdict === 'pass' && criterion.verdict !== 'pass'
            ? { id: criterion.id, verdict: criterion.verdict, reason }
            : { ...measured, reason }
        }
        return check === undefined ? criterion : { ...criterion,
          verdict: check.exitCode === 0 && !check.timedOut && check.signal === null ? criterion.verdict : 'fail',
          reason: `${criterion.reason}\nFrozen check: ${JSON.stringify(check)}` }
      }) })
    }
  } catch (error) {
    const aborted = signal.aborted && (error === signal.reason
      || (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason))
    if (aborted && input.signal?.aborted === true) throw input.signal.reason
    if (error !== timeout && !(aborted && deadline.aborted)) throw error
    const code = VERIFIER_TIMEOUT_REASON
    return {
      verdict: 'invalid',
      code,
      reason: `${code}: ${errorMessage(error, 'unknown verifier error')}`,
    }
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

function checkCriterionResult(criterion: TaskCriterion, check: ShellRunResult): PublicCriterionResult {
  const result = { id: criterion.id,
    verdict: check.exitCode === 0 && !check.timedOut && check.signal === null ? 'pass' as const : 'fail' as const,
    reason: `Frozen check: ${JSON.stringify(check)}` }
  if (result.verdict !== 'pass' || criterion.checkOutput !== 'metric-json') return result
  if (check.stdout.truncated) return { ...result, verdict: 'invalid', reason: 'Frozen metric output was truncated' }
  let value: unknown
  try { value = JSON.parse(check.stdout.text) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return { ...result, verdict: 'invalid', reason: `Frozen check did not emit one metric JSON value: ${error.message}` }
  }
  const metric = publicMetricSchema.safeParse(value)
  return metric.success ? { ...result, metric: metric.data }
    : { ...result, verdict: 'invalid', reason: `Frozen check emitted an invalid metric: ${metric.error.message}` }
}

/** Reuse native shell lifecycle; only CAS inputs and outputs enter the fresh check directory. */
async function rerunChecks(input: RunVerificationInput, signal: AbortSignal) {
  const checks = input.contract.spec.criteria.flatMap(criterion => criterion.required && criterion.check !== undefined
    ? [{ id: criterion.id, command: criterion.check }] : [])
  const results = new Map<string, ShellRunResult>()
  if (checks.length === 0) return results
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-check-'))
  try {
    await prepareWorkspace(workspace, input.contract.spec.inputs.map(ref => ({ ...ref, access: 'copy-to-work' as const })), input.reader)
    for (const spec of input.contract.spec.outputs) {
      const ref = input.outputs.find(ref => ref.id.endsWith(`:output:${spec.id}`))
      if (ref === undefined) continue
      const files = spec.kind === 'tree' ? (await readTreeBundle(input.reader, ref, Number.MAX_SAFE_INTEGER)).contents
        : new Map([['', (await input.reader.readObject(ref, 'object')).bytes]])
      for (const [path, bytes] of files) {
        const target = join(workspace, spec.path, path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
      }
    }
    for (const criterion of checks) {
      const execution = await input.shell.execute(input.shell.resolve({ command: `set -e -o pipefail\n${criterion.command}`, workdir: workspace, signal, timeoutMs: input.contract.limits.deadlineAt - Date.now() }))
      results.set(criterion.id, await execution.result())
      signal.throwIfAborted()
    }
    return results
  } finally { await rm(workspace, { recursive: true, force: true }) }
}

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
  readonly inputs?: readonly Ref[]
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
    inputs: options.inputs ?? options.contract.spec.inputs.map(input => input.object),
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
  })
  return seal('object', payload)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
