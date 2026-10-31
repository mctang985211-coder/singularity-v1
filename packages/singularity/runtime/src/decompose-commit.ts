import type { Session } from '@deepseek-ai/dsh-session'
import {
  AdmissionError,
  admitChildBatch,
  computeCommandDigest,
  computeDigest,
  decomposeCommitSchema,
  parseProtocolValue,
} from '@singularity/protocol'
import type {
  ChildBatchState,
  ChildrenAdmittedPayload,
  DecomposeCommit,
  Fact,
  FactActor,
  InputRef,
  JsonValue,
  NormalizedCommand,
  Ref,
  ResourceBinding,
  TaskContract,
  TaskLimits,
  TaskRunState,
  TaskTemplate,
} from '@singularity/protocol'

import type { PrepareDeliveryView } from './decompose-deliveries.ts'
import { readPrepareDeliveries } from './decompose-deliveries.ts'
import { DecomposeError } from './errors.ts'
import type { FrozenMethodResources } from './resources.ts'
import { resolveResourceTemplate, resourceAssetCatalog, usesExploration } from './resources.ts'
import { commitFact, usageCost } from './run-settlement.ts'
import type { CommandService } from './service.ts'

export interface DecomposeCommitChild {
  readonly taskId: string
  readonly bindingId: string
  readonly join: 'required' | 'probe'
}

export interface DecomposeCommitResult {
  readonly status: 'admitted'
  readonly parentRunId: string
  readonly batchId: string
  readonly children: readonly DecomposeCommitChild[]
  readonly deliveryReceiptRefs: readonly Ref[]
  readonly fact: Fact
}

export interface CommitDecomposeInput {
  readonly contract: TaskContract
  readonly parentRunId: string
  readonly sessionId: string
  readonly resources: FrozenMethodResources
  readonly service: CommandService
  readonly session: Session
  readonly callId: string
  readonly planningSketchRef: Ref
  readonly actor: FactActor
  readonly transientInvalidReasons: readonly string[]
  /** Tokens already consumed by the live parent Run (closed Runs are read from state). */
  readonly liveTokens: number
  readonly args: DecomposeCommit
  /** Initial inputs plus frozen direct outputs authorized by the current host cut. */
  readonly authorizedInputs?: readonly InputRef[]
}

/** Active batch for one parent Run; a batch is active until every child Task is terminal. */
export function activeChildBatch(
  state: TaskRunState,
  parentRunId: string,
): ChildBatchState | undefined {
  for (const batch of state.batches.values()) {
    if (batch.parentRunId !== parentRunId) continue
    if (batch.childIds.some(childId => state.tasks.get(childId)?.phase !== 'closed')) return batch
  }
  return undefined
}

/**
 * Admits one strict decompose commit, then appends exactly one
 * task/children-admitted fact through the single CommandService writer. No
 * child is dispatched and no child Run is opened.
 */
