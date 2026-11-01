import { AdmissionError, assertChildLimitsWithinParent } from './admission.ts'
import { verifyDigest } from './digest.ts'
import type { Digest } from './digest.ts'
import { computeDigest } from './digest.ts'
import { resolveTemplateView } from './exploration.ts'
import type { GlobalResourceSnapshot } from './exploration.ts'
import { compositionSchema, verifyFact } from './fact.ts'
import type {
  AdmittedChild,
  ChildrenAdmittedPayload,
  Composition,
  Fact,
  RunClosedPayload,
  RunOpenedPayload,
  RunSubmittedPayload,
  TaskAdmittedPayload,
  TaskClosedPayload,
  UsageRecord,
} from './fact.ts'
import { verifyMethodRevision } from './method.ts'
import type { ChildBinding, MethodRevision, TaskTemplate } from './method.ts'
import { projectMethodRounds } from './method-round.ts'
import type { MethodRoundState } from './method-round.ts'
import type { RoundPlan } from './round-plan.ts'
import { sameRef } from './refs.ts'
import type { Ref } from './refs.ts'
import { parseProtocolValue } from './schema.ts'
import { verifyTaskContract } from './task.ts'
import type { TaskChildOrigin, TaskContract, TaskLimits } from './task.ts'

/** Stable reducer rejection codes. Messages remain diagnostics only. */
export const REDUCER_ERROR_CODES = [
  'UNSUPPORTED_FACT_TYPE',
  'FACT_INVALID',
  'CAS_REF_MISSING',
  'COMPOSITION_INVALID',
  'COMPOSITION_MISMATCH',
  'CONTRACT_INVALID',
  'METHOD_INVALID',
  'METHOD_TEMPLATE_MISMATCH',
  'TASK_ORIGIN_INVALID',
  'TASK_CONTRACT_MISMATCH',
  'DUPLICATE_TASK',
  'DUPLICATE_RUN',
  'UNKNOWN_TASK',
  'UNKNOWN_RUN',
  'TASK_NOT_OPEN',
  'TASK_NOT_ACTIVE',
  'TASK_ALREADY_CLOSED',
  'TASK_ACTIVE_RUN',
  'INVALID_ATTEMPT',
  'BUDGET_INVALID',
  'BUDGET_EXCEEDED',
  'RUN_NOT_OPEN',
  'RUN_ALREADY_CLOSED',
  'RUN_CLASSIFICATION_INVALID',
  'SESSION_MISMATCH',
  'CHILD_BATCH_EMPTY',
  'CHILD_BATCH_EXISTS',
  'CHILD_LIMIT_EXCEEDED',
  'CHILD_ORIGIN_MISMATCH',
  'CHILD_METHOD_MISMATCH',
  'CHILD_TEMPLATE_MISMATCH',
  'CHILD_BINDING_MISMATCH',
  'CHILD_JOIN_MISMATCH',
  'CHILD_DUPLICATE',
  'CHILD_ACTIVE',
  'BINDING_ALREADY_SATISFIED',
  'REPLACEMENT_REQUIRED',
  'REPLACEMENT_TARGET_INVALID',
  'JOIN_UNSATISFIED',
  'CHILDREN_NOT_TERMINAL',
  'RETRY_AVAILABLE',
  'RETRY_NOT_ALLOWED',
  'TASK_OUTCOME_INVALID',
  'EVIDENCE_MISMATCH',
  'CANCELLATION_INVALID',
] as const

export type ReducerErrorCode = (typeof REDUCER_ERROR_CODES)[number]

/** A deterministic reducer rejection; `factSeq`/`factType` identify the cause. */
export class ReducerError extends Error {
  override readonly name = 'ReducerError'
  readonly code: ReducerErrorCode
  readonly factSeq: number | undefined
  readonly factType: Fact['type'] | undefined

  constructor(code: ReducerErrorCode, message: string, fact?: Fact) {
    super(
      fact === undefined
        ? message
        : `${message} (fact seq ${String(fact.seq)}, type ${fact.type})`,
    )
    this.code = code
    this.factSeq = fact?.seq
    this.factType = fact?.type
  }
}

/**
 * Frozen CAS view supplied by the caller. The reducer never reads a live
 * registry, journal, filesystem, clock, or process; these objects are the
 * caller's immutable authority snapshot.
 */
export interface ReplayContext {
  readonly explorations?: ReadonlyMap<Digest, GlobalResourceSnapshot>
  /** CAS object id -> complete frozen contract. */
  readonly contracts: ReadonlyMap<string, TaskContract>
  /** Method revision id -> complete frozen revision. */
  readonly methods: ReadonlyMap<string, MethodRevision>
  /** CAS object id -> frozen Composition used by run/opened. */
  readonly compositions: ReadonlyMap<string, Composition>
  /** Deployment pre-listed transient infrastructure reasons for invalid retry. */
  readonly transientInvalidReasons: readonly string[]
}

export type TaskPhase = 'open' | 'active' | 'closed'
export type RunPhase = 'open' | 'submitted' | 'closed'
export type JoinKind = 'required' | 'probe'
export type RunClassification = RunClosedPayload['classification']
export type TaskOutcome = TaskClosedPayload['outcome']

/** How a Task entered its terminal projection. */
export interface TaskCloseState {
  readonly outcome: TaskOutcome
  readonly reason: string
  readonly source: 'task/closed' | 'subtree-cancellation'
  readonly factDigest: Digest
}

/** How a Run entered its terminal projection, including subtree cancellation. */
export interface RunCloseState {
  readonly classification: RunClassification
  readonly reason: string
  readonly source: 'run/closed' | 'subtree-cancellation'
  readonly factDigest: Digest
  readonly evidenceRef?: Ref
  readonly executionRecordRef?: Ref
  readonly usage?: UsageRecord
  readonly feedbackRefs?: readonly Ref[]
}

