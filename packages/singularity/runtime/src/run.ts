import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

import {
  canonicalize,
  compositionPayloadSchema,
  compositionSchema,
  decideRetryPolicy,
  evidenceSchema,
  executionRecordSchema,
  parseJsonText,
  parseProtocolValue,
  publicReceiptSchema,
  refSchema,
  seal,
  submissionManifestSchema,
  validateSubmissionManifest,
  verifyDigest,
  verifyTaskContract,
} from '@singularity/protocol'
import type {
  BudgetReservation,
  CommandScope,
  Composition,
  CompositionPayload,
  Evidence,
  ExecutionRecord,
  Fact,
  FactActor,
  FactPayloadMap,
  FactType,
  JsonValue,
  NormalizedCommand,
  PublicReceipt,
  Ref,
  RetryDecision,
  RunClosedPayload,
  SessionCut,
  SubmissionManifest,
  TaskContract,
  TaskRunState,
  UsageRecord,
} from '@singularity/protocol'

import { initialContextEpoch } from './epoch.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { clampPercent, renderNodeView, renderWorkerCard } from './prompt.ts'
import type { NodeView } from './prompt.ts'
import { CommandService } from './service.ts'
import type { CasDigestDomain } from './store.ts'
import { RunToolController } from './tools.ts'
import type { RunToolSnapshot } from './tools.ts'
import {
  AGENT_ERROR_REASON,
  NO_SUBMISSION_REASON,
  WAKE_REFUSED_REASON,
  buildEvidence,
  buildExecutionRecord,
  verifyRunSubmission,
} from './verification.ts'
import type { RunVerifier } from './verification.ts'
import {
  WakeDeliveryRefusedError,
  deliverWakeOnceOrFail,
  startWakeText,
} from './wake.ts'
import type { WakeDeliveryOutcome } from './wake.ts'
import type { CasObjectReader } from './workspace.ts'
import { prepareWorkspace } from './workspace.ts'
import type { FrozenSubmission } from './workspace.ts'

const textEncoder = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const zeroUsage: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  steps: 0,
  unknownRequests: 0,
}

/** One sealed root contract plus host-resolved Run intent. */
export interface SingleRunAdmission {
  /** Frozen root contract, normally produced by protocol `admitRootTask`. */
  readonly contract: TaskContract
  /** 1-based attempt for this Task. */
  readonly attempt: number
  /** Frozen budget reservation checked by run/opened. */
  readonly budgetReservation: BudgetReservation
  /** Workspace lease key; defaults to the Run id. */
  readonly workspaceKey?: string
  /** Bytes for `contract.acceptance` when the host has not stored them yet. */
  readonly acceptanceBytes?: Uint8Array
  /** Bytes for `contract.environment.seed` when not already stored. */
  readonly workspaceSeedBytes?: Uint8Array
}

/** One CAS object the host wants published before admission. */
export interface SeedObject {
  readonly id: string
  readonly bytes: Uint8Array
  readonly domain?: CasDigestDomain
}

/** Shared single-Run execution request. */
export interface ExecuteSingleRunRequest {
  readonly ctx: Context
  readonly journalRoot: string
  readonly workspace: string
  readonly sessionId: string
  readonly runId: string
  readonly admission: SingleRunAdmission
  readonly composition: CompositionPayload
  readonly agentOptions: AgentOptions
  readonly maxOutputBytes: number
  readonly verifier: RunVerifier
  readonly transientInvalidReasons?: readonly string[]
  readonly actor?: FactActor
  readonly clock?: () => number
  readonly seedObjects?: readonly SeedObject[]
  readonly templateBrief?: string
  readonly environmentMode?: string
}

/** Stable request/flow rejection. */
export type SingleRunErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CONTRACT_INVALID'
  | 'COMPOSITION_MISMATCH'
  | 'UNSUPPORTED_RESOURCES'
  | 'TOOL_UNAVAILABLE'
  | 'RUN_ALREADY_OPENED'
  | 'RUN_ALREADY_CLOSED'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_CLOSED'
  | 'RUN_NOT_SUBMITTED'
  | 'TASK_ALREADY_CLOSED'
  | 'TASK_CONTRACT_MISMATCH'
  | 'RETRY_NOT_ALLOWED'
  | 'SESSION_ALREADY_LIVE'
  | 'SESSION_MISMATCH'

export class SingleRunError extends Error {
  override readonly name = 'SingleRunError'
  readonly code: SingleRunErrorCode