export async function commitDecomposeBatch(input: CommitDecomposeInput): Promise<DecomposeCommitResult> {
  const args = parseProtocolValue(decomposeCommitSchema, input.args)
  if (args.children.length === 0) {
    throw new DecomposeError('INVALID_ARGUMENT', 'commit must contain at least one child')
  }
  const commandId = `${input.sessionId}:${input.callId}:decompose-commit`
  const batchId = `batch:${input.sessionId}:${input.callId}`
  const command: NormalizedCommand = {
    v: 1,
    commandId,
    tool: 'singularity_decompose',
    toolVersion: 1,
    actor: input.actor,
    scope: { taskId: input.contract.taskId, runId: input.parentRunId, sessionId: input.sessionId },
    input: args as unknown as JsonValue,
  }
  const commandDigest = computeCommandDigest(command)

  // The persisted prepare delivery is the only ack authority. Reading it
  // before the state guards also lets an idempotent replay rebuild the original
  // receipt refs from the same session/CAS source.
  const deliveries = await readPrepareDeliveries({
    contract: input.contract,
    runId: input.parentRunId,
    resources: input.resources,
    reader: input.service,
    session: input.session,
    currentCallId: input.callId,
  })

  const existing = input.service.facts().find(fact => fact.commandId === commandId)
  if (existing !== undefined) {
    if (existing.commandDigest !== commandDigest) {
      throw new DecomposeError(
        'IDEMPOTENCY_CONFLICT',
        `command ${JSON.stringify(commandId)} was already committed with a different digest`,
      )
    }
    return resultFromFact(
      existing,
      batchId,
      receiptRefsFor(args.children, deliveries),
    )
  }

  const state = await input.service.taskRunState(input.transientInvalidReasons)
  const parentRun = state.runs.get(input.parentRunId)
  const parentTask = state.tasks.get(input.contract.taskId)
  if (parentRun === undefined || parentRun.phase !== 'open'
    || parentTask === undefined || parentTask.phase !== 'active'
    || parentTask.activeRunId !== input.parentRunId) {
    throw new DecomposeError('INVALID_ARGUMENT', 'the parent Run is not open and active')
  }
  if (activeChildBatch(state, input.parentRunId) !== undefined) {
    throw new DecomposeError('CHILD_BATCH_ACTIVE', 'the parent Run already has an active child batch')
  }
  if (input.planningSketchRef.id.length === 0) {
    throw new DecomposeError('INVALID_ARGUMENT', 'the current PlanningSketch is missing')
  }

  const childCount = args.children.length
  const available = taskRemainingTokens(
    state,
    input.contract.taskId,
    input.contract.limits.maxTokens,
    input.liveTokens,
  )
  if (available <= 0) {
    throw new DecomposeError('LIMIT_EXCEEDED', 'the parent Run has no budget for this child batch')
  }
  const perTokens = Math.floor(available / childCount)
  const perSteps = Math.floor(input.contract.limits.maxStepsPerRun / childCount)
  if (perTokens < 1 || perSteps < 1) {
    throw new DecomposeError('LIMIT_EXCEEDED', 'the parent Run has no budget for this child batch')
  }
  if (input.contract.limits.maxDepth <= 0 || input.contract.limits.maxTasks <= 1
    || subtreeTaskCount(state, input.contract.taskId) + childCount > input.contract.limits.maxTasks) {
    throw new DecomposeError('LIMIT_EXCEEDED', 'the parent Task has no remaining depth or task slots')
  }

  const previews: PrepareDeliveryView[] = []
  const childRequests = args.children.map((child, index) => {
    const preview = selectCurrentPreview(deliveries, child.bindingId, child.ackPreview)
    previews.push(preview)
    const template = resolveResourceTemplate(input.resources, findBinding(input.resources.template, child.bindingId).templateId)
    if (template === undefined) {
      throw new DecomposeError('BINDING_FIXED', 'child template is not fixed by the pinned Method')
    }
    const tokens = perTokens + (index === 0 ? available - perTokens * childCount : 0)
    const steps = perSteps
    const limits: TaskLimits = {
      maxRuns: input.contract.limits.maxRuns,
      maxStepsPerRun: steps,
      maxTokens: tokens,
      deadlineAt: input.contract.limits.deadlineAt,
      maxDepth: input.contract.limits.maxDepth - 1,
      maxTasks: Math.max(1, input.contract.limits.maxTasks - 1),
      maxBatchChildren: input.contract.limits.maxBatchChildren,
    }
    return {
      bindingId: child.bindingId,
      taskId: childTaskId(input.contract.taskId, batchId, child.bindingId),
      authorizedInputs: authorizeInputs(input.authorizedInputs ?? input.contract.spec.inputs, child.task.inputs),
      proposal: child.task,
      resources: childResources(input.contract, input.resources, template),
      environment: {
        seed: { ...input.contract.environment.seed },
        profile: { ...input.contract.environment.profile },
      },
      limits,
      budgetReservation: {
        tokens,
        steps,
        deadlineAt: input.contract.limits.deadlineAt,
      },
    }
  })

  let batch
  try {
    batch = admitChildBatch({
      parent: input.contract,
      method: input.resources.method,
      ...(input.resources.exploration === undefined ? {} : { exploration: input.resources.exploration }),
      parentRunId: input.parentRunId,
      batchId,
      children: childRequests,
    })
  } catch (error) {
    if (error instanceof AdmissionError) {
      throw new DecomposeError(error.code, error.message, { cause: error })
    }
    throw error
  }

  const replacements = new Map<string, { feedbackRef: Ref; supersedesChildIds: string[] }>()
  for (const child of batch.children) {
    if (child.join !== 'required') continue
    const predecessors = [...state.tasks.values()].filter(task => task.parentRunId === input.parentRunId
      && task.bindingId === child.bindingId && task.phase === 'closed'
      && task.closed?.outcome !== 'verified' && task.supersededBy === undefined)
    if (predecessors.length === 0) continue
    const feedbackRef = predecessors.flatMap(task => task.runIds.flatMap(runId =>
      state.runs.get(runId)?.closed?.feedbackRefs ?? [])).at(-1)
    if (feedbackRef === undefined) {
      throw new DecomposeError('REQUIRED_FEEDBACK_REPLAN', 'replacement requires terminal predecessor feedback')
    }
    replacements.set(child.contract.taskId, { feedbackRef, supersedesChildIds: predecessors.map(task => task.taskId) })
  }
  const data: ChildrenAdmittedPayload = {
    parentRunId: input.parentRunId,
    batchId,
    children: batch.children.map(child => {
      const replacement = replacements.get(child.contract.taskId)
      return { contract: child.contract, join: child.join, budgetReservation: child.budgetReservation,
        ...(replacement === undefined ? {} : { replacement }) }
    }),
  }
  const fact = await commitFact(
    input.service,
    input.actor,
    commandId,
    'singularity_decompose',
    { taskId: input.contract.taskId, runId: input.parentRunId, sessionId: input.sessionId },
    args as unknown as JsonValue,
    'task/children-admitted',
    data,
    input.transientInvalidReasons,
  )
  return {
    status: 'admitted',
    parentRunId: input.parentRunId,
    batchId,
    children: batch.children.map(child => ({
      taskId: child.contract.taskId,
      bindingId: child.bindingId,
      join: child.join,
    })),
    deliveryReceiptRefs: previews.map(preview => preview.deliveryReceiptRef),
    fact,
  }
}