/** Read-only Task projection. */
export interface TaskState {
  readonly taskId: string
  readonly contract: TaskContract
  readonly rootTaskId: string
  readonly depth: number
  readonly phase: TaskPhase
  readonly activeRunId?: string
  readonly runIds: readonly string[]
  readonly childIds: readonly string[]
  readonly parentTaskId?: string
  readonly parentRunId?: string
  readonly batchId?: string
  readonly bindingId?: string
  readonly join?: JoinKind
  readonly supersededBy?: string
  readonly closed?: TaskCloseState
}

/** Read-only Run projection. */
export interface RunState {
  readonly runId: string
  readonly taskId: string
  readonly attempt: number
  readonly phase: RunPhase
  readonly opened: RunOpenedPayload
  readonly submitted?: RunSubmittedPayload
  readonly closed?: RunCloseState
  readonly childIds: readonly string[]
}

/** Read-only child batch projection. */
export interface ChildBatchState {
  readonly batchId: string
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly factDigest: Digest
  readonly childIds: readonly string[]
  readonly joins: ReadonlyMap<string, JoinKind>
}

/** Deterministic Task/Run fold result. */
export interface TaskRunState {
  readonly tasks: ReadonlyMap<string, TaskState>
  readonly runs: ReadonlyMap<string, RunState>
  /** Keyed by `childBatchKey(parentRunId, batchId)`, not by batchId alone. */
  readonly batches: ReadonlyMap<string, ChildBatchState>
}

export interface DomainReplayContext extends ReplayContext {
  readonly plans: ReadonlyMap<string, RoundPlan>
}

export interface DomainState extends TaskRunState, MethodRoundState {}

/** One journal fold; consumers read Task/Run and Method/Round facets. */
export function reduceDomainFacts(facts: readonly Fact[], context: DomainReplayContext): DomainState {
  return {
    ...reduceTaskRunFacts(facts.filter(fact => fact.type.startsWith('task/') || fact.type.startsWith('run/')), context),
    ...projectMethodRounds(facts, context.plans, context.methods),
  }
}

interface MutableTaskRecord {
  readonly taskId: string
  readonly contract: TaskContract
  readonly rootTaskId: string
  readonly depth: number
  readonly parentTaskId: string | undefined
  readonly parentRunId: string | undefined
  readonly batchId: string | undefined
  readonly bindingId: string | undefined
  readonly join: JoinKind | undefined
  readonly runIds: string[]
  readonly childIds: string[]
  phase: TaskPhase
  activeRunId: string | undefined
  supersededBy: string | undefined
  closed: TaskCloseState | undefined
}

interface MutableRunRecord {
  readonly runId: string
  readonly taskId: string
  readonly attempt: number
  readonly opened: RunOpenedPayload
  readonly childIds: string[]
  phase: RunPhase
  submitted: RunSubmittedPayload | undefined
  closed: RunCloseState | undefined
}

interface BatchRecord {
  readonly batchId: string
  readonly parentTaskId: string
  readonly parentRunId: string
  readonly factDigest: Digest
  readonly childIds: string[]
  readonly joins: Map<string, JoinKind>
}

interface ReducerRuntime {
  readonly context: ReplayContext
  readonly tasks: Map<string, MutableTaskRecord>
  readonly runs: Map<string, MutableRunRecord>
  readonly batches: Map<string, BatchRecord>
}

/** Public retry decision; `reason` is diagnostic, never a model verdict. */
export interface RetryDecision {
  readonly allowed: boolean
  readonly reason: string
}

/** Frozen inputs for the single retry policy shared by reducer and runtime. */
export interface RetryPolicyInput {
  /** Latest Run phase in the Task projection. */
  readonly runPhase: RunPhase
  /** Latest Run closure, when closed. */
  readonly closure?: RunCloseState
  /** Runs already opened for this Task, including the latest. */
  readonly runCount: number
  readonly maxRuns: number
  readonly maxTokens: number
  readonly deadlineAt: number
  /** Host clock in Unix epoch milliseconds. */
  readonly now: number
  /** Known subtree input+output tokens, including summary usage. */
  readonly usageTokens: number
  /** True when any subtree usage is unknown; retry then fails closed. */
  readonly usageUnknown: boolean
}

/**
 * Applies the fixed retry policy from docs/framework.md §9.2 without reading
 * a journal, clock, or live registry. Runtime reuses this exact decision and
 * the reducer calls it for task/closed guards.
 */
export function decideRetryPolicy(
  input: RetryPolicyInput,
  transientInvalidReasons: readonly string[],
): RetryDecision {
  if (input.runPhase !== 'closed' || input.closure === undefined) {
    return { allowed: false, reason: 'latest Run is not closed' }
  }
  const closure = input.closure
  if (closure.source !== 'run/closed') {
    return { allowed: false, reason: 'latest Run was cancelled by subtree closure' }
  }
  switch (closure.classification) {
    case 'verified':
      return { allowed: false, reason: 'latest Run is verified' }
    case 'cancelled':
      return { allowed: false, reason: 'cancelled Runs are not retried' }
    case 'invalid':
      if (!transientInvalidReasons.includes(closure.reason)) {
        return { allowed: false, reason: 'invalid reason is not pre-listed as transient' }
      }
      break
    case 'failed':
      break
  }
  if (input.runCount >= input.maxRuns) {
    return { allowed: false, reason: 'maxRuns is exhausted' }
  }
  if (input.now >= input.deadlineAt) {
    return { allowed: false, reason: 'deadline has been reached' }
  }
  if (input.usageUnknown) {
    return { allowed: false, reason: 'usage is unknown, so budget cannot be proven' }
  }
  if (input.usageTokens >= input.maxTokens) {
    return { allowed: false, reason: 'known token budget is exhausted' }
  }
  return { allowed: true, reason: 'retry is permitted' }
}

interface UsageTotals {
  tokens: number
  unknown: boolean
}

type FactOf<Type extends Fact['type']> = Extract<Fact, { readonly type: Type }>

/** Authority identity for one child batch inside a parent Run. */
export function childBatchKey(parentRunId: string, batchId: string): string {
  return `${parentRunId}\u0000${batchId}`
}