  constructor(code: SingleRunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Settlement result; exactly one of Evidence or ExecutionRecord is present. */
export interface ExecuteSingleRunResult {
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly classification: RunClosedPayload['classification']
  readonly manifest?: SubmissionManifest
  readonly manifestRef?: Ref
  readonly receipt?: PublicReceipt
  readonly receiptRef?: Ref
  readonly evidence?: Evidence
  readonly evidenceRef?: Ref
  readonly executionRecord?: ExecutionRecord
  readonly executionRecordRef?: Ref
  readonly runFact: Fact
  readonly taskFact?: Fact
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly retry: { readonly allowed: boolean; readonly reason: string }
  readonly facts: readonly Fact[]
}

/** How an already-open Run acquires its DSH Agent. */
export type OpenedRunMode = 'create' | 'resume'

/** Shared continuation result; recovery adds composition/session flags. */
export interface ContinueOpenedRunResult extends ExecuteSingleRunResult {
  /** `created` uses the same session intent when persistence is absent. */
  readonly sessionAction: 'created' | 'resumed'
  /** Stable wake outcome; `already-admitted` never buys another request. */
  readonly wakeOutcome?: WakeDeliveryOutcome
}

/** @internal Frozen journal view for one known Run. */
export interface RunJournalView {
  readonly state: TaskRunState
  readonly taskId: string
  readonly contract: TaskContract
  readonly contractRef: Ref
  readonly composition: Composition
  readonly compositionRef: Ref
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly runSubmitted?: Extract<Fact, { readonly type: 'run/submitted' }>
  readonly runClosed?: Extract<Fact, { readonly type: 'run/closed' }>
  readonly taskClosed?: Extract<Fact, { readonly type: 'task/closed' }>
  readonly runIds: readonly string[]
}

interface SessionSnapshot {
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly failure?: string
}

interface Settlement {
  readonly classification: RunClosedPayload['classification']
  readonly reason: string
  readonly runFact: Fact
  readonly manifest?: SubmissionManifest
  readonly manifestRef?: Ref
  readonly receipt?: PublicReceipt
  readonly receiptRef?: Ref
  readonly evidence?: Evidence
  readonly evidenceRef?: Ref
  readonly executionRecord?: ExecutionRecord
  readonly executionRecordRef?: Ref
}

interface RuntimeContext {
  readonly actor: FactActor
  readonly clock: () => number
  readonly transientInvalidReasons: readonly string[]
  readonly workspace: string
  readonly baseToolNames: readonly string[]
  readonly contract: TaskContract
  readonly contractRef: Ref
  readonly compositionRef: Ref
  readonly startedAt: number
  readonly maxOutputBytes: number
  readonly templateBrief: string
  readonly environmentMode: string
  readonly verifier: RunVerifier
}

/** @internal One Run whose admission and `run/opened` fact are already durable. */
interface PreparedRun {
  readonly contract: TaskContract
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly workspace: string
  readonly runtime: RuntimeContext
}

/**
 * Executes exactly one Run: root admission, `run/opened`, DSH create/setup,
 * one stable wake, one `whenIdle`, then either independent verification of the
 * frozen submission or an ExecutionRecord settlement. The function owns one
 * CommandService writer for the duration and never starts a second model loop.
 */
export async function executeSingleRun(
  request: ExecuteSingleRunRequest,
): Promise<ExecuteSingleRunResult> {
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  const service = await CommandService.open({ root: request.journalRoot, actor, clock })
  try {
    return await executeWithService(request, actor, clock, service)
  } finally {
    await service.close()
  }
}

async function executeWithService(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  service: CommandService,
): Promise<ContinueOpenedRunResult> {
  const prepared = await openSingleRun(request, actor, clock, service)
  return drivePreparedRun(prepared, request, service, 'create')
}

async function openSingleRun(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  service: CommandService,
): Promise<PreparedRun> {
  const contract = request.admission.contract
  if (!verifyTaskContract(contract)) {
    throw new SingleRunError('CONTRACT_INVALID', 'admission.contract is not a sealed root TaskContract')
  }
  if (contract.origin.kind !== 'root') {
    throw new SingleRunError('CONTRACT_INVALID', 'single-Run execution requires a root TaskContract')
  }
  const compositionPayload = parseProtocolValue(compositionPayloadSchema, request.composition)
  validateComposition(compositionPayload, contract)

  const baseToolNames = await resolveBaseToolNames(contract, service)
  assertToolsAvailable(baseToolNames, request.ctx)

  for (const object of request.seedObjects ?? []) {
    await service.putObject(object.id, object.bytes, object.domain ?? 'object')
  }
  const contractRef = await putSealed(service, contract.taskId, contract, 'contract')
  await ensureObject(service, contract.acceptance, request.admission.acceptanceBytes)
  await ensureObject(service, contract.environment.seed, request.admission.workspaceSeedBytes)

  const facts = service.facts()
  const admitted = facts.find((fact): fact is Extract<Fact, { type: 'task/admitted' }> =>
    fact.type === 'task/admitted' && fact.data.taskId === contract.taskId)
  if (admitted === undefined) {
    await commitFact(
      service,
      actor,
      `task:${contract.taskId}:admitted`,
      'task.admitted',
      { taskId: contract.taskId },
      { taskId: contract.taskId, contract: contractRef },
      'task/admitted',
      { taskId: contract.taskId, contract: contractRef },
      request.transientInvalidReasons ?? [],
    )
  } else if (admitted.data.contract.digest !== contract.digest) {
    throw new SingleRunError(
      'TASK_CONTRACT_MISMATCH',
      `Task ${JSON.stringify(contract.taskId)} was admitted with a different contract digest`,
    )
  }
  const existing = (await service.taskRunState(request.transientInvalidReasons ?? [])).runs.get(request.runId)
  if (existing !== undefined) {
    throw new SingleRunError(
      existing.phase === 'closed' ? 'RUN_ALREADY_CLOSED' : 'RUN_ALREADY_OPENED',
      `Run ${JSON.stringify(request.runId)} already exists`,
    )
  }

  const composition = seal('composition', compositionPayload)
  const compositionRef = await putSealed(service, `${request.runId}:composition`, composition, 'composition')
  const runOpened = await commitFact(
    service,
    actor,
    `run:${request.runId}:opened`,
    'run.opened',
    { taskId: contract.taskId, runId: request.runId },
    {
      taskId: contract.taskId,
      runId: request.runId,
      attempt: request.admission.attempt,
      sessionId: request.sessionId,
      composition: compositionRef,
      workspaceSeed: contract.environment.seed,
      budgetReservation: request.admission.budgetReservation,
    } as unknown as JsonValue,
    'run/opened',
    {
      taskId: contract.taskId,
      runId: request.runId,
      attempt: request.admission.attempt,
      sessionId: request.sessionId,
      composition: compositionRef,
      workspaceKey: request.admission.workspaceKey ?? request.runId,
      workspaceSeed: contract.environment.seed,
      budgetReservation: request.admission.budgetReservation,
    },
    request.transientInvalidReasons ?? [],
  ) as Extract<Fact, { readonly type: 'run/opened' }>

  const workspace = await prepareWorkspace(request.workspace, contract.spec.inputs, service)

  return buildPreparedRun({
    actor,
    clock,
    contract,
    contractRef,
    compositionRef,
    runOpened,
    workspace,
    baseToolNames,
    request,
  })
}

/**
 * Continues one Run whose `run/opened` fact already exists. The caller owns the
 * single CommandService and must have loaded the contract from the journal;
 * `request.composition` is compared against the frozen Composition before any
 * Agent or workspace side effect.
 */
export async function continueOpenedRun(
  request: ExecuteSingleRunRequest,
  service: CommandService,
  mode: OpenedRunMode,
): Promise<ContinueOpenedRunResult> {
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  const prepared = await loadPreparedRun(request, actor, clock, service)
  return drivePreparedRun(prepared, request, service, mode)
}

async function loadPreparedRun(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  service: CommandService,
): Promise<PreparedRun> {
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
  validateComposition(compositionPayloadOf(view.composition), contract)
  const workspace = resolve(request.workspace)
  const baseToolNames = await resolveBaseToolNames(contract, service)
  assertToolsAvailable(baseToolNames, request.ctx)
  return buildPreparedRun({
    actor,
    clock,
    contract,
    contractRef: view.contractRef,
    compositionRef: view.compositionRef,
    runOpened: view.runOpened,
    workspace,
    baseToolNames,
    request,
  })
}

function buildPreparedRun(options: {
  readonly actor: FactActor
  readonly clock: () => number
  readonly contract: TaskContract
  readonly contractRef: Ref
  readonly compositionRef: Ref
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly workspace: string
  readonly baseToolNames: readonly string[]
  readonly request: ExecuteSingleRunRequest
}): PreparedRun {
  return {
    contract: options.contract,
    runOpened: options.runOpened,
    workspace: options.workspace,
    runtime: buildRuntimeContext(
      options.request,
      options.actor,
      options.clock,
      options.contract,
      options.contractRef,
      options.compositionRef,
      options.runOpened.at,
      options.workspace,
      options.baseToolNames,
    ),
  }
}

function buildRuntimeContext(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  contract: TaskContract,
  contractRef: Ref,
  compositionRef: Ref,
  startedAt: number,
  workspace: string,
  baseToolNames: readonly string[],
): RuntimeContext {
  return {
    actor,
    clock,
    transientInvalidReasons: request.transientInvalidReasons ?? [],
    workspace,
    baseToolNames,
    contract,
    contractRef,
    compositionRef,
    startedAt,
    maxOutputBytes: request.maxOutputBytes,
    templateBrief: request.templateBrief ?? contract.spec.goal.summary,
    environmentMode: request.environmentMode ?? 'workspace',
    verifier: request.verifier,
  }
}

async function drivePreparedRun(
  prepared: PreparedRun,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  mode: OpenedRunMode,
): Promise<ContinueOpenedRunResult> {
  const { contract, runtime } = prepared
  const { controller, budget, checkBudget, startBudget } = await createToolController(prepared, request, service)
  let handle: AgentHandle | undefined
  let snapshot = emptySnapshot(request.sessionId)
  let agentErrorCode: string | undefined
  let agentErrorDetail: string | undefined
  let sessionAction: 'created' | 'resumed' = 'created'
  let wakeOutcome: WakeDeliveryOutcome | undefined
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647,
    Math.max(0, prepared.runOpened.data.budgetReservation.deadlineAt - runtime.clock())))
  const cancel = () => handle?.agent.cancel({ kind: 'hook', reason: 'deadline' })
  deadline.addEventListener('abort', cancel, { once: true })

