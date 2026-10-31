import { resolve } from 'node:path'

import type { SessionId } from '@deepseek-ai/dsh-session'

import {
  canonicalize,
  compositionPayloadSchema,
  compositionSchema,
  evidenceSchema,
  executionRecordSchema,
  parseJsonText,
  parseProtocolValue,
  publicReceiptSchema,
  submissionManifestSchema,
  validateSubmissionManifest,
  verifyDigest,
  verifyTaskContract,
} from '@singularity/protocol'
import type {
  Composition,
  CompositionPayload,
  Evidence,
  ExecutionRecord,
  Fact,
  FactActor,
  JsonValue,
  PublicReceipt,
  Ref,
  RetryDecision,
  SubmissionManifest,
  TaskContract,
  TaskRunState,
  UsageRecord,
} from '@singularity/protocol'

import { snapshotSession } from './agent.ts'
import type { OpenedRunMode, SessionSnapshot } from './agent.ts'
import { initialContextEpoch } from './epoch.ts'
import { preflightNodeView } from './node-view.ts'
import { SingleRunError } from './errors.ts'
import {
  MethodResourceError,
  assertCompositionResources,
  loadMethodResources,
} from './resources.ts'
import {
  assertToolsAvailable,
  buildPreparedRun,
  buildRuntimeContext,
  drivePreparedRun,
  lastAttemptFromState,
  resolveBaseToolNames,
  validateComposition,
  validateRequest,
} from './run.ts'
import type {
  ContinueOpenedRunResult,
  ExecuteSingleRunRequest,
  ExecuteSingleRunResult,
} from './run.ts'
import {
  buildExecutionResult,
  commitTaskClosed,
  finalizeSettlement,
  retryDecisionForRun,
  settleInvalidRecord,
  settleSubmitted,
} from './run-settlement.ts'
import type { Settlement } from './run-settlement.ts'
import type { CommandService } from './service.ts'
import type { CasDigestDomain } from './store.ts'
import type { CasObjectReader, FrozenSubmission } from './workspace.ts'

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const zeroUsage: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  steps: 0,
  unknownRequests: 0,
}

/** Frozen journal view for one known Run. */
export interface RunJournalView {
  readonly state: TaskRunState
  readonly taskId: string
  readonly contract: TaskContract
  readonly composition: Composition
  readonly compositionRef: Ref
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly runSubmitted?: Extract<Fact, { readonly type: 'run/submitted' }>
  readonly runClosed?: Extract<Fact, { readonly type: 'run/closed' }>
  readonly taskClosed?: Extract<Fact, { readonly type: 'task/closed' }>
  readonly runIds: readonly string[]
}

/** Continues one already-open Run through the shared Run execution path. */
export async function continueOpenedRun(
  request: ExecuteSingleRunRequest,
  service: CommandService,
  mode: OpenedRunMode,
): Promise<ContinueOpenedRunResult> {
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  let prepared: Awaited<ReturnType<typeof loadPreparedRun>>
  try {
    prepared = await loadPreparedRun(request, actor, clock, service)
  } catch (error) {
    if (!(error instanceof MethodResourceError)) throw error
    const result = await closeOpenedRunInvalid(
      request,
      service,
      `resource-invalid: ${error.resource}: ${error.message}`,
    )
    return { ...result, sessionAction: 'none' }
  }
  return drivePreparedRun(prepared, request, service, mode)
}