/**
 * Folds journal facts into the single Task/Run projection. Only the six
 * Task/Run fact types are accepted; every other fact type is rejected rather
 * than ignored. The function never mutates facts or the frozen context.
 */
export function reduceTaskRunFacts(
  facts: readonly Fact[],
  context: ReplayContext,
): TaskRunState {
  const runtime: ReducerRuntime = {
    context,
    tasks: new Map(),
    runs: new Map(),
    batches: new Map(),
  }

  for (const fact of facts) {
    if (!verifyFact(fact)) {
      fail('FACT_INVALID', fact, 'Fact digest or shape does not verify')
    }
    switch (fact.type) {
      case 'task/admitted':
        applyTaskAdmitted(runtime, fact)
        break
      case 'run/opened':
        applyRunOpened(runtime, fact)
        break
      case 'task/children-admitted':
        applyChildrenAdmitted(runtime, fact)
        break
      case 'run/submitted':
        applyRunSubmitted(runtime, fact)
        break
      case 'run/closed':
        applyRunClosed(runtime, fact)
        break
      case 'task/closed':
        applyTaskClosed(runtime, fact)
        break
      default:
        fail(
          'UNSUPPORTED_FACT_TYPE',
          fact,
          `Task/Run reducer does not handle fact type ${fact.type}`,
        )
    }
  }

  return snapshot(runtime)
}

function applyTaskAdmitted(runtime: ReducerRuntime, fact: FactOf<'task/admitted'>): void {
  const payload: TaskAdmittedPayload = fact.data
  const contract = resolveContract(payload.contract, runtime, fact)
  if (!verifyTaskContract(contract)) {
    fail('CONTRACT_INVALID', fact, 'Frozen contract does not verify in the contract domain')
  }
  if (payload.taskId !== contract.taskId) {
    fail('TASK_CONTRACT_MISMATCH', fact, 'taskId does not match the frozen contract')
  }
  if (contract.origin.kind !== 'root') {
    fail('TASK_ORIGIN_INVALID', fact, 'task/admitted only admits a root contract')
  }
  if (runtime.tasks.has(contract.taskId)) {
    fail('DUPLICATE_TASK', fact, `Task ${JSON.stringify(contract.taskId)} was already admitted`)
  }

  const method = resolveMethod(contract.method, runtime, fact)
  resolveTemplate(method, contract, runtime, fact)

  runtime.tasks.set(contract.taskId, {
    taskId: contract.taskId,
    contract,
    rootTaskId: contract.taskId,
    depth: 0,
    parentTaskId: undefined,
    parentRunId: undefined,
    batchId: undefined,
    bindingId: undefined,
    join: undefined,
    runIds: [],
    childIds: [],
    phase: 'open',
    activeRunId: undefined,
    supersededBy: undefined,
    closed: undefined,
  })
}

function applyRunOpened(runtime: ReducerRuntime, fact: FactOf<'run/opened'>): void {
  const payload = fact.data
  const task = requireTask(runtime, payload.taskId, fact)
  if (runtime.runs.has(payload.runId)) {
    fail('DUPLICATE_RUN', fact, `Run ${JSON.stringify(payload.runId)} already exists`)
  }
  if (task.phase !== 'open') {
    fail('TASK_NOT_OPEN', fact, `Task ${JSON.stringify(task.taskId)} is not open`)
  }
  for (const childId of task.childIds) {
    const child = requireTask(runtime, childId, fact)
    if (child.phase !== 'closed') {
      fail(
        'CHILDREN_NOT_TERMINAL',
        fact,
        `Cannot open a parent Run while child Task ${JSON.stringify(child.taskId)} is not terminal`,
      )
    }
  }

  const previousRunId = task.runIds.at(-1)
  if (previousRunId !== undefined) {
    const previousRun = requireRun(runtime, previousRunId, fact)
    const decision = retryDecision(runtime, task, previousRun, fact.at)
    if (!decision.allowed) {
      fail(
        'RETRY_NOT_ALLOWED',
        fact,
        `Retry is not allowed for task ${JSON.stringify(task.taskId)}: ${decision.reason}`,
      )
    }
  }

  if (
    !Number.isSafeInteger(payload.attempt) ||
    payload.attempt < 1 ||
    payload.attempt !== task.runIds.length + 1 ||
    payload.attempt > task.contract.limits.maxRuns
  ) {
    fail(
      'INVALID_ATTEMPT',
      fact,
      `Run attempt must be ${String(task.runIds.length + 1)} and within maxRuns`,
    )
  }
  assertReservation(payload.budgetReservation, task.contract.limits, fact)
  const composition = resolveComposition(payload.composition, runtime, fact)
  assertCompositionIdentity(composition, task, payload, fact)

  runtime.runs.set(payload.runId, {
    runId: payload.runId,
    taskId: task.taskId,
    attempt: payload.attempt,
    opened: payload,
    childIds: [],
    phase: 'open',
    submitted: undefined,
    closed: undefined,
  })
  task.runIds.push(payload.runId)
  task.phase = 'active'
  task.activeRunId = payload.runId
}