  try {
    const setup = buildAgentSetup(runtime, request, controller, budget, checkBudget)
    if (mode === 'create') {
      handle = await request.ctx.agents.create({
        sessionId: request.sessionId as SessionId,
        meta: { cwd: prepared.workspace },
        agentOptions: request.agentOptions,
        signal: deadline,
        setup,
      })
    } else {
      const acquired = await resumeOrCreateAgent(request, prepared.workspace, setup, service, deadline)
      handle = acquired.handle
      sessionAction = acquired.action
    }
    deadline.throwIfAborted()
    // The start wake text is derived from the frozen run/opened boundary, not
    // from the live clock: resuming must reproduce the same stable message body.
    wakeOutcome = await deliverWakeOnceOrFail(handle.agent, {
      wakeId: `${request.runId}:start`,
      text: startWakeText(contract.taskId, request.runId, startBudget),
    })
    await handle.agent.whenIdle()
  } catch (error) {
    agentErrorCode = error instanceof WakeDeliveryRefusedError
      ? WAKE_REFUSED_REASON
      : AGENT_ERROR_REASON
    agentErrorDetail = errorMessage(error)
  } finally {
    deadline.removeEventListener('abort', cancel)
    if (handle !== undefined) {
      try {
        await request.ctx.sessions.flush(handle.agent.session)
      } catch {
        // The durable log remains readable even when no flush listener exists.
      }
      snapshot = snapshotSession(handle.agent.session)
      try {
        await handle.dispose()
      } catch (error) {
        if (agentErrorCode === undefined) {
          agentErrorCode = AGENT_ERROR_REASON
          agentErrorDetail = `dispose failed: ${errorMessage(error)}`
        }
      }
      try {
        snapshot = snapshotSession(handle.agent.session)
      } catch {
        // Keep the pre-dispose snapshot if the session object is detached.
      }
    } else {
      const live = request.ctx.sessions.get(request.sessionId as SessionId)
      if (live !== undefined) snapshot = snapshotSession(live)
    }
  }

  const tools = controller.snapshot()
  const settlement = tools.submitted && tools.submission !== undefined
    ? await settleSubmitted(runtime, request, service, snapshot, tools)
    : await settleExecutionRecord(runtime, request, service, snapshot, tools, agentErrorCode, agentErrorDetail)

  const { taskFact, retry } = await finalizeSettlement(runtime, request, service, settlement)
  const result = buildExecutionResult(
    request,
    runtime,
    settlement,
    taskFact,
    retry,
    snapshot,
    service.facts(),
  )
  return {
    ...result,
    sessionAction,
    ...(wakeOutcome === undefined ? {} : { wakeOutcome }),
  }
}

async function resumeOrCreateAgent(
  request: ExecuteSingleRunRequest,
  workspace: string,
  setup: AgentSetup,
  service: CommandService,
  signal: AbortSignal,
): Promise<{ readonly handle: AgentHandle; readonly action: 'created' | 'resumed' }> {
  const sessionId = request.sessionId as SessionId
  if (request.ctx.agents.get(sessionId) !== undefined
    || request.ctx.sessions.get(sessionId) !== undefined) {
    throw new SingleRunError(
      'SESSION_ALREADY_LIVE',
      `Session ${JSON.stringify(request.sessionId)} is already live; refuse to drive a second owner`,
    )
  }
  try {
    const handle = await request.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: request.agentOptions,
      signal,
      setup: async (agentCtx, agent) => {
        await realpath(workspace)
        return setup(agentCtx, agent)
      },
    })
    return { handle, action: 'resumed' }
  } catch (error) {
    if (!isSessionNotFoundError(error)) throw error
  }
  await prepareWorkspace(workspace, request.admission.contract.spec.inputs, service)
  const handle = await request.ctx.agents.create({
    sessionId,
    meta: { cwd: workspace },
    agentOptions: request.agentOptions,
    signal,
    setup,
  })
  return { handle, action: 'created' }
}

function isSessionNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: unknown }).name === 'SessionPersistenceNotFoundError'
}

function buildAgentSetup(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  controller: RunToolController,
  budget: () => RemainingBudgetPct,
  checkBudget: (tokens?: number, steps?: number) => boolean,
): AgentSetup {
  return (agentCtx, agent) => {
    agentCtx.on('agent/request-error', () => Promise.resolve(undefined), { prepend: true })
    agentCtx.on('agent/pre-step', async ({ modelSelection, signal }, next) => {
      if (!checkBudget(0, 1)) return { kind: 'reject' }
      const info = await agentCtx.llm.resolveModelInfo(modelSelection.provider, modelSelection.model, signal)
      // Reserve the route's complete input + output capacity; estimates are not hard bounds.
      const capacity = info.context?.contextWindow
      if (!Number.isSafeInteger(capacity) || capacity === undefined || capacity <= 0
        || !checkBudget(capacity, 1)) return { kind: 'reject' }
      return next()
    })
    agentCtx.systemPrompt.section({
      name: 'singularity:worker-card',
      order: 100,
      text: renderWorkerCard(false),
      interpolate: false,
    })
    agentCtx.systemPrompt.context({
      name: 'singularity:node-view',
      order: 300,
      required: true,
      interpolate: false,
      text: () => renderNodeView(buildNodeView(runtime, request, controller, budget(), checkBudget())),
    })
    controller.register(agentCtx, agent)
    const globalNames = request.ctx.tools.definitions().map(definition => definition.name)
    if (runtime.baseToolNames.length > 0) {
      agentCtx.tools.restrict({ allow: [...runtime.baseToolNames] })
    } else if (globalNames.length > 0) {
      agentCtx.tools.restrict({ deny: globalNames })
    }
  }
}

/**
 * Recovers a submitted Run whose closure was not written. It reads the frozen
 * manifest from CAS, reuses the fixed `operationId`, and re-derives the verdict
 * from the independent verifier receipt. It never re-drives the model, never
 * re-freezes the submission, and never reads the activity workspace.
 */
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
  validateComposition(compositionPayloadOf(view.composition), view.contract)

  const runtime = buildRuntimeContext(
    request,
    actor,
    clock,
    view.contract,
    view.contractRef,
    view.compositionRef,
    view.runOpened.at,
    request.workspace,
    [],
  )
  const snapshot = recoverSessionSnapshot(request, submitted)
  let settlement: Settlement
  try {
    const frozen = await loadFrozenSubmission(service, view.contract, submitted)
    settlement = await settleSubmitted(runtime, request, service, snapshot, {
      readSelf: true,
      planningSketchRef: submitted.data.planningSketchRef,
      submission: frozen,
      submitted: true,
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

/**
 * Closes an open Run with an invalid ExecutionRecord without any Agent,
 * verifier, or retry attempt. Composition mismatch uses this path.
 */
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
    view.contractRef,
    view.compositionRef,
    view.runOpened.at,
    request.workspace,
    [],
  )
  const snapshot = recoverySnapshotWithoutAgent(request)
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

/**
 * Idempotent recovery after `run/closed`: never re-verifies or re-drives the
 * Run. When the Task closure is missing and the fixed retry policy does not
 * allow another attempt, the missing `task/closed` fact is appended again.
 */
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
    view.contractRef,
    view.compositionRef,
    view.runOpened.at,
    request.workspace,
    [],
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
  const details = await loadClosureDetails(service, request, view)
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
  request: ExecuteSingleRunRequest,
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

/** @internal Reads the frozen contract/composition/Run facts for one runId. */
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
  const admitted = facts.find((fact): fact is Extract<Fact, { type: 'task/admitted' }> =>
    fact.type === 'task/admitted' && fact.data.taskId === taskId)
  if (admitted === undefined) {
    throw new SingleRunError('RUN_NOT_FOUND', `Task ${JSON.stringify(taskId)} has no task/admitted fact`)
  }
  const task = state.tasks.get(taskId)
  if (task === undefined) throw new SingleRunError('RUN_NOT_FOUND', 'Run Task is missing from the projection')
  const contract = task.contract
  const contractRef = admitted.data.contract
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
    contractRef,
    composition,
    compositionRef,
    runOpened,
    ...(runSubmitted === undefined ? {} : { runSubmitted }),
    ...(runClosed === undefined ? {} : { runClosed }),
    ...(taskClosed === undefined ? {} : { taskClosed }),
    runIds: task.runIds,
  }
}

/** @internal Reads and verifies the Composition frozen by `run/opened`. */
export async function readFrozenComposition(
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

/** @internal Strips the seal from a frozen Composition for comparison. */
export function compositionPayloadOf(composition: Composition): CompositionPayload {
  const { digest, ...payload } = composition
  if (typeof digest !== 'string') {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'frozen Composition has no digest')
  }
  return parseProtocolValue(compositionPayloadSchema, payload)
}

/** @internal Full canonical comparison of actual versus frozen Composition. */
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
  let bytes = 0
  for (const check of manifest.checks) bytes += check.bytes
  return {
    manifest,
    manifestRef,
    inputRefs: contract.spec.inputs.map(input => input.object),
    outputRefs,
    checks: manifest.checks,
    bytes,
  }
}

function recoverSessionSnapshot(
  request: ExecuteSingleRunRequest,
  submitted: Extract<Fact, { readonly type: 'run/submitted' }>,
): SessionSnapshot {
  const live = request.ctx.sessions.get(request.sessionId as SessionId)
  if (live !== undefined) return snapshotSession(live)
  return {
    usage: { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 1 },
    sessionCut: {
      sessionId: submitted.data.transcriptOffset.sessionId,
      from: 0,
      to: submitted.data.transcriptOffset.seq,
    },
  }
}

/**
 * A non-Agent recovery path may read a live session but never resume one just
 * to fabricate usage. Without a live snapshot, usage stays unknown.
 */