async function loadPreparedRun(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  service: CommandService,
): Promise<ReturnType<typeof buildPreparedRun>> {
  const view = await readRunJournalView(service, request.runId, request.transientInvalidReasons ?? [])
  if (view.taskClosed !== undefined) {
    throw new SingleRunError('TASK_ALREADY_CLOSED', `Task ${JSON.stringify(view.taskId)} is already closed`)
  }
  if (view.runClosed !== undefined) {
    throw new SingleRunError('RUN_ALREADY_CLOSED', `Run ${JSON.stringify(request.runId)} is already closed`)
  }
  if (view.runSubmitted !== undefined) {
    throw new SingleRunError('RUN_NOT_SUBMITTED', 'Run is already submitted; recover its closure instead')
  }
  const contract = request.admission.contract
  if (!verifyTaskContract(contract)) {
    throw new SingleRunError('CONTRACT_INVALID', 'admission.contract is not a sealed root TaskContract')
  }
  if (contract.taskId !== view.taskId || contract.digest !== view.contract.digest) {
    throw new SingleRunError(
      'TASK_CONTRACT_MISMATCH',
      'admission.contract does not match the Task contract recorded in the journal',
    )
  }
  if (request.admission.attempt !== view.runOpened.data.attempt) {
    throw new SingleRunError('INVALID_ARGUMENT', 'admission.attempt does not match run/opened')
  }
  if (request.sessionId !== view.runOpened.data.sessionId) {
    throw new SingleRunError('SESSION_MISMATCH', 'sessionId does not match run/opened')
  }
  if (!compareCompositionPayload(view.composition, request.composition)) {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      'actual composition does not equal the frozen run/opened Composition',
    )
  }
  const compositionPayload = compositionPayloadOf(view.composition)
  validateComposition(compositionPayload, contract)
  const methodResources = await loadMethodResources(service, contract)
  await assertCompositionResources(service, methodResources, compositionPayload)
  const workspace = resolve(request.workspace)
  const baseToolNames = await resolveBaseToolNames(contract, service)
  assertToolsAvailable(baseToolNames, request.ctx)
  const lastAttempt = lastAttemptFromState(view.state, view.taskId, request.runId)
  preflightNodeView({
    contract,
    runId: request.runId,
    workspace,
    baseToolNames,
    template: methodResources.template,
    skills: methodResources.skills,
    mcpServers: methodResources.mcpServers,
    budget: { tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 },
    lastAttempt,
    asOf: clock(),
    contextEpoch: initialContextEpoch(request.sessionId),
  })
  return buildPreparedRun({
    actor,
    clock,
    contract,
    compositionRef: view.compositionRef,
    runOpened: view.runOpened,
    workspace,
    methodResources,
    baseToolNames,
    lastAttempt,
    request,
  })
}

/** Recovers a submitted Run from its frozen manifest and fixed operationId. */
export async function completeSubmittedRun(
  request: ExecuteSingleRunRequest,
  service: CommandService,
): Promise<ExecuteSingleRunResult> {
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  const view = await readRunJournalView(service, request.runId, request.transientInvalidReasons ?? [])
  if (view.taskClosed !== undefined) {
    throw new SingleRunError('TASK_ALREADY_CLOSED', `Task ${JSON.stringify(view.taskId)} is already closed`)
  }
  if (view.runClosed !== undefined) {
    throw new SingleRunError('RUN_ALREADY_CLOSED', `Run ${JSON.stringify(request.runId)} is already closed`)
  }
  const submitted = view.runSubmitted
  if (submitted === undefined) {
    throw new SingleRunError('RUN_NOT_SUBMITTED', `Run ${JSON.stringify(request.runId)} has no run/submitted fact`)
  }
  if (request.admission.contract.digest !== view.contract.digest) {
    throw new SingleRunError('TASK_CONTRACT_MISMATCH', 'admission.contract does not match the journal')
  }
  if (!compareCompositionPayload(view.composition, request.composition)) {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      'actual composition does not equal the frozen run/opened Composition',
    )
  }
  const compositionPayload = compositionPayloadOf(view.composition)

  const runtime = buildRuntimeContext(
    request,
    actor,
    clock,
    view.contract,
    view.compositionRef,
    view.runOpened.at,
    request.workspace,
    [],
    lastAttemptFromState(view.state, view.taskId, request.runId),
  )
  const snapshot = recoverSessionSnapshot(request, submitted.data.transcriptOffset)
  let settlement: Settlement | undefined
  try {
    validateComposition(compositionPayload, view.contract)
    const methodResources = await loadMethodResources(service, view.contract)
    await assertCompositionResources(service, methodResources, compositionPayload)
  } catch (error) {
    if (!(error instanceof MethodResourceError)) throw error
    settlement = await settleInvalidRecord(
      runtime,
      request,
      service,
      snapshot,
      `resource-invalid: ${error.resource}: ${error.message}`,
    )
  }
  if (settlement === undefined) {
    try {
      const frozen = await loadFrozenSubmission(service, view.contract, submitted)
      settlement = await settleSubmitted(runtime, request, service, snapshot, {
        planningSketchRef: submitted.data.planningSketchRef,
        submission: frozen,
        contextEpoch: initialContextEpoch(request.sessionId),
      })
    } catch (error) {
      settlement = await settleInvalidRecord(
        runtime,
        request,
        service,
        snapshot,
        `submission-invalid: ${errorMessage(error)}`,
      )
    }
  }
  const { taskFact, retry } = await finalizeSettlement(runtime, request, service, settlement)
  return buildExecutionResult(
    request,
    runtime,
    settlement,
    taskFact,
    retry,
    snapshot,
    service.facts(),
  )
}