function selectCurrentPreview(
  deliveries: readonly PrepareDeliveryView[],
  bindingId: string,
  ackPreview: string,
): PrepareDeliveryView {
  const matching = deliveries
    .filter(delivery => delivery.bindingId === bindingId && delivery.previewRef.digest === ackPreview)
    .sort((left, right) => right.resultSeq - left.resultSeq)
  const current = matching.find(delivery => delivery.state === 'current')
  if (current !== undefined) return current
  if (matching.some(delivery => delivery.state === 'next-step-required')) {
    throw new DecomposeError('NEXT_STEP_REQUIRED', 'prepare must precede commit on a later model step')
  }
  if (matching.some(delivery => delivery.state === 'stale')) {
    throw new DecomposeError('PREVIEW_STALE', 'the prepared preview is stale in this context epoch')
  }
  throw new DecomposeError('PREVIEW_REQUIRED', 'commit requires a matching persisted prepare delivery')
}

function findBinding(template: TaskTemplate, bindingId: string) {
  const matches = template.children.filter(binding => binding.bindingId === bindingId)
  if (matches.length !== 1) {
    throw new DecomposeError('BINDING_FIXED', `binding ${JSON.stringify(bindingId)} is not visible`)
  }
  return matches[0]
}

function childTaskId(parentTaskId: string, batchId: string, bindingId: string): string {
  // DSH uses session ids in filenames; bound their size independently of depth.
  return `child:${computeDigest('object', { parentTaskId, batchId, bindingId }).slice(7)}`
}

function authorizeInputs(parentInputs: readonly InputRef[], proposed: readonly InputRef[]): InputRef[] {
  for (const input of proposed) {
    const authorized = parentInputs.find(parent =>
      parent.id === input.id
      && sameRef(parent.object, input.object)
      && parent.path === input.path
      && parent.access === input.access)
    if (authorized === undefined) {
      throw new DecomposeError('INPUT_NOT_AUTHORIZED', `input ${JSON.stringify(input.id)} is not authorized by the parent Task`)
    }
  }
  return proposed.map(input => ({
    id: input.id,
    object: { ...input.object },
    path: input.path,
    access: input.access,
  }))
}