function recoverySnapshotWithoutAgent(request: ExecuteSingleRunRequest): SessionSnapshot {
  const live = request.ctx.sessions.get(request.sessionId as SessionId)
  if (live !== undefined) return snapshotSession(live)
  return {
    usage: { ...zeroUsage, unknownRequests: 1 },
    sessionCut: { sessionId: request.sessionId, from: 0, to: 0 },
  }
}

function validateRequest(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
): void {
  for (const [label, value] of [
    ['journalRoot', request.journalRoot],
    ['workspace', request.workspace],
    ['sessionId', request.sessionId],
    ['runId', request.runId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new SingleRunError('INVALID_ARGUMENT', `${label} must be a non-empty string`)
    }
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'maxOutputBytes must be a positive safe integer')
  }
  if (typeof request.agentOptions.provider !== 'string' || request.agentOptions.provider.length === 0
    || typeof request.agentOptions.model !== 'string' || request.agentOptions.model.length === 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'agentOptions.provider and agentOptions.model are required')
  }
  parseProtocolValue(refSchema, request.verifier.provider)
  if (!Number.isSafeInteger(request.admission.attempt) || request.admission.attempt < 1) {
    throw new SingleRunError('INVALID_ARGUMENT', 'admission.attempt must be a positive safe integer')
  }
  if (actor.id.length === 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'actor.id must be non-empty')
  }
  if (typeof clock() !== 'number') {
    throw new SingleRunError('INVALID_ARGUMENT', 'clock must return a number')
  }
  for (const reason of request.transientInvalidReasons ?? []) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new SingleRunError('INVALID_ARGUMENT', 'transientInvalidReasons must be non-empty strings')
    }
  }
}

function validateComposition(
  composition: CompositionPayload,
  contract: TaskContract,
): void {
  if (composition.contract.id !== contract.taskId
    || composition.contract.digest !== contract.digest) {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      'composition.contract must reference the frozen root contract',
    )
  }
  if (composition.seed.id !== contract.environment.seed.id
    || composition.seed.digest !== contract.environment.seed.digest) {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      'composition.seed must equal contract.environment.seed',
    )
  }
  if (composition.dsh.version !== '0.2.2-alpha.2') {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      `DSH version must be 0.2.2-alpha.2, received ${JSON.stringify(composition.dsh.version)}`,
    )
  }
  if (composition.skills.length > 0 || composition.mcpServers.length > 0
    || composition.guidance !== undefined) {
    throw new SingleRunError(
      'UNSUPPORTED_RESOURCES',
      'this single-Run slice does not mount skills, MCP servers, or composition guidance',
    )
  }
  if (contract.resources.skills.length > 0
    || contract.resources.mcpServers.length > 0
    || contract.resources.exploration !== undefined) {
    throw new SingleRunError(
      'UNSUPPORTED_RESOURCES',
      'contract skills, MCP servers, and exploration resources are not mounted in this slice',
    )
  }
}