function applyChildrenAdmitted(
  runtime: ReducerRuntime,
  fact: FactOf<'task/children-admitted'>,
): void {
  const payload: ChildrenAdmittedPayload = fact.data
  const parentRun = requireRun(runtime, payload.parentRunId, fact)
  if (parentRun.phase !== 'open') {
    fail('RUN_NOT_OPEN', fact, `Parent Run ${JSON.stringify(parentRun.runId)} is not open`)
  }
  const parent = requireTask(runtime, parentRun.taskId, fact)
  if (parent.phase !== 'active' || parent.activeRunId !== parentRun.runId) {
    fail('TASK_NOT_ACTIVE', fact, 'Parent Run is not the active Run of its Task')
  }
  if (runtime.batches.has(childBatchKey(parentRun.runId, payload.batchId))) {
    fail(
      'CHILD_BATCH_EXISTS',
      fact,
      `Batch ${JSON.stringify(payload.batchId)} already exists in parent Run ${JSON.stringify(parentRun.runId)}`,
    )
  }
  if (payload.children.length === 0) {
    fail('CHILD_BATCH_EMPTY', fact, 'Child admissions must not be empty')
  }
  if (payload.children.length > parent.contract.limits.maxBatchChildren) {
    fail('CHILD_LIMIT_EXCEEDED', fact, 'Child batch exceeds maxBatchChildren')
  }
  for (const childId of parent.childIds) {
    const existing = requireTask(runtime, childId, fact)
    if (existing.phase !== 'closed') {
      fail(
        'CHILD_ACTIVE',
        fact,
        `Task ${JSON.stringify(existing.taskId)} is still active; only one child batch may run`,
      )
    }
  }

  const method = resolveMethod(parent.contract.method, runtime, fact)
  const parentTemplate = resolveTemplate(method, parent.contract, runtime, fact)
  const root = requireTask(runtime, parent.rootTaskId, fact)
  const subtreeTaskCount = [...runtime.tasks.values()].filter(
    task => task.rootTaskId === parent.rootTaskId,
  ).length
  if (subtreeTaskCount + payload.children.length > root.contract.limits.maxTasks) {
    fail('CHILD_LIMIT_EXCEEDED', fact, 'Admission exceeds the root maxTasks budget')
  }

  const pending: MutableTaskRecord[] = []
  const pendingIds = new Set<string>()
  const pendingBindings = new Set<string>()

  for (const admitted of payload.children) {
    const child = admitted.contract
    const childTaskId = child.taskId
    if (!verifyTaskContract(child)) {
      fail('CONTRACT_INVALID', fact, `Child contract ${JSON.stringify(childTaskId)} does not verify`)
    }
    if (runtime.tasks.has(child.taskId) || pendingIds.has(child.taskId)) {
      fail('CHILD_DUPLICATE', fact, `Child Task ${JSON.stringify(child.taskId)} already exists`)
    }
    pendingIds.add(child.taskId)

    const origin = childOriginOf(child, fact)
    if (
      origin.parentId !== parent.taskId ||
      origin.parentRunId !== parentRun.runId ||
      origin.batchId !== payload.batchId
    ) {
      fail(
        'CHILD_ORIGIN_MISMATCH',
        fact,
        `Child ${JSON.stringify(child.taskId)} origin does not match the parent admission`,
      )
    }
    const binding = resolveChildBinding(parentTemplate, origin, fact)
    if (binding.join === 'required' && pendingBindings.has(origin.bindingId)) {
      fail(
        'CHILD_DUPLICATE',
        fact,
        `Required binding ${JSON.stringify(origin.bindingId)} appears more than once in one batch`,
      )
    }
    pendingBindings.add(origin.bindingId)

    if (
      child.method.id !== parent.contract.method.id ||
      child.method.digest !== parent.contract.method.digest
    ) {
      fail('CHILD_METHOD_MISMATCH', fact, 'Child Task must pin the parent Method revision')
    }
    if (child.template.id !== binding.templateId) {
      fail(
        'CHILD_TEMPLATE_MISMATCH',
        fact,
        `Child template ${JSON.stringify(child.template.id)} does not match binding ${JSON.stringify(binding.templateId)}`,
      )
    }
    resolveTemplate(method, child, runtime, fact, 'CHILD_TEMPLATE_MISMATCH')
    if (admitted.join !== binding.join) {
      fail('CHILD_JOIN_MISMATCH', fact, 'Child join must equal the frozen binding join')
    }
    if (parent.depth + 1 > root.contract.limits.maxDepth) {
      fail('CHILD_LIMIT_EXCEEDED', fact, 'Admission exceeds the root maxDepth budget')
    }

    try {
      assertChildLimitsWithinParent(parent.contract.limits, child.limits)
    } catch (error) {
      if (error instanceof AdmissionError) {
        fail('CHILD_LIMIT_EXCEEDED', fact, error.message)
      }
      throw error
    }
    assertReservation(admitted.budgetReservation, child.limits, fact)

    if (binding.join === 'required' && hasBindingWinner(runtime, parent, parentRun.runId, binding.bindingId)) {
      fail(
        'BINDING_ALREADY_SATISFIED',
        fact,
        `Binding ${JSON.stringify(binding.bindingId)} already has a winner in this Run`,
      )
    }

    const eligible = eligiblePredecessors(runtime, parent, parentRun.runId, binding.bindingId)
    if (admitted.replacement !== undefined) {
      assertReplacementTargets(
        runtime,
        parent,
        parentRun.runId,
        binding.bindingId,
        admitted,
        eligible,
        fact,
      )
    } else if (binding.join === 'required' && eligible.length > 0) {
      fail(
        'REPLACEMENT_REQUIRED',
        fact,
        `Binding ${JSON.stringify(binding.bindingId)} has a terminal failed child; admission must be a replacement`,
      )
    }

    pending.push({
      taskId: child.taskId,
      contract: child,
      rootTaskId: parent.rootTaskId,
      depth: parent.depth + 1,
      parentTaskId: parent.taskId,
      parentRunId: parentRun.runId,
      batchId: payload.batchId,
      bindingId: binding.bindingId,
      join: admitted.join,
      runIds: [],
      childIds: [],
      phase: 'open',
      activeRunId: undefined,
      supersededBy: undefined,
      closed: undefined,
    })
  }

  const joins = new Map<string, JoinKind>()
  for (let index = 0; index < payload.children.length; index += 1) {
    const admitted = payload.children[index]
    const record = pending[index]
    joins.set(record.taskId, admitted.join)
    if (admitted.replacement !== undefined) {
      for (const supersededId of admitted.replacement.supersedesChildIds) {
        const superseded = requireTask(runtime, supersededId, fact)
        superseded.supersededBy = record.taskId
      }
    }
  }

  runtime.batches.set(childBatchKey(parentRun.runId, payload.batchId), {
    batchId: payload.batchId,
    parentTaskId: parent.taskId,
    parentRunId: parentRun.runId,
    factDigest: fact.digest,
    childIds: pending.map(record => record.taskId),
    joins,
  })
  for (const record of pending) {
    runtime.tasks.set(record.taskId, record)
    parent.childIds.push(record.taskId)
    parentRun.childIds.push(record.taskId)
  }
}