function childResources(
  parent: TaskContract,
  resources: Pick<FrozenMethodResources, 'method' | 'exploration'>,
  template: TaskTemplate,
): ResourceBinding {
  const method = resourceAssetCatalog(resources)
  const skills = template.skills.map(id => {
    const matches = method.skills.filter(skill => skill.id === id)
    if (matches.length !== 1) {
      throw new DecomposeError('BINDING_FIXED', `child skill ${JSON.stringify(id)} is not fixed by the Method`)
    }
    return matches[0].bundle
  })
  const mcpServers = template.tools.map(id => {
    const matches = method.tools.filter(tool => tool.id === id)
    if (matches.length !== 1) {
      throw new DecomposeError('BINDING_FIXED', `child MCP server ${JSON.stringify(id)} is not fixed by the Method`)
    }
    return matches[0].server.bundle
  })
  return {
    baseTools: (resources.exploration !== undefined && usesExploration({ template, exploration: resources.exploration })
      ? resources.exploration.baseTools : parent.resources.baseTools).map(tool => ({ ...tool })),
    skills,
    mcpServers,
    ...(parent.resources.exploration === undefined ? {} : { exploration: parent.resources.exploration }),
  }
}

/** Counts the parent plus every known descendant Task for the frozen Task cap. */
function subtreeTaskCount(state: TaskRunState, parentTaskId: string): number {
  return [...state.tasks.keys()]
    .filter(taskId => isInSubtree(state, taskId, parentTaskId))
    .length
}

/**
 * Remaining frozen Task budget after every closed Run in the parent subtree and
 * the live parent attempt. Child reservations and actual usage therefore count
 * against the same ancestor cap; unknown usage fails closed.
 */
function taskRemainingTokens(
  state: TaskRunState,
  parentTaskId: string,
  maxTokens: number,
  liveTokens: number,
): number {
  if (!Number.isSafeInteger(liveTokens) || liveTokens < 0) return 0
  const records = [...state.runs.values()]
    .filter(run => isInSubtree(state, run.taskId, parentTaskId) && run.closed?.usage !== undefined)
    .map(run => run.closed?.usage)
    .filter((usage): usage is NonNullable<typeof usage> => usage !== undefined)
  const cost = usageCost(records)
  if (cost.unknown) return 0
  return Math.max(0, maxTokens - cost.tokens - liveTokens)
}

function isInSubtree(state: TaskRunState, taskId: string, ancestorId: string): boolean {
  const seen = new Set<string>()
  let current: string | undefined = taskId
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    current = state.tasks.get(current)?.parentTaskId
  }
  return false
}

function receiptRefsFor(
  children: DecomposeCommit['children'],
  deliveries: readonly PrepareDeliveryView[],
): Ref[] {
  return children.map(child => {
    const match = deliveries
      .filter(delivery => delivery.bindingId === child.bindingId
        && delivery.previewRef.digest === child.ackPreview)
      .sort((left, right) => right.resultSeq - left.resultSeq)
      .at(0)
    if (match === undefined) {
      throw new DecomposeError(
        'PREVIEW_REQUIRED',
        'the original preview delivery is not readable for idempotent replay',
      )
    }
    return match.deliveryReceiptRef
  })
}

function resultFromFact(
  fact: Fact,
  expectedBatchId: string,
  receiptRefs: readonly Ref[],
): DecomposeCommitResult {
  if (fact.type !== 'task/children-admitted' || fact.data.batchId !== expectedBatchId) {
    throw new DecomposeError('IDEMPOTENCY_CONFLICT', 'the original command fact is not a matching child batch')
  }
  const children = fact.data.children.map(child => {
    if (child.contract.origin.kind !== 'child') {
      throw new DecomposeError('IDEMPOTENCY_CONFLICT', 'the original fact contains a non-child contract')
    }
    return {
      taskId: child.contract.taskId,
      bindingId: child.contract.origin.bindingId,
      join: child.join,
    }
  })
  if (receiptRefs.length !== children.length) {
    throw new DecomposeError('IDEMPOTENCY_CONFLICT', 'the original fact child count changed')
  }
  return {
    status: 'admitted',
    parentRunId: fact.data.parentRunId,
    batchId: fact.data.batchId,
    children,
    deliveryReceiptRefs: receiptRefs.map(ref => ({ ...ref })),
    fact,
  }
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}