async function resolveBaseToolNames(
  contract: TaskContract,
  reader: CasObjectReader,
): Promise<readonly string[]> {
  const names: string[] = []
  const seen = new Set<string>()
  for (const ref of contract.resources.baseTools) {
    const { bytes } = await reader.readObject(ref, 'object')
    let value: JsonValue
    try {
      value = parseJsonText(strictUtf8.decode(bytes))
    } catch (error) {
      throw new SingleRunError('TOOL_UNAVAILABLE', 'base tool asset is not strict JSON', { cause: error })
    }
    const record = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, JsonValue>
      : undefined
    const name = typeof record?.['name'] === 'string'
      ? record['name']
      : typeof record?.['id'] === 'string' ? record['id'] : undefined
    if (name === undefined || name.length === 0) {
      throw new SingleRunError('TOOL_UNAVAILABLE', 'base tool asset must declare a name or id')
    }
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

function assertToolsAvailable(names: readonly string[], ctx: Context): void {
  const available = new Set(ctx.tools.definitions().map(definition => definition.name))
  for (const name of names) {
    if (!available.has(name)) {
      throw new SingleRunError(
        'TOOL_UNAVAILABLE',
        `declared base tool ${JSON.stringify(name)} is not registered by the DSH profile`,
      )
    }
  }
}

async function createToolController(
  prepared: PreparedRun,
  request: ExecuteSingleRunRequest,
  service: CommandService,
) {
  const { runtime, runOpened } = prepared
  const state = await service.taskRunState(runtime.transientInvalidReasons)
  const prior = usageCost([...state.runs.values()]
    .flatMap(run => run.taskId === runtime.contract.taskId && run.closed?.usage !== undefined ? [run.closed.usage] : []))
  const reservation = runOpened.data.budgetReservation
  const limits = {
    ...runtime.contract.limits,
    maxTokens: Math.min(reservation.tokens, runtime.contract.limits.maxTokens - prior.tokens),
    maxStepsPerRun: Math.min(reservation.steps, runtime.contract.limits.maxStepsPerRun),
    deadlineAt: Math.min(reservation.deadlineAt, runtime.contract.limits.deadlineAt),
  }
  let liveAgent: { readonly session: Session } | undefined
  let lastNow = runtime.startedAt
  let clockValid = true
  const currentUsage = () => liveAgent === undefined ? zeroUsage : snapshotSession(liveAgent.session).usage
  const checkBudget = (tokens = 0, steps = 0): boolean => {
    const now = runtime.clock()
    clockValid &&= Number.isSafeInteger(now) && now >= lastNow
    lastNow = now
    if (!clockValid || now >= limits.deadlineAt) return false
    const usage = currentUsage()
    const cost = usageCost([usage])
    return !prior.unknown && !cost.unknown
      && cost.tokens + tokens <= limits.maxTokens
      && usage.steps + steps <= limits.maxStepsPerRun
  }
  const budget = () => computeBudget(limits, currentUsage(), runtime.startedAt, runtime.clock(), prior.unknown)
  const controller = new RunToolController({
    contract: runtime.contract,
    runId: request.runId,
    sessionId: request.sessionId,
    workspace: runtime.workspace,
    writer: service,
    maxOutputBytes: runtime.maxOutputBytes,
    clock: runtime.clock,
    budget,
    checkBudget,
    epoch: () => initialContextEpoch(request.sessionId),
    onAgent: agent => {
      liveAgent = agent
    },
    commitSubmission: async (frozen, sessionId, transcriptSeq) => {
      const current = controller.snapshot()
      if (current.planningSketchRef === undefined) {
        throw new Error('planning sketch is missing at submit commit')
      }
      await commitRunSubmitted(service, runtime, request, frozen, sessionId, transcriptSeq, current.planningSketchRef)
      return frozen.manifestRef
    },
  })
  return { controller, budget, checkBudget,
    startBudget: computeBudget(limits, zeroUsage, runtime.startedAt, runtime.startedAt, prior.unknown) }
}

async function commitRunSubmitted(
  service: CommandService,
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  frozen: FrozenSubmission,
  sessionId: string,
  transcriptSeq: number,
  planningSketchRef: Ref,
): Promise<Fact> {
  return commitFact(
    service,
    runtime.actor,
    `run:${request.runId}:submitted`,
    'run.submitted',
    { runId: request.runId, taskId: runtime.contract.taskId },
    {
      runId: request.runId,
      outputs: frozen.manifestRef,
      planningSketchRef,
    } as unknown as JsonValue,
    'run/submitted',
    {
      runId: request.runId,
      outputs: frozen.manifestRef,
      transcriptOffset: { sessionId, seq: transcriptSeq },
      previewReceipts: [],
      readReceipts: [],
      planningSketchRef,
      feedbackRefs: [],
    },
    runtime.transientInvalidReasons,
  )
}

async function settleSubmitted(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  tools: RunToolSnapshot,
): Promise<Settlement> {
  const frozen = tools.submission
  if (frozen === undefined) throw new SingleRunError('INVALID_ARGUMENT', 'submission snapshot is missing')
  const verification = await verifyRunSubmission({
    contract: runtime.contract,
    runId: request.runId,
    manifest: frozen.manifest,
    inputs: frozen.inputRefs,
    outputs: frozen.outputRefs,
    verifier: runtime.verifier,
    reader: service,
    writer: service,
  }, runtime.clock)

  if (verification.verdict !== 'invalid') {
    const evidence = buildEvidence({
      contract: runtime.contract,
      runId: request.runId,
      composition: runtime.compositionRef,
      outputs: frozen.outputRefs,
      receipt: verification.receipt,
      receiptRef: verification.receiptRef,
      usage: snapshot.usage,
      sessionCut: snapshot.sessionCut,
      environmentMode: runtime.environmentMode,
    })
    const evidenceRef = await putSealed(service, `${request.runId}:evidence`, evidence, 'evidence')
    const runFact = await commitRunClosed(runtime, service, {
      runId: request.runId,
      classification: verification.verdict,
      reason: verification.reason,
      evidenceRef,
      usage: snapshot.usage,
      planningSketchRef: tools.planningSketchRef,
    })
    return {
      classification: verification.verdict,
      reason: verification.reason,
      runFact,
      manifest: frozen.manifest,
      manifestRef: frozen.manifestRef,
      receipt: verification.receipt,
      receiptRef: verification.receiptRef,
      evidence,
      evidenceRef,
    }
  }

  const executionRecord = buildExecutionRecord({
    contract: runtime.contract,
    runId: request.runId,
    composition: runtime.compositionRef,
    outputs: frozen.outputRefs,
    usage: snapshot.usage,
    sessionCut: snapshot.sessionCut,
    reason: verification.reason,
  })
  const executionRecordRef = await putSealed(
    service,
    `${request.runId}:execution-record`,
    executionRecord,
    'object',
  )
  const runFact = await commitRunClosed(runtime, service, {
    runId: request.runId,
    classification: 'invalid',
    reason: verification.code,
    executionRecordRef,
    usage: snapshot.usage,
    planningSketchRef: tools.planningSketchRef,
  })
  return {
    classification: 'invalid',
    reason: verification.code,
    runFact,
    manifest: frozen.manifest,
    manifestRef: frozen.manifestRef,
    executionRecord,
    executionRecordRef,
  }
}

async function settleExecutionRecord(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  tools: RunToolSnapshot,
  agentErrorCode: string | undefined,
  agentErrorDetail: string | undefined,
): Promise<Settlement> {
  let classification: 'failed' | 'invalid'
  let reason: string
  let recordReason: string
  if (agentErrorCode !== undefined || snapshot.failure !== undefined) {
    classification = 'invalid'
    reason = agentErrorCode ?? AGENT_ERROR_REASON
    const detail = agentErrorDetail ?? snapshot.failure
    recordReason = detail === undefined ? reason : `${reason}: ${detail}`
  } else if (tools.stopped !== undefined) {
    classification = 'failed'
    reason = `stop:${tools.stopped.reason}: ${tools.stopped.message}`
    recordReason = reason
  } else {
    classification = 'failed'
    reason = NO_SUBMISSION_REASON
    recordReason = NO_SUBMISSION_REASON
  }
  return settleRecord(runtime, request, service, snapshot, classification, reason, recordReason, tools)
}

async function settleInvalidRecord(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  reason: string,
): Promise<Settlement> {
  return settleRecord(runtime, request, service, snapshot, 'invalid', reason, reason, {
    readSelf: false,
    submitted: false,
    contextEpoch: initialContextEpoch(request.sessionId),
  })
}

async function settleRecord(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  classification: 'failed' | 'invalid',
  reason: string,
  recordReason: string,
  tools: RunToolSnapshot,
): Promise<Settlement> {
  const executionRecord = buildExecutionRecord({
    contract: runtime.contract,
    runId: request.runId,
    composition: runtime.compositionRef,
    usage: snapshot.usage,
    sessionCut: snapshot.sessionCut,
    reason: recordReason,
  })
  const executionRecordRef = await putSealed(
    service,
    `${request.runId}:execution-record`,
    executionRecord,
    'object',
  )
  const runFact = await commitRunClosed(runtime, service, {
    runId: request.runId,
    classification,
    reason,
    executionRecordRef,
    usage: snapshot.usage,
    planningSketchRef: tools.planningSketchRef,
  })
  return {
    classification,
    reason,
    runFact,
    executionRecord,
    executionRecordRef,
  }
}

interface CommitClosedEvidence {
  readonly runId: string
  readonly classification: 'verified' | 'failed'
  readonly reason: string
  readonly evidenceRef: Ref
  readonly usage: UsageRecord
  readonly planningSketchRef?: Ref
}

interface CommitClosedRecord {
  readonly runId: string
  readonly classification: 'failed' | 'invalid' | 'cancelled'
  readonly reason: string
  readonly executionRecordRef: Ref
  readonly usage: UsageRecord
  readonly planningSketchRef?: Ref
}

async function commitRunClosed(
  runtime: RuntimeContext,
  service: CommandService,
  closure: CommitClosedEvidence | CommitClosedRecord,
): Promise<Fact> {
  const base = {
    runId: closure.runId,
    reason: closure.reason,
    usage: closure.usage,
    ...(closure.planningSketchRef === undefined
      ? {}
      : { planningSketchRef: closure.planningSketchRef }),
    feedbackRefs: [],
  }
  const payload: RunClosedPayload = 'evidenceRef' in closure
    ? { ...base, classification: closure.classification, evidenceRef: closure.evidenceRef }
    : { ...base, classification: closure.classification, executionRecordRef: closure.executionRecordRef }
  return commitFact(
    service,
    runtime.actor,
    `run:${closure.runId}:closed`,
    'run.closed',
    { runId: closure.runId, taskId: runtime.contract.taskId },
    {
      runId: closure.runId,
      classification: closure.classification,
    } as unknown as JsonValue,
    'run/closed',
    payload,
    runtime.transientInvalidReasons,
  )
}

async function commitTaskClosed(
  runtime: RuntimeContext,
  service: CommandService,
  settlement: Settlement,
  runId: string,
  outcome: 'verified' | 'failed' | 'invalid' | 'cancelled',
): Promise<Fact> {
  const evidenceRefs = settlement.evidenceRef === undefined ? [] : [settlement.evidenceRef]
  return commitFact(
    service,
    runtime.actor,
    `task:${runtime.contract.taskId}:closed`,
    'task.closed',
    { taskId: runtime.contract.taskId },
    { taskId: runtime.contract.taskId, outcome },
    'task/closed',
    {
      taskId: runtime.contract.taskId,
      outcome,
      reason: settlement.reason,
      decisiveRunId: runId,
      evidenceRefs,
    },
    runtime.transientInvalidReasons,
  )
}

async function finalizeSettlement(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  settlement: Settlement,
): Promise<{ readonly taskFact?: Fact; readonly retry: RetryDecision }> {
  const retry = retryDecisionForRun(
    await service.taskRunState(runtime.transientInvalidReasons),
    runtime.contract,
    settlement.runFact,
    runtime.transientInvalidReasons,
    runtime.clock(),
  )
  let taskFact: Fact | undefined
  if (settlement.classification === 'verified') {
    taskFact = await commitTaskClosed(runtime, service, settlement, request.runId, 'verified')
  } else if (!retry.allowed
    && (settlement.classification === 'failed' || settlement.classification === 'invalid')) {
    taskFact = await commitTaskClosed(
      runtime,
      service,
      settlement,
      request.runId,
      settlement.classification,
    )
  }
  return {
    ...(taskFact === undefined ? {} : { taskFact }),
    retry,
  }
}

function buildExecutionResult(
  request: ExecuteSingleRunRequest,
  runtime: RuntimeContext,
  settlement: Settlement,
  taskFact: Fact | undefined,
  retry: RetryDecision,
  snapshot: SessionSnapshot,
  facts: readonly Fact[],
): ExecuteSingleRunResult {
  return {
    taskId: runtime.contract.taskId,
    runId: request.runId,
    sessionId: request.sessionId,
    classification: settlement.classification,
    ...(settlement.manifest === undefined ? {} : { manifest: settlement.manifest }),
    ...(settlement.manifestRef === undefined ? {} : { manifestRef: settlement.manifestRef }),
    ...(settlement.receipt === undefined ? {} : { receipt: settlement.receipt }),
    ...(settlement.receiptRef === undefined ? {} : { receiptRef: settlement.receiptRef }),
    ...(settlement.evidence === undefined ? {} : { evidence: settlement.evidence }),
    ...(settlement.evidenceRef === undefined ? {} : { evidenceRef: settlement.evidenceRef }),
    ...(settlement.executionRecord === undefined ? {} : { executionRecord: settlement.executionRecord }),
    ...(settlement.executionRecordRef === undefined
      ? {}
      : { executionRecordRef: settlement.executionRecordRef }),
    runFact: settlement.runFact,
    ...(taskFact === undefined ? {} : { taskFact }),
    usage: snapshot.usage,
    sessionCut: snapshot.sessionCut,
    retry,
    facts,
  }
}

/**
 * Applies the fixed retry policy from docs/framework.md §9.2 to one closed Run.
 * Runtime recovery and the reducer share the same pure decision.
 */
export function retryDecisionForRun(
  state: TaskRunState,
  contract: TaskContract,
  runFact: Fact,
  transientInvalidReasons: readonly string[],
  now: number,
): RetryDecision {
  const run = runFact.type === 'run/closed' ? state.runs.get(runFact.data.runId) : undefined
  const task = state.tasks.get(contract.taskId)
  if (run === undefined || task === undefined) return { allowed: false, reason: 'Run closure fact missing' }
  const { tokens, unknown } = usageCost([...state.runs.values()]
    .filter(attempt => state.tasks.get(attempt.taskId)?.rootTaskId === task.rootTaskId)
    .flatMap(attempt => attempt.closed?.usage === undefined ? [] : [attempt.closed.usage]))
  return decideRetryPolicy(
    {
      runPhase: run.phase,
      ...(run.closed === undefined ? {} : { closure: run.closed }),
      runCount: task.runIds.length,
      maxRuns: contract.limits.maxRuns,
      maxTokens: contract.limits.maxTokens,
      deadlineAt: contract.limits.deadlineAt,
      now,
      usageTokens: tokens,
      usageUnknown: unknown,
    },
    transientInvalidReasons,
  )
}

function buildNodeView(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  controller: RunToolController,
  budget: RemainingBudgetPct,
  withinBudget: boolean,
): NodeView {
  const tools = controller.snapshot()
  const asOf = runtime.clock()
  const canSubmit = withinBudget && tools.readSelf
    && tools.planningSketchRef !== undefined
    && !tools.submitted
    && tools.stopped === undefined
  const denialCodes: string[] = []
  if (!tools.readSelf) denialCodes.push('READ_SELF_FIRST')
  else if (tools.planningSketchRef === undefined) denialCodes.push('PLAN_FIRST')
  if (tools.submitted) denialCodes.push('ALREADY_SUBMITTED')
  if (tools.stopped !== undefined) denialCodes.push('RUN_CLOSED')
  if (!withinBudget) denialCodes.push('LIMIT_EXCEEDED')
  return {
    v: 1,
    asOf,
    contextEpoch: tools.contextEpoch,
    task: {
      id: runtime.contract.taskId,
      runId: request.runId,
      goalSummary: runtime.contract.spec.goal.summary,
      contractDigest: runtime.contract.digest,
      phase: tools.submitted ? 'integrating' : 'working',
      mode: 'guided',
    },
    method: runtime.contract.method,
    ownTemplate: { id: runtime.contract.template.id, brief: runtime.templateBrief },
    documents: [],
    skills: [],
    tools: runtime.baseToolNames.map(name => ({ name })),
    childOptions: [],
    requiredObligations: [],
    childBatch: null,
    childHistory: { total: 0, outcomes: {} },
    recentChildResults: [],
    obligations: {
      readSelf: !tools.readSelf,
      readPlanningSketch: tools.planningSketchRef === undefined,
      requiredFailure: false,
      canDecompose: false,
      canSubmit,
      denialCodes,
    },
    planningSketchRef: tools.planningSketchRef ?? null,
    feedback: { count: 0 },
    lastAttempt: null,
    budget,
    workspace: { cwd: runtime.workspace, outputs: runtime.contract.spec.outputs },
  }
}

function computeBudget(
  limits: TaskContract['limits'],
  usage: UsageRecord,
  startedAt: number,
  now: number,
  priorUnknown = false,
): RemainingBudgetPct {
  const cost = usageCost([usage])
  const tokensPct = priorUnknown || cost.unknown ? null : clampPercent(limits.maxTokens - cost.tokens, limits.maxTokens)
  const stepsPct = clampPercent(limits.maxStepsPerRun - usage.steps, limits.maxStepsPerRun)
  const wallClockPct = limits.deadlineAt <= startedAt
    ? 0
    : clampPercent(limits.deadlineAt - now, limits.deadlineAt - startedAt)
  const depthPct = limits.maxDepth <= 0 ? 100 : clampPercent(limits.maxDepth, limits.maxDepth)
  const taskSlotsPct = limits.maxTasks <= 0 ? 0 : clampPercent(limits.maxTasks - 1, limits.maxTasks)
  return { tokensPct, stepsPct, wallClockPct, depthPct, taskSlotsPct }
}

function usageCost(records: readonly UsageRecord[]): { readonly tokens: number; readonly unknown: boolean } {
  let tokens = 0
  let unknown = false
  for (const usage of records) {
    tokens += usage.inputTokens + usage.outputTokens + (usage.summary?.inputTokens ?? 0) + (usage.summary?.outputTokens ?? 0)
    unknown ||= usage.unknownRequests > 0 || (usage.summary?.unknownRequests ?? 0) > 0
  }
  return { tokens, unknown }
}

function snapshotSession(session: Session): SessionSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- alpha2 exposes no replacement raw reader
  const events = session.snapshotEvents()
  let inputTokens = 0
  let outputTokens = 0
  let steps = 0
  let unknownRequests = 0
  let failure: string | undefined
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') failure = event.data.reason.error.message
    if (event.type === 'step/start') pending.add(`${String(event.data.turn)}:${String(event.data.step)}`)
    if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') continue
    pending.delete(`${String(event.data.turn)}:${String(event.data.step)}`)
    steps += 1
    const usage = event.type === 'assistant/message' ? event.data.usage : undefined
    // alpha2 pi-ai supplies zero counters when its endpoint omits usage.
    const input = usage === undefined ? 0 : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    const output = usage?.outputTokens ?? 0
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 || input + output === 0) {
      unknownRequests += 1
      continue
    }
    inputTokens += input
    outputTokens += output
  }
  return {
    ...(failure === undefined ? {} : { failure }),
    usage: {
      inputTokens,
      outputTokens,
      steps: steps + pending.size,
      unknownRequests: unknownRequests + pending.size,
    },
    sessionCut: {
      sessionId: String(session.id),
      from: 0,
      to: events.length,
    },
  }
}