function applyRunSubmitted(runtime: ReducerRuntime, fact: FactOf<'run/submitted'>): void {
  const payload: RunSubmittedPayload = fact.data
  const run = requireRun(runtime, payload.runId, fact)
  if (run.phase === 'closed') {
    fail('RUN_ALREADY_CLOSED', fact, `Run ${JSON.stringify(run.runId)} is already closed`)
  }
  if (run.phase !== 'open') {
    fail('RUN_NOT_OPEN', fact, `Run ${JSON.stringify(run.runId)} is not open`)
  }
  const task = requireTask(runtime, run.taskId, fact)
  if (task.phase !== 'active' || task.activeRunId !== run.runId) {
    fail('TASK_NOT_ACTIVE', fact, 'Run is not the active Run of its Task')
  }
  if (payload.transcriptOffset.sessionId !== run.opened.sessionId) {
    fail('SESSION_MISMATCH', fact, 'submission transcript session does not match the Run session')
  }
  for (const childId of run.childIds) {
    const child = requireTask(runtime, childId, fact)
    if (child.phase !== 'closed') {
      fail(
        'CHILD_ACTIVE',
        fact,
        `Cannot submit while child Task ${JSON.stringify(child.taskId)} is not terminal`,
      )
    }
  }
  const method = resolveMethod(task.contract.method, runtime, fact)
  const template = resolveTemplate(method, task.contract, runtime, fact)
  for (const binding of template.children) {
    if (binding.join !== 'required') continue
    if (!hasBindingWinner(runtime, task, run.runId, binding.bindingId)) {
      fail(
        'JOIN_UNSATISFIED',
        fact,
        `Required binding ${JSON.stringify(binding.bindingId)} has no verified winner in the current Run`,
      )
    }
  }
  run.phase = 'submitted'
  run.submitted = payload
}

function applyRunClosed(runtime: ReducerRuntime, fact: FactOf<'run/closed'>): void {
  const payload: RunClosedPayload = fact.data
  const run = requireRun(runtime, payload.runId, fact)
  if (run.phase === 'closed') {
    fail('RUN_ALREADY_CLOSED', fact, `Run ${JSON.stringify(run.runId)} is already closed`)
  }
  const task = requireTask(runtime, run.taskId, fact)
  if (task.phase !== 'active' || task.activeRunId !== run.runId) {
    fail('TASK_NOT_ACTIVE', fact, 'Run is not the active Run of its Task')
  }
  if ('evidenceRef' in payload && run.phase !== 'submitted') {
    fail(
      'RUN_CLASSIFICATION_INVALID',
      fact,
      'Evidence-backed Run closure requires a submitted Run',
    )
  }

  run.closed = runCloseState(payload, fact.digest)
  run.phase = 'closed'
  task.activeRunId = undefined
  task.phase = payload.classification === 'verified' ? 'active' : 'open'
}

function applyTaskClosed(runtime: ReducerRuntime, fact: FactOf<'task/closed'>): void {
  const payload: TaskClosedPayload = fact.data
  const task = requireTask(runtime, payload.taskId, fact)
  if (task.phase === 'closed') {
    fail('TASK_ALREADY_CLOSED', fact, `Task ${JSON.stringify(task.taskId)} is already closed`)
  }

  if (payload.scope === 'subtree') {
    if (payload.cancellationCutRef === undefined) {
      fail(
        'CANCELLATION_INVALID',
        fact,
        'scope=subtree requires cancellationCutRef',
      )
    }
    if (payload.outcome !== 'failed' && payload.outcome !== 'cancelled') {
      fail(
        'CANCELLATION_INVALID',
        fact,
        'Subtree closure target outcome must be failed or cancelled',
      )
    }
    closeSubtree(runtime, task, payload, fact)
    return
  }
  if (payload.cancellationCutRef !== undefined) {
    fail(
      'CANCELLATION_INVALID',
      fact,
      'cancellationCutRef is only valid with scope=subtree',
    )
  }

  const closers = {
    verified: closeVerified,
    failed: closeUnverified,
    invalid: closeUnverified,
    cancelled: closeCancelled,
  }
  closers[payload.outcome](runtime, task, payload, fact)
  task.phase = 'closed'
  task.activeRunId = undefined
  task.closed = taskCloseState(payload, fact.digest)
}

function closeVerified(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  payload: TaskClosedPayload,
  fact: FactOf<'task/closed'>,
): void {
  if (task.phase !== 'active') {
    fail('TASK_NOT_ACTIVE', fact, 'Verified Task closure requires an active Task projection')
  }
  if (task.activeRunId !== undefined) {
    fail('TASK_ACTIVE_RUN', fact, 'Verified Task closure requires no active Run')
  }
  const decisiveRunId = payload.decisiveRunId
  if (decisiveRunId === undefined) {
    fail('TASK_OUTCOME_INVALID', fact, 'Verified Task closure requires decisiveRunId')
  }
  const decisiveRun = requireRun(runtime, decisiveRunId, fact)
  if (
    decisiveRun.taskId !== task.taskId ||
    decisiveRun.phase !== 'closed' ||
    decisiveRun.closed?.classification !== 'verified' ||
    decisiveRun.closed.source !== 'run/closed'
  ) {
    fail('TASK_OUTCOME_INVALID', fact, 'decisiveRunId must reference a verified Run closure')
  }
  if (task.runIds.at(-1) !== decisiveRun.runId) {
    fail('TASK_OUTCOME_INVALID', fact, 'decisiveRunId must be the latest Run of the Task')
  }
  for (const childId of task.childIds) {
    const child = requireTask(runtime, childId, fact)
    if (child.phase !== 'closed') {
      fail(
        'CHILDREN_NOT_TERMINAL',
        fact,
        `Task ${JSON.stringify(task.taskId)} has non-terminal child ${JSON.stringify(child.taskId)}`,
      )
    }
  }

  const runEvidence = decisiveRun.closed.evidenceRef
  if (
    runEvidence === undefined ||
    !payload.evidenceRefs.some(candidate => sameRef(candidate, runEvidence))
  ) {
    fail('EVIDENCE_MISMATCH', fact, 'task/closed evidenceRefs must include decisive Run Evidence')
  }

  const method = resolveMethod(task.contract.method, runtime, fact)
  const template = resolveTemplate(method, task.contract, runtime, fact)
  for (const binding of template.children) {
    if (binding.join !== 'required') continue
    if (!hasBindingWinner(runtime, task, decisiveRun.runId, binding.bindingId)) {
      fail(
        'JOIN_UNSATISFIED',
        fact,
        `Required binding ${JSON.stringify(binding.bindingId)} has no verified winner in the decisive Run`,
      )
    }
  }

}

