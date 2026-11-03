import type { Session } from '@deepseek-ai/dsh-session'
import type { Fact,JsonValue,Ref,UsageRecord } from '@singularity/protocol'

import { snapshotSession } from './agent.ts'
import { loadDirectChildren,loadRunResult,mountRunOutputs,readChildData } from './children.ts'
import { activeChildBatch,commitDecomposeBatch } from './decompose-commit.ts'
import { initialContextEpoch } from './epoch.ts'
import { DecomposeError } from './errors.ts'
import { readGlobalResource } from './global-resources.ts'
import { mcpDispatchPlan } from './mcp-resources.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { clampPercent } from './prompt.ts'
import { usesExploration } from './resources.ts'
import { closedSubtreeUsage,commitFact,usageCost } from './run-settlement.ts'
import type { ExecuteSingleRunRequest,PreparedRun,RuntimeContext } from './run.ts'
import type { CommandService } from './service.ts'
import { loadDirectFeedback,readDirectFeedback } from './task-feedback.ts'
import { RunToolController } from './tools.ts'
import type { FrozenSubmission } from './workspace.ts'

const zeroUsage: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  steps: 0,
  unknownRequests: 0,
}

export async function createToolController(
  prepared: PreparedRun,
  request: ExecuteSingleRunRequest,
  service: CommandService,
) {
  const { runtime, runOpened } = prepared
  let state = await service.taskRunState(runtime.transientInvalidReasons)
  let children = await loadDirectChildren(service, state, runtime.contract.taskId, request.runId, prepared.methodResources.template)
  const previous = await loadRunResult(service, state.runs.get(runtime.lastAttempt?.runId ?? ''),
    runtime.lastAttempt?.outputsPath ?? '')
  await mountRunOutputs(service, runtime.workspace, [...children.results.flatMap(result => result.outputs), ...previous.outputs], prepared.mountedChildOutputs)
  const authorizedInputs = () => [...runtime.contract.spec.inputs, ...children.inputs, ...previous.outputs]
  const feedbackCount = (await loadDirectFeedback({ state, parentTaskId: runtime.contract.taskId, reader: service })).length
  const prior = closedSubtreeUsage(state, runtime.contract.taskId)
  const taskStartedAt = service.facts().find(fact => fact.type === 'run/opened'
    && fact.data.taskId === runtime.contract.taskId)?.at ?? runtime.startedAt
  const reservation = runOpened.data.budgetReservation
  const limits = {
    ...runtime.contract.limits,
    maxTokens: Math.min(reservation.tokens, runtime.contract.limits.maxTokens - prior.tokens),
    maxStepsPerRun: Math.min(reservation.steps, runtime.contract.limits.maxStepsPerRun),
    deadlineAt: Math.min(reservation.deadlineAt, runtime.contract.limits.deadlineAt),
  }
  let liveAgent: { readonly session: Session } | undefined
  let active = true
  const workerUsage = () => liveAgent === undefined ? zeroUsage : snapshotSession(liveAgent.session, false).usage
  const currentUsage = () => {
    const summary = request.summaries?.reportedUsage(request.runId)
    return { ...workerUsage(), ...(summary === undefined ? {} : { summary }) }
  }
  const checkBudget = (tokens = 0, steps = 0): boolean => {
    if (!active || request.signal?.aborted === true) return false
    if (request.checkReportedBudget?.() === false) {
      request.onBudgetExhausted?.()
      return false
    }
    const now = runtime.clock()
    if (now >= limits.deadlineAt) {
      request.onBudgetExhausted?.()
      return false
    }
    const usage = currentUsage()
    const cost = usageCost([usage])
    if (cost.tokens + tokens > limits.maxTokens) {
      request.onBudgetExhausted?.()
      return false
    }
    return usage.steps + steps <= limits.maxStepsPerRun
  }
  const budget = (): RemainingBudgetPct => {
    const usage = currentUsage()
    const cost = usageCost([usage])
    const closed = closedSubtreeUsage(state, runtime.contract.taskId)
    const subtree = [runtime.contract.taskId]
    for (const taskId of subtree) subtree.push(...(state.tasks.get(taskId)?.childIds ?? []))
    const task = state.tasks.get(runtime.contract.taskId)
    const rootDepth = state.tasks.get(task?.rootTaskId ?? '')?.contract.limits.maxDepth ?? limits.maxDepth
    return {
      tokensPct: clampPercent(
        Math.min(reservation.tokens, runtime.contract.limits.maxTokens - closed.tokens) - cost.tokens, runtime.contract.limits.maxTokens),
      stepsPct: clampPercent(limits.maxStepsPerRun - usage.steps, limits.maxStepsPerRun),
      wallClockPct: clampPercent(limits.deadlineAt - runtime.clock(), limits.deadlineAt - taskStartedAt),
      depthPct: clampPercent(limits.maxDepth, rootDepth),
      taskSlotsPct: clampPercent(limits.maxTasks - subtree.length, limits.maxTasks),
    }
  }
  request.summaries?.registerRun({ contract: runtime.contract, runId: request.runId, workspace: runtime.workspace,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    checkBudget: (extraTokens = 0) => {
      const cost = usageCost([workerUsage()])
      return runtime.clock() < limits.deadlineAt
        && cost.tokens + extraTokens < limits.maxTokens && request.checkReportedBudget?.() !== false
    },
  })
  const controller: RunToolController = new RunToolController({
    contract: runtime.contract,
    runId: request.runId,
    sessionId: request.sessionId,
    workspace: runtime.workspace,
    childBatchActive: activeChildBatch(state, request.runId) !== undefined,
    submitDenial: () => children.submitDenial,
    requiredFailure: () => children.requiredFailure,
    verifierInputs: authorizedInputs().map(input => input.object),
    readTask: async query => query.kind === 'ancestor' && request.summaries !== undefined
      ? request.summaries.readAncestor(await service.taskRunState(runtime.transientInvalidReasons), runtime.contract.taskId, query, runtime.clock())
      : query.kind === 'feedback'
      ? readDirectFeedback({ state: await service.taskRunState(runtime.transientInvalidReasons),
        parentTaskId: runtime.contract.taskId, reader: service,
        ...(query.id === undefined ? {} : { id: query.id }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.page === undefined ? {} : { page: query.page }),
      })
      : (query.kind === 'resource' && usesExploration(prepared.methodResources) && prepared.methodResources.exploration !== undefined
        ? await readGlobalResource(service, prepared.methodResources.exploration, query) : undefined)
        ?? await readChildData(service, children, runtime.contract.spec.inputs, query, previous),
    skillNames: prepared.methodResources.skills.map(skill => skill.name),
    mcpPlan: mcpDispatchPlan(prepared.methodResources.mcpServers),
    childBindingIds: prepared.methodResources.template.children.map(binding => binding.bindingId),
    decompose: {
      methodResources: prepared.methodResources,
      reader: service,
    },
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
      await commitRunSubmitted(service, runtime, request, frozen, sessionId, transcriptSeq, current.planningSketchRef, current.feedbackRefs ?? [])
      return frozen.manifestRef
    },
    commitChildBatch: async (args, callId) => {
      if (!checkBudget()) throw new Error('Run budget unavailable')
      const current = controller.snapshot()
      if (current.planningSketchRef === undefined) {
        throw new DecomposeError('INVALID_ARGUMENT', 'planning sketch is missing at child batch commit')
      }
      if (liveAgent === undefined) {
        throw new DecomposeError('INVALID_ARGUMENT', 'live Agent is missing at child batch commit')
      }
      const live = usageCost([currentUsage()])
      const result = await commitDecomposeBatch({
        contract: runtime.contract,
        parentRunId: request.runId,
        sessionId: request.sessionId,
        resources: prepared.methodResources,
        service,
        session: liveAgent.session,
        callId,
        planningSketchRef: current.planningSketchRef,
        actor: runtime.actor,
        transientInvalidReasons: runtime.transientInvalidReasons,
        liveTokens: live.tokens,
        args,
        authorizedInputs: authorizedInputs(),
      })
      state = await service.taskRunState(runtime.transientInvalidReasons)
      children = await loadDirectChildren(service, state,
        runtime.contract.taskId, request.runId, prepared.methodResources.template)
      return result
    },
  })
  return { controller, children: () => children, feedback: { count: feedbackCount, ...(feedbackCount > 0 ? { cursor: `feedback:${runtime.contract.taskId}:0` } : {}) }, budget, checkBudget, stopBudget: () => { active = false } }
}

async function commitRunSubmitted(
  service: CommandService,
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  frozen: FrozenSubmission,
  sessionId: string,
  transcriptSeq: number,
  planningSketchRef: Ref,
  feedbackRefs: readonly Ref[],
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
      feedbackRefs: [...feedbackRefs],
    },
    runtime.transientInvalidReasons,
  )
}