function emptySnapshot(sessionId: string): SessionSnapshot {
  return {
    usage: { ...zeroUsage },
    sessionCut: { sessionId, from: 0, to: 0 },
  }
}

async function putSealed(
  service: CommandService,
  id: string,
  value: JsonValue,
  domain: CasDigestDomain,
): Promise<Ref> {
  const ref = await service.putObject(id, textEncoder.encode(canonicalize(value)), domain)
  const digest = recordField(value, 'digest')
  if (typeof digest === 'string' && digest !== ref.digest) {
    throw new SingleRunError(
      'INVALID_ARGUMENT',
      `CAS ${domain} digest for ${JSON.stringify(id)} does not match its seal`,
    )
  }
  return ref
}

async function ensureObject(
  service: CommandService,
  ref: Ref,
  bytes: Uint8Array | undefined,
): Promise<void> {
  if (bytes !== undefined) {
    const stored = await service.putObject(ref.id, bytes, 'object')
    if (stored.digest !== ref.digest) {
      throw new SingleRunError(
        'INVALID_ARGUMENT',
        `object ${JSON.stringify(ref.id)} bytes do not match the frozen ref digest`,
      )
    }
    return
  }
  await service.readObject(ref, 'object')
}

async function commitFact<Type extends FactType>(
  service: CommandService,
  actor: FactActor,
  commandId: string,
  tool: string,
  scope: CommandScope,
  input: JsonValue,
  type: Type,
  data: FactPayloadMap[Type],
  transientInvalidReasons: readonly string[],
): Promise<Fact> {
  const command: NormalizedCommand = {
    v: 1,
    commandId,
    tool,
    toolVersion: 1,
    actor,
    scope,
    input,
  }
  return service.commitTaskRun({ command, type, data }, transientInvalidReasons)
}

function recordField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