/** Closes an open Run with an invalid ExecutionRecord without Agent or verifier work. */
export async function closeOpenedRunInvalid(
  request: ExecuteSingleRunRequest,
  service: CommandService,
  reason: string,
): Promise<ExecuteSingleRunResult> {
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  const view = await readRunJournalView(service, request.runId, request.transientInvalidReasons ?? [])
  if (view.taskClosed !== undefined) {
    throw new SingleRunError('TASK_ALREADY_CLOSED', `Task ${JSON.stringify(view.taskId)} is already closed`)
  }
  if (view.runClosed !== undefined) {
    throw new SingleRunError('RUN_ALREADY_CLOSED', `Run ${JSON.stringify(request.runId)} is already closed`)
  }
  if (request.admission.contract.digest !== view.contract.digest) {
    throw new SingleRunError('TASK_CONTRACT_MISMATCH', 'admission.contract does not match the journal')
  }
  const runtime = buildRuntimeContext(
    request,
    actor,
    clock,
    view.contract,
    view.compositionRef,
    view.runOpened.at,
    request.workspace,
    [],
    lastAttemptFromState(view.state, view.taskId, request.runId),
  )
  const snapshot = recoverSessionSnapshot(request)
  const settlement = await settleInvalidRecord(runtime, request, service, snapshot, reason)
  const taskFact = await commitTaskClosed(runtime, service, settlement, request.runId, 'invalid')
  const retry: RetryDecision = {
    allowed: false,
    reason: 'composition mismatch and invalid closure are not retryable',
  }
  return buildExecutionResult(
    request,
    runtime,
    settlement,
    taskFact,
    retry,
    snapshot,
    service.facts(),
  )
}

/** Reconciles a closed Run without re-verifying or re-driving the model. */
export async function reconcileClosedRun(
  request: ExecuteSingleRunRequest,
  service: CommandService,
): Promise<ExecuteSingleRunResult> {
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  const view = await readRunJournalView(service, request.runId, request.transientInvalidReasons ?? [])
  if (view.runClosed === undefined) {
    throw new SingleRunError('RUN_NOT_CLOSED', `Run ${JSON.stringify(request.runId)} is not closed`)
  }
  if (request.admission.contract.digest !== view.contract.digest) {
    throw new SingleRunError('TASK_CONTRACT_MISMATCH', 'admission.contract does not match the journal')
  }
  const runtime = buildRuntimeContext(
    request,
    actor,
    clock,
    view.contract,
    view.compositionRef,
    view.runOpened.at,
    request.workspace,
    [],
    lastAttemptFromState(view.state, view.taskId, request.runId),
  )
  const retry = retryDecisionForRun(
    view.state,
    view.contract,
    view.runClosed,
    runtime.transientInvalidReasons,
    clock(),
  )
  let taskFact: Fact | undefined = view.taskClosed
  const classification = view.runClosed.data.classification
  if (taskFact === undefined) {
    if (classification === 'verified') {
      taskFact = await commitTaskClosed(
        runtime,
        service,
        settlementFromClosedRun(view.runClosed),
        request.runId,
        'verified',
      )
    } else if (!retry.allowed && (classification === 'failed' || classification === 'invalid')) {
      taskFact = await commitTaskClosed(
        runtime,
        service,
        settlementFromClosedRun(view.runClosed),
        request.runId,
        classification,
      )
    }
  }
  const details = await loadClosureDetails(service, view)
  const settlement: Settlement = {
    classification,
    reason: view.runClosed.data.reason,
    runFact: view.runClosed,
    ...details,
  }
  return buildExecutionResult(
    request,
    runtime,
    settlement,
    taskFact,
    retry,
    details.snapshot,
    service.facts(),
  )
}