function closeUnverified(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  payload: TaskClosedPayload,
  fact: FactOf<'task/closed'>,
): void {
  if (task.activeRunId !== undefined) {
    fail('TASK_ACTIVE_RUN', fact, 'Task closure requires no active Run')
  }
  if (task.runIds.length === 0 && payload.outcome === 'invalid') return
  const lastRun = latestRun(runtime, task, fact)
  if (lastRun.phase !== 'closed' || lastRun.closed?.classification !== payload.outcome) {
    fail('TASK_OUTCOME_INVALID', fact, 'Task outcome must match the latest Run closure')
  }
  if (payload.decisiveRunId !== undefined && payload.decisiveRunId !== lastRun.runId) {
    fail('TASK_OUTCOME_INVALID', fact, 'decisiveRunId must be the latest Run')
  }
  if (retryDecision(runtime, task, lastRun, fact.at).allowed) {
    fail('RETRY_AVAILABLE', fact, 'Task cannot close while its fixed retry policy still permits a Run')
  }
}

function closeCancelled(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  payload: TaskClosedPayload,
  fact: FactOf<'task/closed'>,
): void {
  closeTaskRuns(runtime, task, payload.reason, fact.digest)
}

function closeSubtree(
  runtime: ReducerRuntime,
  target: MutableTaskRecord,
  payload: TaskClosedPayload,
  fact: FactOf<'task/closed'>,
): void {
  const affected = [target, ...descendantsOf(runtime, target.taskId)].filter(
    task => task.phase !== 'closed',
  )
  for (const task of affected) {
    closeTaskRuns(runtime, task, payload.reason, fact.digest)
    task.phase = 'closed'
    task.activeRunId = undefined
    task.closed =
      task.taskId === target.taskId
        ? taskCloseState(payload, fact.digest)
        : {
            outcome: 'cancelled',
            reason: payload.reason,
            source: 'subtree-cancellation',
            factDigest: fact.digest,
          }
  }
}

function closeTaskRuns(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  reason: string,
  factDigest: Digest,
): void {
  for (const runId of task.runIds) {
    const run = requireRun(runtime, runId, undefined)
    if (run.phase === 'closed') continue
    run.phase = 'closed'
    run.closed = {
      classification: 'cancelled',
      reason,
      source: 'subtree-cancellation',
      factDigest,
    }
  }
}

function descendantsOf(runtime: ReducerRuntime, taskId: string): MutableTaskRecord[] {
  const result: MutableTaskRecord[] = []
  const queue = [taskId]
  while (queue.length > 0) {
    const parentId = queue.shift()
    if (parentId === undefined) continue
    for (const task of runtime.tasks.values()) {
      if (task.parentTaskId !== parentId) continue
      result.push(task)
      queue.push(task.taskId)
    }
  }
  return result
}

function taskCloseState(payload: TaskClosedPayload, factDigest: Digest): TaskCloseState {
  return {
    outcome: payload.outcome,
    reason: payload.reason,
    source: 'task/closed',
    factDigest,
  }
}

function runCloseState(payload: RunClosedPayload, factDigest: Digest): RunCloseState {
  const base = {
    classification: payload.classification,
    reason: payload.reason,
    source: 'run/closed' as const,
    factDigest,
    usage: payload.usage,
    feedbackRefs: payload.feedbackRefs,
  }
  if ('evidenceRef' in payload) {
    return { ...base, evidenceRef: payload.evidenceRef }
  }
  return { ...base, executionRecordRef: payload.executionRecordRef }
}

function retryDecision(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  run: MutableRunRecord,
  now: number,
): RetryDecision {
  return decideTaskRetryPolicy(runtime, task.taskId, run.runId, runtime.context.transientInvalidReasons, now)
}

/** One retry policy over the Task's attempts and every owning ancestor's budget. */
export function decideTaskRetryPolicy(
  state: Pick<TaskRunState, 'tasks' | 'runs'>,
  taskId: string,
  runId: string,
  transientInvalidReasons: readonly string[],
  now: number,
): RetryDecision {
  const task = state.tasks.get(taskId)
  const run = state.runs.get(runId)
  if (task === undefined || run === undefined) return { allowed: false, reason: 'Run closure fact missing' }
  let owner: TaskState | undefined = task
  while (owner !== undefined) {
    const totals = subtreeUsage(state, owner.taskId)
    const decision = decideRetryPolicy({
      runPhase: run.phase,
      closure: run.closed,
      runCount: task.runIds.length,
      maxRuns: task.contract.limits.maxRuns,
      maxTokens: owner.contract.limits.maxTokens,
      deadlineAt: owner.contract.limits.deadlineAt,
      now,
      usageTokens: totals.tokens,
      usageUnknown: totals.unknown,
    }, transientInvalidReasons)
    if (!decision.allowed) {
      return owner.taskId === task.taskId ? decision
        : { allowed: false, reason: `ancestor Task ${JSON.stringify(owner.taskId)}: ${decision.reason}` }
    }
    owner = owner.parentTaskId === undefined ? undefined : state.tasks.get(owner.parentTaskId)
  }
  return { allowed: true, reason: 'retry is permitted' }
}

