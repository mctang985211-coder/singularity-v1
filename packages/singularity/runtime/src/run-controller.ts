import type { Session } from '@deepseek-ai/dsh-session'
import type { Fact,JsonValue,Ref,TaskContract,UsageRecord } from '@singularity/protocol'

import { snapshotSession } from './agent.ts'
import { loadDirectChildren,mountDirectOutputs,readChildData } from './children.ts'
import { activeChildBatch,commitDecomposeBatch } from './decompose-commit.ts'
import { initialContextEpoch } from './epoch.ts'
import { DecomposeError } from './errors.ts'
import { readGlobalResource } from './global-resources.ts'
import { mcpDispatchPlan } from './mcp-resources.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { clampPercent } from './prompt.ts'
import { usesExploration } from './resources.ts'
import { commitFact,usageCost } from './run-settlement.ts'
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
  const state = await service.taskRunState(runtime.transientInvalidReasons)
  let children = await loadDirectChildren(service, state, runtime.contract.taskId, request.runId, prepared.methodResources.template)
  await mountDirectOutputs(service, runtime.workspace, children, prepared.mountedChildOutputs)
  const subtree = new Set<string>()
  const pending = [runtime.contract.taskId]
  for (const taskId of pending) {
    subtree.add(taskId)
    pending.push(...(state.tasks.get(taskId)?.childIds ?? []))
  }
  const feedbackCount = (await loadDirectFeedback({ state, parentTaskId: runtime.contract.taskId, reader: service })).length
  const prior = usageCost([...state.runs.values()]
    .flatMap(run => subtree.has(run.taskId) && run.closed?.usage !== undefined ? [run.closed.usage] : []))
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
    if (prior.unknown || cost.unknown || cost.tokens + tokens > limits.maxTokens) {
      request.onBudgetExhausted?.()
      return false
    }
    return usage.steps + steps <= limits.maxStepsPerRun
  }
  const budget = () => computeBudget(limits, currentUsage(), runtime.startedAt, runtime.clock(), prior.unknown,
    Math.min(reservation.tokens, runtime.contract.limits.maxTokens))
  request.summaries?.registerRun({ contract: runtime.contract, runId: request.runId, workspace: runtime.workspace,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    checkBudget: (extraTokens = 0) => {
      const cost = usageCost([workerUsage()])
      return !prior.unknown && !cost.unknown && runtime.clock() < limits.deadlineAt
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
    verifierInputs: [...runtime.contract.spec.inputs.map(input => input.object), ...children.inputs.map(input => input.object)],
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
        ?? await readChildData(service, children, runtime.contract.spec.inputs, query),
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
      if (live.unknown || prior.unknown) {
        throw new DecomposeError('LIMIT_EXCEEDED', 'live usage is unknown at child batch commit')
      }
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
        authorizedInputs: [...runtime.contract.spec.inputs, ...children.inputs.map(input => ({ id: input.id, path: input.path, object: input.object, access: input.access }))],
      })
      children = await loadDirectChildren(service, await service.taskRunState(runtime.transientInvalidReasons),
        runtime.contract.taskId, request.runId, prepared.methodResources.template)
      return result
    },
  })
  return { controller, children: () => children, feedback: { count: feedbackCount, ...(feedbackCount > 0 ? { cursor: `feedback:${runtime.contract.taskId}:0` } : {}) }, budget, checkBudget, stopBudget: () => { active = false },
    startBudget: computeBudget({ ...runtime.contract.limits, maxTokens: reservation.tokens },
      zeroUsage, runtime.startedAt, runtime.startedAt) }
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

function computeBudget(
  limits: TaskContract['limits'],
  usage: UsageRecord,
  startedAt: number,
  now: number,
  priorUnknown = false,
  totalTokens = limits.maxTokens,
): RemainingBudgetPct {
  const cost = usageCost([usage])
  const tokensPct = priorUnknown || cost.unknown ? null : clampPercent(limits.maxTokens - cost.tokens, totalTokens)
  const stepsPct = clampPercent(limits.maxStepsPerRun - usage.steps, limits.maxStepsPerRun)
  const wallClockPct = limits.deadlineAt <= startedAt
    ? 0
    : clampPercent(limits.deadlineAt - now, limits.deadlineAt - startedAt)
  const depthPct = limits.maxDepth <= 0 ? 100 : clampPercent(limits.maxDepth, limits.maxDepth)
  const taskSlotsPct = limits.maxTasks <= 0 ? 0 : clampPercent(limits.maxTasks - 1, limits.maxTasks)
  return { tokensPct, stepsPct, wallClockPct, depthPct, taskSlotsPct }
}
