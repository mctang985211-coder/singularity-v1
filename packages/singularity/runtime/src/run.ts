import { resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

import type {
BudgetReservation,
CompositionPayload,
Evidence,
ExecutionRecord,
Fact,
FactActor,
JsonValue,
PublicReceipt,
Ref,
RunClosedPayload,
SessionCut,
SubmissionManifest,
TaskContract,
TaskRunState,
UsageRecord,
} from '@singularity/protocol'
import {
compositionPayloadSchema,
parseJsonText,
parseProtocolValue,
refSchema,
seal,
verifyTaskContract,
} from '@singularity/protocol'

import type { OpenedRunMode } from './agent.ts'
import { driveAgent } from './agent.ts'
import type { ContractSummaryService } from './contract-summary.ts'
import { initialContextEpoch } from './epoch.ts'
import { SingleRunError } from './errors.ts'
import { renderLiveNodeView } from './node-view.ts'
import type { NodeView } from './prompt.ts'
import type { FrozenMethodResources } from './resources.ts'
import {
MethodResourceError,
assertCompositionResources,
loadMethodResources,
usesExploration,
} from './resources.ts'
import { createToolController } from './run-controller.ts'
import type { Settlement } from './run-settlement.ts'
import {
buildExecutionResult,
commitFact,
finalizeSettlement,
putSealed,
settleExecutionRecord,
settleSubmitted,
} from './run-settlement.ts'
import type { RunSessionAction,YieldedRunResult } from './run-yield.ts'
import { yieldedActiveChildBatch } from './run-yield.ts'
import { CommandService } from './service.ts'
import type { RunVerifier } from './verification.ts'
import { buildExecutionRecord } from './verification.ts'
import type { CasObjectReader } from './workspace.ts'
import { prepareWorkspace } from './workspace.ts'

export { SingleRunError } from './errors.ts'
export type { SingleRunErrorCode } from './errors.ts'

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** One sealed Task contract plus host-resolved Run intent. */
export interface SingleRunAdmission {
  /** Frozen root contract or a child contract from `task/children-admitted`. */
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
  /** Domain-owned derived summaries and their source Task usage. */
  readonly summaries?: ContractSummaryService
  /** Domain pool request-boundary check over reported ancestor/subtree usage. */
  readonly checkReportedBudget?: (reported?: { readonly tokens: number; readonly unknown: boolean }) => boolean
  readonly canOpenRun?: () => boolean
  /** The tree owner drains native lifecycle before its single subtree closure. */
  readonly signal?: AbortSignal
  readonly onBudgetExhausted?: () => void
}

/** Settlement result; exactly one of Evidence or ExecutionRecord is present. */
export interface ExecuteSingleRunResult {
  readonly kind: 'settled'
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

export type { YieldedRunResult } from './run-yield.ts'

/** Native lifecycle has drained; the tree owner commits the final subtree closure. */
export interface InterruptedRunResult {
  readonly kind: 'interrupted'
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly executionRecord: ExecutionRecord
  readonly executionRecordRef: Ref
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
}

export type RunAttemptResult = ExecuteSingleRunResult | YieldedRunResult | InterruptedRunResult

/** Narrows one attempt result before reading settled-only facts. */
export function isSettledRunResult(result: RunAttemptResult): result is ExecuteSingleRunResult {
  return result.kind === 'settled'
}

/** Normal and live yielded-parent execution share one driver result. */
type DrivenRunResult = RunAttemptResult & RunSessionAction

export interface RuntimeContext {
  readonly actor: FactActor
  readonly clock: () => number
  readonly transientInvalidReasons: readonly string[]
  readonly workspace: string
  readonly baseToolNames: readonly string[]
  readonly contract: TaskContract
  readonly compositionRef: Ref
  readonly startedAt: number
  readonly maxOutputBytes: number
  readonly verifier: RunVerifier
  /** Latest prior closed attempt of this Task, as exposed by NodeView §12.2. */
  readonly lastAttempt: NodeView['lastAttempt']
}

/** @internal One Run whose admission and `run/opened` fact are already durable. */
export interface PreparedRun {
  readonly contract: TaskContract
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly workspace: string
  readonly methodResources: FrozenMethodResources
  readonly mountedChildOutputs: Set<string>
  readonly runtime: RuntimeContext
}

/**
 * Executes exactly one Run: Task admission, `run/opened`, DSH create/setup,
 * one stable wake, one `whenIdle`, then either independent verification of the
 * frozen submission or an ExecutionRecord settlement. The function owns one
 * CommandService writer when one is not supplied by the domain owner.
 */
export async function executeSingleRun(
  request: ExecuteSingleRunRequest,
  sharedWriter?: CommandService,
): Promise<RunAttemptResult> {
  request = { ...request, transientInvalidReasons: sharedWriter?.retryPolicy(request.transientInvalidReasons) ?? request.transientInvalidReasons ?? [] }
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  validateRequest(request, actor, clock)
  const service = sharedWriter ?? await CommandService.open({ root: request.journalRoot, actor, clock, transientInvalidReasons: request.transientInvalidReasons })
  try {
    const prepared = await openSingleRun(request, actor, clock, service)
    return await driveLiveRun(prepared, request, service, 'create')
  } finally {
    if (sharedWriter === undefined) await service.close()
  }
}

async function openSingleRun(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  service: CommandService,
): Promise<PreparedRun> {
  const contract = request.admission.contract
  if (!verifyTaskContract(contract)) {
    throw new SingleRunError('CONTRACT_INVALID', 'admission.contract is not a sealed TaskContract')
  }
  if (request.verifier.provider.id !== contract.acceptance.id || request.verifier.provider.digest !== contract.acceptance.digest) {
    throw new SingleRunError('COMPOSITION_MISMATCH', 'verifier provider does not match the frozen acceptance')
  }
  const compositionPayload = parseProtocolValue(compositionPayloadSchema, request.composition)
  const methodResources = await loadMethodResources(service, contract)
  await assertCompositionResources(service, methodResources, compositionPayload)
  validateComposition(compositionPayload, contract)

  const baseToolNames = await resolveBaseToolNames(contract, service)
  assertToolsAvailable(baseToolNames, request.ctx)

  const state = await service.taskRunState(request.transientInvalidReasons ?? [])
  const existing = state.runs.get(request.runId)
  if (existing !== undefined) {
    throw new SingleRunError(
      existing.phase === 'closed' ? 'RUN_ALREADY_CLOSED' : 'RUN_ALREADY_OPENED',
      `Run ${JSON.stringify(request.runId)} already exists`,
    )
  }
  const lastAttempt = lastAttemptFromState(state, contract.taskId, request.runId)

  await prepareWorkspace(request.workspace, contract.spec.inputs, service)
  const workspace = resolve(request.workspace)

  const contractRef = await putSealed(service, contract.taskId, contract, 'contract')
  await ensureObject(service, contract.acceptance, request.admission.acceptanceBytes)
  await ensureObject(service, contract.environment.seed, request.admission.workspaceSeedBytes)

  const admitted = state.tasks.get(contract.taskId)
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
  } else if (admitted.contract.digest !== contract.digest) {
    throw new SingleRunError(
      'TASK_CONTRACT_MISMATCH',
      `Task ${JSON.stringify(contract.taskId)} was admitted with a different contract digest`,
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
    request.canOpenRun,
  ) as Extract<Fact, { readonly type: 'run/opened' }>

  return buildPreparedRun({
    actor,
    clock,
    contract,
    compositionRef,
    runOpened,
    workspace,
    methodResources,
    baseToolNames,
    lastAttempt,
    request,
  })
}

/** Only yielded parents in this live writer can continue; archives cannot resume. */
const yieldedRuns = new WeakMap<CommandService, Map<string, { prepared: PreparedRun; request: ExecuteSingleRunRequest }>>()

async function driveLiveRun(prepared: PreparedRun, request: ExecuteSingleRunRequest,
  service: CommandService, mode: OpenedRunMode): Promise<DrivenRunResult> {
  let result: DrivenRunResult
  try {
    result = await drivePreparedRun(prepared, request, service, mode)
  } catch (error) {
    try { await request.summaries?.cancelRun(request.runId) } catch (summaryError) {
      if (summaryError !== error) throw new AggregateError([error, summaryError], 'Run and owned Summary failed')
    }
    throw error
  }
  let waiting = yieldedRuns.get(service)
  if (waiting === undefined) { waiting = new Map(); yieldedRuns.set(service, waiting) }
  if (result.kind === 'yielded') waiting.set(request.runId, { prepared, request })
  else waiting.delete(request.runId)
  return result
}

/** Pool-only continuation of an observed yield in the current process. */
export async function continueYieldedRun(service: CommandService, runId: string): Promise<DrivenRunResult> {
  const waiting = yieldedRuns.get(service)
  const live = waiting?.get(runId)
  if (live === undefined) throw new SingleRunError('RUN_NOT_FOUND', 'Only a live yielded Run can continue')
  const state = await service.taskRunState()
  const batch = [...state.batches.values()].filter(batch => batch.parentRunId === runId).at(-1)
  if (batch === undefined || batch.childIds.some(id => state.tasks.get(id)?.phase !== 'closed')) {
    throw new SingleRunError('INVALID_ARGUMENT', 'The child batch must be terminal before continuing its parent')
  }
  waiting?.delete(runId)
  return driveLiveRun(live.prepared, live.request, service, 'resume')
}

/**
 * Latest prior closed Run of this Task. The retry worker sees only the public
 * closure reason, never the previous transcript or receipt body (§12.2/§12.4).
 */
function lastAttemptFromState(
  state: TaskRunState,
  taskId: string,
  currentRunId: string,
): NodeView['lastAttempt'] {
  const task = state.tasks.get(taskId)
  if (task === undefined) return null
  for (let index = task.runIds.length - 1; index >= 0; index -= 1) {
    const runId = task.runIds[index]
    if (runId === currentRunId) continue
    const closed = state.runs.get(runId)?.closed
    if (closed !== undefined) return { runId, reason: closed.reason }
  }
  return null
}

function buildPreparedRun(options: {
  readonly actor: FactActor
  readonly clock: () => number
  readonly contract: TaskContract
  readonly compositionRef: Ref
  readonly runOpened: Extract<Fact, { readonly type: 'run/opened' }>
  readonly workspace: string
  readonly methodResources: FrozenMethodResources
  readonly baseToolNames: readonly string[]
  readonly lastAttempt: NodeView['lastAttempt']
  readonly request: ExecuteSingleRunRequest
}): PreparedRun {
  return {
    contract: options.contract,
    runOpened: options.runOpened,
    workspace: options.workspace,
    methodResources: options.methodResources,
    mountedChildOutputs: new Set(),
    runtime: buildRuntimeContext(
      options.request,
      options.actor,
      options.clock,
      options.contract,
      options.compositionRef,
      options.runOpened.at,
      options.workspace,
      options.baseToolNames,
      options.lastAttempt,
    ),
  }
}

function buildRuntimeContext(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
  contract: TaskContract,
  compositionRef: Ref,
  startedAt: number,
  workspace: string,
  baseToolNames: readonly string[],
  lastAttempt: NodeView['lastAttempt'],
): RuntimeContext {
  return {
    actor,
    clock,
    transientInvalidReasons: request.transientInvalidReasons ?? [],
    workspace,
    baseToolNames,
    contract,
    compositionRef,
    startedAt,
    maxOutputBytes: request.maxOutputBytes,
    verifier: request.verifier,
    lastAttempt,
  }
}

async function drivePreparedRun(
  prepared: PreparedRun,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  mode: OpenedRunMode,
): Promise<DrivenRunResult> {
  const { runtime } = prepared
  const { controller, children, feedback, budget, checkBudget, stopBudget, startBudget } = await createToolController(prepared, request, service)
  const observation = await driveAgent({
    prepared,
    request,
    mode,
    controller,
    budget,
    checkBudget,
    stopBudget,
    startBudget,
    controllerState: () => service.taskRunState(runtime.transientInvalidReasons),
    renderView: () => renderLiveNodeView({
      contract: runtime.contract,
      runId: request.runId,
      workspace: runtime.workspace,
      baseToolNames: runtime.baseToolNames,
      template: prepared.methodResources.template,
      skills: prepared.methodResources.skills,
      ...(usesExploration(prepared.methodResources) ? { exploration: prepared.methodResources.exploration } : {}),
      mcpServers: prepared.methodResources.mcpServers,
      budget: budget(),
      lastAttempt: runtime.lastAttempt,
      asOf: runtime.clock(),
      contextEpoch: initialContextEpoch(request.sessionId),
      controller,
      children: children().view,
      feedback,
    }),
  })
  let { snapshot } = observation
  const tools = controller.snapshot()
  const state = await service.taskRunState(runtime.transientInvalidReasons)
  const yielded = yieldedActiveChildBatch({
    state,
    taskId: runtime.contract.taskId,
    runId: request.runId,
    sessionId: request.sessionId,
    tools,
    observation,
    facts: service.facts(),
  })
  if (yielded !== undefined && request.signal?.aborted !== true) return yielded
  const summary = await request.summaries?.finishRun(request.runId)
  if (summary !== undefined) snapshot = { ...snapshot, usage: { ...snapshot.usage, summary } }
  let settlement: Settlement | undefined
  if (request.signal?.aborted !== true) {
    settlement = observation.agentErrorCode === undefined && snapshot.failure === undefined
        && tools.submission !== undefined
      ? await settleSubmitted(runtime, request, service, snapshot, tools)
      : await settleExecutionRecord(
        runtime, request, service, snapshot, tools,
        observation.agentErrorCode, observation.agentErrorDetail,
      )
  }
  if (settlement === undefined) {
    const executionRecord = buildExecutionRecord({
      contract: runtime.contract, runId: request.runId, composition: runtime.compositionRef,
      usage: snapshot.usage, sessionCut: snapshot.sessionCut,
      reason: String(request.signal?.reason),
      ...(tools.submission === undefined ? {} : { outputs: tools.submission.outputRefs }),
    })
    const executionRecordRef = await putSealed(service, `${request.runId}:execution-record`, executionRecord, 'object')
    return { kind: 'interrupted', taskId: runtime.contract.taskId, runId: request.runId,
      sessionId: request.sessionId, executionRecord, executionRecordRef, usage: snapshot.usage,
      sessionCut: snapshot.sessionCut, sessionAction: observation.sessionAction }
  }
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
    sessionAction: observation.sessionAction,
    ...(observation.wakeOutcome === undefined ? {} : { wakeOutcome: observation.wakeOutcome }),
  }
}

/** @internal Shared host-owned request validation for execute, retry, and resume. */
export function validateHostRequest(
  request: {
    readonly journalRoot: string
    readonly workspace: string
    readonly runId: string
    readonly sessionId?: string
    readonly maxOutputBytes: number
    readonly agentOptions: AgentOptions
    readonly verifier: RunVerifier
    readonly transientInvalidReasons?: readonly string[]
  },
  actor: FactActor,
  clock: () => number,
): void {
  const required: readonly (readonly [string, unknown])[] = [
    ['journalRoot', request.journalRoot],
    ['workspace', request.workspace],
    ['runId', request.runId],
    ...(request.sessionId === undefined ? [] : [['sessionId', request.sessionId] as const]),
  ]
  for (const [label, value] of required) {
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
  try {
    parseProtocolValue(refSchema, request.verifier.provider)
  } catch (error) {
    throw new SingleRunError('INVALID_ARGUMENT', 'verifier.provider is not a valid ref', { cause: error })
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

function validateRequest(
  request: ExecuteSingleRunRequest,
  actor: FactActor,
  clock: () => number,
): void {
  validateHostRequest(request, actor, clock)
  if (!Number.isSafeInteger(request.admission.attempt) || request.admission.attempt < 1) {
    throw new SingleRunError('INVALID_ARGUMENT', 'admission.attempt must be a positive safe integer')
  }
}

function validateComposition(
  composition: CompositionPayload,
  contract: TaskContract,
): void {
  if (composition.contract.id !== contract.taskId
    || composition.contract.digest !== contract.digest) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'composition.contract must reference the frozen root contract',
    )
  }
  if (composition.seed.id !== contract.environment.seed.id
    || composition.seed.digest !== contract.environment.seed.digest) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'composition.seed must equal contract.environment.seed',
    )
  }
  if (composition.dsh.version !== '0.2.2-alpha.2') {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      `DSH version must be 0.2.2-alpha.2, received ${JSON.stringify(composition.dsh.version)}`,
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