function subtreeUsage(runtime: Pick<TaskRunState, 'tasks' | 'runs'>, taskId: string): UsageTotals {
  const totals: UsageTotals = { tokens: 0, unknown: false }
  const visit = (currentTaskId: string): void => {
    const task = runtime.tasks.get(currentTaskId)
    if (task === undefined) return
    for (const runId of task.runIds) {
      const run = runtime.runs.get(runId)
      const entry = run?.closed?.usage
      if (entry !== undefined) addUsage(totals, entry)
    }
    for (const childId of task.childIds) visit(childId)
  }
  visit(taskId)
  return totals
}

function addUsage(totals: UsageTotals, entry: UsageRecord): void {
  totals.tokens += entry.inputTokens + entry.outputTokens
  if (entry.unknownRequests > 0) totals.unknown = true
  if (entry.summary !== undefined) {
    totals.tokens += entry.summary.inputTokens + entry.summary.outputTokens
    if (entry.summary.unknownRequests > 0) totals.unknown = true
  }
}

function hasBindingWinner(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  parentRunId: string,
  bindingId: string,
): boolean {
  return task.childIds.some(childId => {
    const child = runtime.tasks.get(childId)
    return (
      child !== undefined &&
      child.parentRunId === parentRunId &&
      child.bindingId === bindingId &&
      child.phase === 'closed' &&
      child.closed?.outcome === 'verified' &&
      child.supersededBy === undefined
    )
  })
}

function eligiblePredecessors(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  parentRunId: string,
  bindingId: string,
): MutableTaskRecord[] {
  const eligible: MutableTaskRecord[] = []
  for (const childId of task.childIds) {
    const child = runtime.tasks.get(childId)
    if (child === undefined) continue
    if (child.parentRunId !== parentRunId) continue
    if (child.bindingId !== bindingId) continue
    if (child.phase !== 'closed') continue
    if (child.closed?.outcome === 'verified') continue
    if (child.supersededBy !== undefined) continue
    eligible.push(child)
  }
  return eligible
}

function assertReplacementTargets(
  runtime: ReducerRuntime,
  parent: MutableTaskRecord,
  parentRunId: string,
  bindingId: string,
  admitted: AdmittedChild,
  eligible: readonly MutableTaskRecord[],
  fact: FactOf<'task/children-admitted'>,
): void {
  const replacement = admitted.replacement
  if (replacement === undefined) return
  const targets = replacement.supersedesChildIds
  if (targets.length === 0) {
    fail('REPLACEMENT_TARGET_INVALID', fact, 'Replacement must supersede at least one child')
  }
  if (new Set(targets).size !== targets.length) {
    fail('REPLACEMENT_TARGET_INVALID', fact, 'Replacement target ids must be unique')
  }
  const eligibleIds = new Set(eligible.map(child => child.taskId))
  if (targets.length !== eligible.length || targets.some(targetId => !eligibleIds.has(targetId))) {
    fail(
      'REPLACEMENT_TARGET_INVALID',
      fact,
      `Replacement must supersede exactly the terminal nonverified children of binding ${JSON.stringify(bindingId)}`,
    )
  }
  for (const targetId of targets) {
    const target = requireTask(runtime, targetId, fact)
    if (target.parentTaskId !== parent.taskId) {
      fail('REPLACEMENT_TARGET_INVALID', fact, 'Replacement target must be a direct child')
    }
    if (target.parentRunId !== parentRunId) {
      fail(
        'REPLACEMENT_TARGET_INVALID',
        fact,
        'Replacement target must belong to the current parent Run',
      )
    }
    if (target.phase !== 'closed' || target.closed?.outcome === 'verified') {
      fail(
        'REPLACEMENT_TARGET_INVALID',
        fact,
        'Replacement may supersede only terminal nonverified children',
      )
    }
  }
}

function resolveChildBinding(
  template: TaskTemplate,
  origin: TaskChildOrigin,
  fact: FactOf<'task/children-admitted'>,
): ChildBinding {
  const matches = template.children.filter(binding => binding.bindingId === origin.bindingId)
  if (matches.length !== 1) {
    fail(
      'CHILD_BINDING_MISMATCH',
      fact,
      `Binding ${JSON.stringify(origin.bindingId)} is not available on the parent template`,
    )
  }
  return matches[0]
}

function childOriginOf(
  contract: TaskContract,
  fact: FactOf<'task/children-admitted'>,
): TaskChildOrigin {
  if (contract.origin.kind !== 'child') {
    fail('CHILD_ORIGIN_MISMATCH', fact, 'Admitted child contract must have a child origin')
  }
  return contract.origin
}

function assertReservation(
  reservation: { readonly tokens: number; readonly steps: number; readonly deadlineAt: number },
  limits: TaskLimits,
  fact: FactOf<'run/opened'> | FactOf<'task/children-admitted'>,
): void {
  if (
    !Number.isSafeInteger(reservation.tokens) ||
    !Number.isSafeInteger(reservation.steps) ||
    !Number.isSafeInteger(reservation.deadlineAt) ||
    reservation.tokens <= 0 ||
    reservation.steps <= 0 ||
    reservation.deadlineAt <= 0
  ) {
    fail('BUDGET_INVALID', fact, 'Budget reservation must use positive safe integers')
  }
  if (
    reservation.tokens > limits.maxTokens ||
    reservation.steps > limits.maxStepsPerRun ||
    reservation.deadlineAt > limits.deadlineAt
  ) {
    fail('BUDGET_EXCEEDED', fact, 'Budget reservation exceeds frozen Task limits')
  }
}

function resolveContract(
  ref: Ref,
  runtime: ReducerRuntime,
  fact: Fact,
): TaskContract {
  const contract = runtime.context.contracts.get(ref.id)
  if (contract === undefined || contract.digest !== ref.digest) {
    fail(
      'CAS_REF_MISSING',
      fact,
      `Frozen contract ${JSON.stringify(ref.id)} is missing or has a different digest`,
    )
  }
  return contract
}

