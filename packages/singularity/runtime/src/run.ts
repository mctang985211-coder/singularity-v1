import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

import {
  compositionPayloadSchema,
  parseJsonText,
  parseProtocolValue,
  refSchema,
  seal,
  verifyTaskContract,
} from '@singularity/protocol'
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
  TaskTemplate,
  UsageRecord,
} from '@singularity/protocol'

import { driveAgent, snapshotSession } from './agent.ts'
import type { OpenedRunMode } from './agent.ts'
import { initialContextEpoch } from './epoch.ts'
import { SingleRunError } from './errors.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { clampPercent, renderNodeView } from './prompt.ts'
import type { NodeView } from './prompt.ts'
import {
  MethodResourceError,
  assertCompositionResources,
  loadMethodResources,
} from './resources.ts'
import type { FrozenMethodResources } from './resources.ts'
import {
  buildExecutionResult,
  commitFact,
  finalizeSettlement,
  putSealed,
  settleExecutionRecord,
  settleSubmitted,
  usageCost,
} from './run-settlement.ts'
import { CommandService } from './service.ts'
import { RunToolController } from './tools.ts'
import type { RunVerifier } from './verification.ts'
import type { WakeDeliveryOutcome } from './wake.ts'
import type { CasObjectReader } from './workspace.ts'
import { prepareWorkspace } from './workspace.ts'
import type { FrozenSubmission } from './workspace.ts'

export { SingleRunError } from './errors.ts'
export type { SingleRunErrorCode } from './errors.ts'

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

/** Shared continuation result; recovery adds composition/session flags. */
export interface ContinueOpenedRunResult extends ExecuteSingleRunResult {
  /** `created` uses the same session intent when persistence is absent; `none` closed invalid. */
  readonly sessionAction: 'created' | 'none' | 'resumed'
  /** Stable wake outcome; `already-admitted` never buys another request. */
  readonly wakeOutcome?: WakeDeliveryOutcome
}

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
    const prepared = await openSingleRun(request, actor, clock, service)
    return await drivePreparedRun(prepared, request, service, 'create')
  } finally {
    await service.close()
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
    throw new SingleRunError('CONTRACT_INVALID', 'admission.contract is not a sealed root TaskContract')
  }
  if (contract.origin.kind !== 'root') {
    throw new SingleRunError('CONTRACT_INVALID', 'single-Run execution requires a root TaskContract')
  }
  const compositionPayload = parseProtocolValue(compositionPayloadSchema, request.composition)
  const methodResources = await loadMethodResources(service, contract)
  await assertCompositionResources(service, methodResources, compositionPayload)
  validateComposition(compositionPayload, contract)

  const baseToolNames = await resolveBaseToolNames(contract, service)
  assertToolsAvailable(baseToolNames, request.ctx)

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
  const state = await service.taskRunState(request.transientInvalidReasons ?? [])
  const existing = state.runs.get(request.runId)
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
    compositionRef,
    runOpened,
    workspace,
    methodResources,
    baseToolNames,
    lastAttempt: lastAttemptFromState(state, contract.taskId, request.runId),
    request,
  })
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

export async function drivePreparedRun(
  prepared: PreparedRun,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  mode: OpenedRunMode,
): Promise<ContinueOpenedRunResult> {
  const { runtime } = prepared
  const { controller, budget, checkBudget, stopBudget, startBudget } = await createToolController(prepared, request, service)
  const observation = await driveAgent({
    prepared,
    request,
    service,
    mode,
    controller,
    budget,
    checkBudget,
    stopBudget,
    startBudget,
    renderView: () => renderNodeView(buildNodeView(
      runtime,
      prepared.methodResources.template,
      request,
      controller,
      budget(),
    )),
  })
  const { snapshot } = observation
  const tools = controller.snapshot()
  const settlement = observation.agentErrorCode === undefined && snapshot.failure === undefined
    && !observation.drainPending && tools.submission !== undefined
    ? await settleSubmitted(runtime, request, service, snapshot, tools)
    : await settleExecutionRecord(
      runtime,
      request,
      service,
      snapshot,
      tools,
      observation.agentErrorCode,
      observation.agentErrorDetail,
      observation.drainPending,
    )

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
  if (composition.skills.length > 0 || composition.mcpServers.length > 0) {
    throw new MethodResourceError(
      'composition',
      'UNSUPPORTED_RESOURCES',
      'this single-Run slice does not mount skills or MCP servers',
    )
  }
  if (contract.resources.skills.length > 0
    || contract.resources.mcpServers.length > 0
    || contract.resources.exploration !== undefined) {
    throw new MethodResourceError(
      'composition',
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
  let active = true
  const currentUsage = () => liveAgent === undefined ? zeroUsage : snapshotSession(liveAgent.session).usage
  const checkBudget = (tokens = 0, steps = 0): boolean => {
    if (!active) return false
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
      if (!checkBudget()) throw new Error('Run budget unavailable')
      const current = controller.snapshot()
      if (current.planningSketchRef === undefined) {
        throw new Error('planning sketch is missing at submit commit')
      }
      await commitRunSubmitted(service, runtime, request, frozen, sessionId, transcriptSeq, current.planningSketchRef)
      return frozen.manifestRef
    },
  })
  return { controller, budget, checkBudget, stopBudget: () => { active = false },
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

function buildNodeView(
  runtime: RuntimeContext,
  template: TaskTemplate,
  request: ExecuteSingleRunRequest,
  controller: RunToolController,
  budget: RemainingBudgetPct,
): NodeView {
  const tools = controller.snapshot()
  const asOf = runtime.clock()
  const obligations = controller.obligations()
  return {
    v: 1,
    asOf,
    contextEpoch: tools.contextEpoch,
    task: {
      id: runtime.contract.taskId,
      runId: request.runId,
      goalSummary: runtime.contract.spec.goal.summary,
      contractDigest: runtime.contract.digest,
      phase: tools.submission === undefined ? 'working' : 'integrating',
      mode: 'guided',
    },
    method: runtime.contract.method,
    ownTemplate: { id: template.id, brief: template.brief },
    documents: [],
    skills: [],
    tools: runtime.baseToolNames.map(name => ({ name })),
    childOptions: [],
    requiredObligations: [],
    childBatch: null,
    childHistory: { total: 0, outcomes: {} },
    recentChildResults: [],
    obligations,
    planningSketchRef: tools.planningSketchRef ?? null,
    feedback: { count: 0 },
    lastAttempt: runtime.lastAttempt,
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

export {
  assertToolsAvailable,
  buildPreparedRun,
  buildRuntimeContext,
  lastAttemptFromState,
  resolveBaseToolNames,
  validateComposition,
  validateRequest,
}
