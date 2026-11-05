import type { AgentHandle,AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type { Session,SessionEvent,SessionId } from '@deepseek-ai/dsh-session'
import { errorMessage } from '@singularity/protocol'
import type { SessionCut,TaskRunState,UsageRecord } from '@singularity/protocol'
import { throwCollectedErrors } from './errors.ts'
import { readSessionEvents } from './session-events.ts'

import {
assertMcpSurface,
createMcpResourceRoot,
mountMcpServers,
removeMcpResourceRoot,
} from './agent-mcp.ts'
import type { MountedSkillResource } from './agent-skills.ts'
import {
createSkillResourceRoot,
materializeSkills,registerSkills,removeSkillResourceRoot,
} from './agent-skills.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { renderWorkerCard,WORKER_PERSONA } from './prompt.ts'
import type { PlatformPromptRenderer } from './resources.ts'
import {
METHOD_GUIDANCE_ORDER,
METHOD_GUIDANCE_SECTION,
MethodResourceError,
PLATFORM_PROMPT_SERVICE,
assertPlatformPrompt,
usesExploration,
} from './resources.ts'
import type { ExecuteSingleRunRequest,PreparedRun } from './run.ts'
import type { RunToolController } from './tools.ts'
import type { WakeDeliveryOutcome } from './wake.ts'
import type { WakeRequest } from './wake.ts'
import { batchWakeRequest,deliverWakeOnceOrFail,startWakeText } from './wake.ts'

export type OpenedRunMode = 'create' | 'resume'

export interface SessionSnapshot {
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly failure?: string
}

export interface AgentDriveResult {
  readonly snapshot: SessionSnapshot
  readonly agentErrorCode?: string
  readonly agentErrorDetail?: string
  readonly sessionAction: 'created' | 'none' | 'resumed'
  readonly wakeOutcome?: WakeDeliveryOutcome
}

interface DriveAgentOptions {
  readonly prepared: PreparedRun
  readonly request: ExecuteSingleRunRequest
  readonly mode: OpenedRunMode
  readonly wake?: WakeRequest
  readonly controller: RunToolController
  readonly checkBudget: (tokens?: number, steps?: number) => boolean
  readonly stopBudget: () => void
  readonly budget: () => RemainingBudgetPct
  readonly controllerState: () => Promise<TaskRunState>
  readonly renderView: () => string
}

const zeroUsage: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  steps: 0,
  unknownRequests: 0,
}

class ToolSchemaBudgetError extends Error {}