function resolveComposition(
  ref: Ref,
  runtime: ReducerRuntime,
  fact: Fact,
): Composition {
  const candidate = runtime.context.compositions.get(ref.id)
  if (candidate === undefined) {
    fail(
      'CAS_REF_MISSING',
      fact,
      `Frozen Composition ${JSON.stringify(ref.id)} is missing`,
    )
  }
  let composition: Composition
  try {
    composition = parseProtocolValue(compositionSchema, candidate)
  } catch {
    fail('COMPOSITION_INVALID', fact, 'Frozen Composition does not satisfy its strict schema')
  }
  if (!verifyDigest('composition', composition)) {
    fail('COMPOSITION_INVALID', fact, 'Frozen Composition digest does not verify')
  }
  if (composition.digest !== ref.digest) {
    fail(
      'CAS_REF_MISSING',
      fact,
      `Frozen Composition ${JSON.stringify(ref.id)} has a different digest`,
    )
  }
  return composition
}

function assertCompositionIdentity(
  composition: Composition,
  task: MutableTaskRecord,
  opened: RunOpenedPayload,
  fact: FactOf<'run/opened'>,
): void {
  if (
    composition.contract.id !== task.contract.taskId ||
    composition.contract.digest !== task.contract.digest
  ) {
    fail(
      'COMPOSITION_MISMATCH',
      fact,
      'Composition contract id/digest does not match the frozen TaskContract',
    )
  }
  if (!sameRef(composition.seed, opened.workspaceSeed)) {
    fail(
      'COMPOSITION_MISMATCH',
      fact,
      'Composition seed does not match run/opened workspaceSeed',
    )
  }
}

function resolveMethod(
  ref: Ref,
  runtime: ReducerRuntime,
  fact: Fact,
): MethodRevision {
  const method = runtime.context.methods.get(ref.id)
  if (method === undefined || method.digest !== ref.digest) {
    fail(
      'CAS_REF_MISSING',
      fact,
      `Frozen Method ${JSON.stringify(ref.id)} is missing or has a different digest`,
    )
  }
  if (method.id !== ref.id || !verifyMethodRevision(method)) {
    fail('METHOD_INVALID', fact, `Frozen Method ${JSON.stringify(ref.id)} does not verify`)
  }
  return method
}

function resolveTemplate(
  method: MethodRevision,
  contract: TaskContract,
  runtime: ReducerRuntime,
  fact: Fact,
  code: ReducerErrorCode = 'METHOD_TEMPLATE_MISMATCH',
): TaskTemplate {
  const ref = contract.template
  const explorationRef = contract.resources.exploration
  const exploration = explorationRef === undefined ? undefined : runtime.context.explorations?.get(explorationRef.digest)
  if (exploration !== undefined && computeDigest('object', exploration) !== explorationRef?.digest) {
    fail(code, fact, 'Exploration snapshot must equal its frozen object digest')
  }
  const template = resolveTemplateView(method, ref.id, exploration)
  if (template === undefined || ref.digest !== method.digest) {
    fail(
      code,
      fact,
      `Template ${JSON.stringify(ref.id)} must exist once and reuse the Method digest`,
    )
  }
  return template
}

function requireTask(
  runtime: ReducerRuntime,
  taskId: string,
  fact: Fact | undefined,
): MutableTaskRecord {
  const task = runtime.tasks.get(taskId)
  if (task === undefined) {
    fail('UNKNOWN_TASK', fact, `Task ${JSON.stringify(taskId)} is not known`)
  }
  return task
}

function requireRun(
  runtime: ReducerRuntime,
  runId: string,
  fact: Fact | undefined,
): MutableRunRecord {
  const run = runtime.runs.get(runId)
  if (run === undefined) {
    fail('UNKNOWN_RUN', fact, `Run ${JSON.stringify(runId)} is not known`)
  }
  return run
}

function latestRun(
  runtime: ReducerRuntime,
  task: MutableTaskRecord,
  fact: FactOf<'task/closed'>,
): MutableRunRecord {
  const runId = task.runIds.at(-1)
  if (runId === undefined) {
    fail('TASK_OUTCOME_INVALID', fact, `Task ${JSON.stringify(task.taskId)} has no Run`)
  }
  return requireRun(runtime, runId, fact)
}

function fail(code: ReducerErrorCode, fact: Fact | undefined, message: string): never {
  throw new ReducerError(code, message, fact)
}

function snapshot(runtime: ReducerRuntime): TaskRunState {
  const tasks = new Map<string, TaskState>()
  for (const [taskId, task] of runtime.tasks) {
    tasks.set(taskId, {
      taskId: task.taskId,
      contract: task.contract,
      rootTaskId: task.rootTaskId,
      depth: task.depth,
      phase: task.phase,
      activeRunId: task.activeRunId,
      runIds: [...task.runIds],
      childIds: [...task.childIds],
      parentTaskId: task.parentTaskId,
      parentRunId: task.parentRunId,
      batchId: task.batchId,
      bindingId: task.bindingId,
      join: task.join,
      supersededBy: task.supersededBy,
      closed: task.closed === undefined ? undefined : { ...task.closed },
    })
  }

  const runs = new Map<string, RunState>()
  for (const [runId, run] of runtime.runs) {
    runs.set(runId, {
      runId: run.runId,
      taskId: run.taskId,
      attempt: run.attempt,
      phase: run.phase,
      opened: run.opened,
      submitted: run.submitted,
      closed: run.closed === undefined ? undefined : { ...run.closed },
      childIds: [...run.childIds],
    })
  }

  const batches = new Map<string, ChildBatchState>()
  for (const [batchId, batch] of runtime.batches) {
    batches.set(batchId, {
      batchId: batch.batchId,
      parentTaskId: batch.parentTaskId,
      parentRunId: batch.parentRunId,
      factDigest: batch.factDigest,
      childIds: [...batch.childIds],
      joins: new Map(batch.joins),
    })
  }

  return { tasks, runs, batches }
}