function settlementFromClosedRun(runClosed: Extract<Fact, { readonly type: 'run/closed' }>): Settlement {
  return {
    classification: runClosed.data.classification,
    reason: runClosed.data.reason,
    runFact: runClosed,
    ...('evidenceRef' in runClosed.data ? { evidenceRef: runClosed.data.evidenceRef } : {}),
  }
}

async function loadClosureDetails(
  service: CommandService,
  view: RunJournalView,
): Promise<{
  readonly manifest?: SubmissionManifest
  readonly manifestRef?: Ref
  readonly receipt?: PublicReceipt
  readonly receiptRef?: Ref
  readonly evidence?: Evidence
  readonly evidenceRef?: Ref
  readonly executionRecord?: ExecutionRecord
  readonly executionRecordRef?: Ref
  readonly snapshot: SessionSnapshot
}> {
  const runClosed = view.runClosed
  if (runClosed === undefined) throw new SingleRunError('RUN_NOT_CLOSED', 'Run closure is missing')
  let manifest: SubmissionManifest | undefined
  let manifestRef: Ref | undefined
  if (view.runSubmitted !== undefined) {
    manifestRef = view.runSubmitted.data.outputs
    manifest = parseProtocolValue(
      submissionManifestSchema,
      await readJsonValue(service, manifestRef, 'object'),
    )
  }
  if ('evidenceRef' in runClosed.data) {
    const evidenceRef = runClosed.data.evidenceRef
    const evidence = parseProtocolValue(
      evidenceSchema,
      await readJsonValue(service, evidenceRef, 'evidence'),
    )
    const receiptRef = evidence.verification.publicReceipt
    const receipt = parseProtocolValue(
      publicReceiptSchema,
      await readJsonValue(service, receiptRef, 'object'),
    )
    return {
      ...(manifest === undefined ? {} : { manifest }),
      ...(manifestRef === undefined ? {} : { manifestRef }),
      receipt,
      receiptRef,
      evidence,
      evidenceRef,
      snapshot: { usage: evidence.usage, sessionCut: evidence.sessionCut },
    }
  }
  const executionRecordRef = runClosed.data.executionRecordRef
  const executionRecord = parseProtocolValue(
    executionRecordSchema,
    await readJsonValue(service, executionRecordRef, 'object'),
  )
  return {
    ...(manifest === undefined ? {} : { manifest }),
    ...(manifestRef === undefined ? {} : { manifestRef }),
    executionRecord,
    executionRecordRef,
    snapshot: { usage: executionRecord.usage, sessionCut: executionRecord.sessionCut },
  }
}

/** Reads the frozen contract/composition/Run facts for one runId. */
export async function readRunJournalView(
  reader: CommandService,
  runId: string,
  transientInvalidReasons: readonly string[],
): Promise<RunJournalView> {
  const facts = reader.facts()
  const state = await reader.taskRunState(transientInvalidReasons)
  const runOpened = facts.find((fact): fact is Extract<Fact, { type: 'run/opened' }> =>
    fact.type === 'run/opened' && fact.data.runId === runId)
  if (runOpened === undefined) {
    throw new SingleRunError('RUN_NOT_FOUND', `Run ${JSON.stringify(runId)} has no run/opened fact`)
  }
  const taskId = runOpened.data.taskId
  if (!facts.some(fact => fact.type === 'task/admitted' && fact.data.taskId === taskId)) {
    throw new SingleRunError('RUN_NOT_FOUND', `Task ${JSON.stringify(taskId)} has no task/admitted fact`)
  }
  const task = state.tasks.get(taskId)
  if (task === undefined) throw new SingleRunError('RUN_NOT_FOUND', 'Run Task is missing from the projection')
  const contract = task.contract
  if (contract.origin.kind !== 'root') {
    throw new SingleRunError('CONTRACT_INVALID', 'single-Run recovery requires a root TaskContract')
  }
  const compositionRef = runOpened.data.composition
  const composition = await readFrozenComposition(reader, compositionRef)
  const runSubmitted = facts.find((fact): fact is Extract<Fact, { type: 'run/submitted' }> =>
    fact.type === 'run/submitted' && fact.data.runId === runId)
  const runClosed = facts.find((fact): fact is Extract<Fact, { type: 'run/closed' }> =>
    fact.type === 'run/closed' && fact.data.runId === runId)
  const taskClosed = facts.find((fact): fact is Extract<Fact, { type: 'task/closed' }> =>
    fact.type === 'task/closed' && fact.data.taskId === taskId)
  return {
    state,
    taskId,
    contract,
    composition,
    compositionRef,
    runOpened,
    ...(runSubmitted === undefined ? {} : { runSubmitted }),
    ...(runClosed === undefined ? {} : { runClosed }),
    ...(taskClosed === undefined ? {} : { taskClosed }),
    runIds: task.runIds,
  }
}