/** Drives only DSH lifecycle and returns observations for Run settlement. */
export async function driveAgent(options: DriveAgentOptions): Promise<AgentDriveResult> {
  const { prepared, request, mode } = options
  const { contract, runtime } = prepared
  let handle: AgentHandle | undefined
  let snapshot = emptySnapshot(request.sessionId)
  let agentErrorCode: string | undefined
  let agentErrorDetail: string | undefined
  const failures: unknown[] = []
  let disposed = false
  let sessionAction: 'created' | 'none' | 'resumed' = 'none'
  let wakeOutcome: WakeDeliveryOutcome | undefined
  let mcpRoot: string | undefined
  let skillRoot: string | undefined
  const budgetExhausted = new DOMException('Run budget exhausted', 'TimeoutError')
  const ownDeadline = AbortSignal.timeout(Math.min(2_147_483_647,
    Math.max(0, prepared.runOpened.data.budgetReservation.deadlineAt - runtime.clock())))
  const deadline = request.signal === undefined ? ownDeadline : AbortSignal.any([ownDeadline, request.signal])
  const cancel = () => handle?.agent.cancel({ kind: 'hook', reason: 'deadline' })
  deadline.addEventListener('abort', cancel, { once: true })

  try {
    if (!options.checkBudget()) throw budgetExhausted
    if (prepared.methodResources.mcpServers.some(server => server.transport === 'stdio')) {
      mcpRoot = await createMcpResourceRoot()
    }
    let skills: readonly MountedSkillResource[] = []
    if (prepared.methodResources.skills.length > 0) {
      skillRoot = await createSkillResourceRoot(prepared.workspace)
      skills = await materializeSkills(prepared.methodResources.skills, skillRoot)
    }
    const setup = buildAgentSetup(options, mcpRoot, skills)
    handle = mode === 'create'
      ? await request.ctx.agents.create({
        sessionId: request.sessionId as SessionId,
        meta: { cwd: prepared.workspace },
        agentOptions: request.agentOptions,
        signal: deadline,
        setup,
      })
      : await request.ctx.agents.resume({
        resumeSessionId: request.sessionId as SessionId,
        agentOptions: request.agentOptions,
        signal: deadline,
        setup,
      })
    sessionAction = mode === 'create' ? 'created' : 'resumed'
    deadline.throwIfAborted()
    if (!options.checkBudget()) throw budgetExhausted
    // Start and batch wakes share the current Task budget projection.
    const state = await options.controllerState()
    const wake = options.wake ?? (mode === 'resume'
      ? batchWakeRequest(state, request.runId, options.budget()) : undefined)
    wakeOutcome = await deliverWakeOnceOrFail(handle.agent, wake ?? {
      wakeId: `${request.runId}:start`,
      text: startWakeText(contract.taskId, request.runId, options.budget()),
    })
    await handle.agent.whenIdle()
    deadline.throwIfAborted()
    const toolFailure = options.controller.snapshot().failure
    if (toolFailure !== undefined) throw toolFailure
  } catch (error) {
    if (error instanceof ToolSchemaBudgetError) {
      agentErrorCode = 'UNSUPPORTED_RESOURCES'
      agentErrorDetail = error.message
    } else if (!deadline.aborted && error !== budgetExhausted) failures.push(error)
    else {
      agentErrorCode = 'budget-exhausted'
      agentErrorDetail = errorMessage(error)
    }
  } finally {
    options.stopBudget()
    deadline.removeEventListener('abort', cancel)
    if (handle !== undefined) {
      try {
        // DSH owns cancellation, scoped jobs, MCP teardown and persistence.
        await handle.dispose()
        disposed = true
      } catch (error) {
        failures.push(error)
      }
      try { snapshot = snapshotSession(handle.agent.session) } catch (error) { failures.push(error) }
    }
    if (mcpRoot !== undefined && (handle === undefined || disposed)) {
      try {
        await removeMcpResourceRoot(mcpRoot)
      } catch (error) {
        failures.push(error)
      }
    }
    if (skillRoot !== undefined && (handle === undefined || disposed)) {
      try {
        await removeSkillResourceRoot(skillRoot)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (snapshot.failure !== undefined && !deadline.aborted && failures.length === 0) failures.push(new Error(snapshot.failure))
  throwCollectedErrors(failures)
  return {
    snapshot,
    ...(agentErrorCode === undefined ? {} : { agentErrorCode }),
    ...(agentErrorDetail === undefined ? {} : { agentErrorDetail }),
    sessionAction,
    ...(wakeOutcome === undefined ? {} : { wakeOutcome }),
  }
}

function buildAgentSetup(
  options: DriveAgentOptions,
  mcpRoot: string | undefined,
  skills: readonly MountedSkillResource[],
): AgentSetup {
  const { prepared, request, controller } = options
  const { runtime } = prepared
  return async (agentCtx, agent) => {
    agentCtx.on('agent/request-error', () => Promise.resolve(undefined), { prepend: true })
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      if (!options.checkBudget(1, 1)) return { kind: 'reject' }
      return next()
    })
    agentCtx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: WORKER_PERSONA,
      interpolate: false,
    })
    agentCtx.systemPrompt.section({
      name: 'singularity:worker-card',
      order: 100,
      text: renderWorkerCard(usesExploration(prepared.methodResources)),
      interpolate: false,
    })
    agentCtx.systemPrompt.section({
      name: METHOD_GUIDANCE_SECTION,
      order: METHOD_GUIDANCE_ORDER,
      text: prepared.methodResources.guidanceText,
      interpolate: false,
    })
    await registerSkills(agentCtx, skills)
    if (prepared.methodResources.mcpServers.length > 0) {
      await mountMcpServers(agentCtx, prepared.methodResources.mcpServers, mcpRoot)
    }
    agentCtx.systemPrompt.context({
      name: 'singularity:node-view',
      order: 300,
      required: true,
      interpolate: false,
      text: options.renderView,
    })
    const renderer: unknown = request.ctx.get(PLATFORM_PROMPT_SERVICE, false)
    if (!isPlatformPromptRenderer(renderer)) {
      throw new MethodResourceError(
        'composition',
        'COMPOSITION_MISMATCH',
        'host did not provide the scoped platform prompt renderer',
      )
    }
    assertPlatformPrompt(
      await renderer.render(agentCtx, agent),
      request.composition.platformPrompt,
    )
    controller.register(agentCtx, agent)
    const globalNames = request.ctx.tools.definitions().map(definition => definition.name)
    const allow = [...runtime.baseToolNames]
    if (prepared.methodResources.skills.length > 0 && !allow.includes('skill')) allow.push('skill')
    if (allow.length > 0) {
      agentCtx.tools.restrict({ allow })
    } else if (globalNames.length > 0) {
      agentCtx.tools.restrict({ deny: globalNames })
    }
    assertMcpSurface(agentCtx, agent, prepared.methodResources.mcpServers)
    const schemaBytes = new TextEncoder().encode(JSON.stringify(agentCtx.tools.schemas(agent))).byteLength
    if (schemaBytes > 12 * 1024) throw new ToolSchemaBudgetError(
      `visible tool schemas is ${String(schemaBytes)} bytes, above the 12288 byte budget`)
  }
}

export function snapshotSession(session: Session, pendingUnknown = true): SessionSnapshot {
  const events = readSessionEvents(session)
  return snapshotSessionEvents(String(session.id), events, pendingUnknown)
}

/** Same usage/cut projection for live and persisted DSH session observations. */
export function snapshotSessionEvents(sessionId: string, events: readonly SessionEvent[], pendingUnknown = true): SessionSnapshot {
  let inputTokens = 0
  let outputTokens = 0
  let steps = 0
  let unknownRequests = 0
  let failure: string | undefined
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') failure = event.data.reason.error.message
    if (event.type === 'step/start') pending.add(`${String(event.data.turn)}:${String(event.data.step)}`)
    const compaction = event.type === 'compaction/summary' && event.data.llmStreamCall === true
    if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message' && !compaction) continue
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      pending.delete(`${String(event.data.turn)}:${String(event.data.step)}`)
    }
    steps += 1
    const usage = event.type === 'assistant/message' || event.type === 'compaction/summary' ? event.data.usage : undefined
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
      unknownRequests: unknownRequests + (pendingUnknown ? pending.size : 0),
    },
    sessionCut: {
      sessionId,
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

function isPlatformPromptRenderer(value: unknown): value is PlatformPromptRenderer {
  return typeof value === 'object'
    && value !== null
    && 'render' in value
    && typeof (value as { readonly render?: unknown }).render === 'function'
}