/** Reads and verifies the Composition frozen by `run/opened`. */
async function readFrozenComposition(
  reader: CasObjectReader,
  ref: Ref,
): Promise<Composition> {
  let composition: Composition
  try {
    composition = parseProtocolValue(compositionSchema, await readJsonValue(reader, ref, 'composition'))
  } catch (error) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition is not strict JSON', { cause: error })
  }
  if (!verifyDigest('composition', composition)) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition digest does not verify')
  }
  if (composition.digest !== ref.digest) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition digest does not match its ref')
  }
  return composition
}

/** Strips the seal from a frozen Composition for comparison. */
export function compositionPayloadOf(composition: Composition): CompositionPayload {
  const { digest, ...payload } = composition
  if (typeof digest !== 'string') {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition has no digest')
  }
  return parseProtocolValue(compositionPayloadSchema, payload)
}

/** Compares the complete actual and frozen Composition payloads. */
export function compareCompositionPayload(
  frozen: Composition,
  actual: CompositionPayload,
): boolean {
  let parsed: CompositionPayload
  try {
    parsed = parseProtocolValue(compositionPayloadSchema, actual)
  } catch {
    return false
  }
  try {
    return canonicalize(parsed as unknown as JsonValue)
      === canonicalize(compositionPayloadOf(frozen) as unknown as JsonValue)
  } catch {
    return false
  }
}

async function readJsonValue(
  reader: CasObjectReader,
  ref: Ref,
  domain: CasDigestDomain,
): Promise<JsonValue> {
  const { bytes } = await reader.readObject(ref, domain)
  let text: string
  try {
    text = strictUtf8.decode(bytes)
  } catch (error) {
    throw new SingleRunError('INVALID_ARGUMENT', 'frozen CAS object is not UTF-8', { cause: error })
  }
  return parseJsonText(text)
}

async function loadFrozenSubmission(
  service: CommandService,
  contract: TaskContract,
  submitted: Extract<Fact, { readonly type: 'run/submitted' }>,
): Promise<FrozenSubmission> {
  const manifestRef = submitted.data.outputs
  let manifest: SubmissionManifest
  try {
    manifest = parseProtocolValue(
      submissionManifestSchema,
      await readJsonValue(service, manifestRef, 'object'),
    )
  } catch (error) {
    throw new SingleRunError('INVALID_ARGUMENT', 'frozen SubmissionManifest is unreadable', { cause: error })
  }
  const validation = validateSubmissionManifest(manifest, {
    contract,
    runId: submitted.data.runId,
  })
  if (!validation.valid) {
    throw new SingleRunError(
      'INVALID_ARGUMENT',
      `frozen SubmissionManifest is invalid: ${validation.reason}`,
    )
  }
  const outputRefs: Ref[] = []
  for (const output of manifest.outputs) {
    if (output.object !== undefined) outputRefs.push(output.object)
  }
  for (const draft of manifest.learningDrafts) outputRefs.push(draft.object)
  return {
    manifest,
    manifestRef,
    inputRefs: contract.spec.inputs.map(input => input.object),
    outputRefs,
  }
}

function recoverSessionSnapshot(
  request: ExecuteSingleRunRequest,
  transcriptOffset?: { readonly sessionId: string; readonly seq: number },
): SessionSnapshot {
  const live = request.ctx.sessions.get(request.sessionId as SessionId)
  if (live !== undefined) return snapshotSession(live)
  return {
    usage: { ...zeroUsage, unknownRequests: 1 },
    sessionCut: {
      sessionId: transcriptOffset?.sessionId ?? request.sessionId,
      from: 0,
      to: transcriptOffset?.seq ?? 0,
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
