import { realpath } from 'node:fs/promises'

import type { AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionCut, UsageRecord } from '@singularity/protocol'

import { SingleRunError } from './errors.ts'
import {
  assertMcpSurface,
  createMcpResourceRoot,
  mountMcpServers,
  removeMcpResourceRoot,
} from './agent-mcp.ts'
import { assertSkillDiscovery, assertSkillToolAvailability, registerSkills } from './agent-skills.ts'
import type { RemainingBudgetPct } from './prompt.ts'
import { assertPromptBudget, renderWorkerCard } from './prompt.ts'
import {
  METHOD_GUIDANCE_ORDER,
  METHOD_GUIDANCE_SECTION,
  MethodResourceError,
  PLATFORM_PROMPT_SERVICE,
  assertPlatformPrompt,
} from './resources.ts'
import type { PlatformPromptRenderer } from './resources.ts'
import type { CommandService } from './service.ts'
import type { RunToolController } from './tools.ts'
import type { ExecuteSingleRunRequest, PreparedRun } from './run.ts'
import { AGENT_ERROR_REASON, WAKE_REFUSED_REASON } from './verification.ts'
import { WakeDeliveryRefusedError, deliverWakeOnceOrFail, startWakeText } from './wake.ts'
import type { WakeDeliveryOutcome } from './wake.ts'
import { prepareWorkspace } from './workspace.ts'

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
  readonly drainPending: boolean
  readonly sessionAction: 'created' | 'none' | 'resumed'
  readonly wakeOutcome?: WakeDeliveryOutcome
}

interface DriveAgentOptions {
  readonly prepared: PreparedRun
  readonly request: ExecuteSingleRunRequest
  readonly service: CommandService
  readonly mode: OpenedRunMode
  readonly controller: RunToolController
  readonly budget: () => RemainingBudgetPct
  readonly checkBudget: (tokens?: number, steps?: number) => boolean
  readonly stopBudget: () => void
  readonly startBudget: RemainingBudgetPct
  readonly renderView: () => string
}

const zeroUsage: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  steps: 0,
  unknownRequests: 0,
}

/** Drives only DSH lifecycle and returns observations for Run settlement. */
export async function driveAgent(options: DriveAgentOptions): Promise<AgentDriveResult> {
  const { prepared, request, service, mode } = options
  const { contract, runtime } = prepared
  let handle: AgentHandle | undefined
  let snapshot = emptySnapshot(request.sessionId)
  let agentErrorCode: string | undefined
  let agentErrorDetail: string | undefined
  let drainPending = false
  let sessionAction: 'created' | 'none' | 'resumed' = 'none'
  let wakeOutcome: WakeDeliveryOutcome | undefined
  let mcpRoot: string | undefined
  let rootCleanup: Promise<void> | undefined
  let lateAcquisition: Promise<void> | undefined
  const remaining = () => prepared.runOpened.data.budgetReservation.deadlineAt - runtime.clock()
  const initialRemaining = remaining()
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647,
    Math.max(0, Number.isSafeInteger(initialRemaining) ? initialRemaining : 0)))
  const cancel = () => handle?.agent.cancel({ kind: 'hook', reason: 'deadline' })
  deadline.addEventListener('abort', cancel, { once: true })
  const jobDrain = watchJobTeardown(request.ctx, request.sessionId)
  const cleanupMcpRoot = (): Promise<void> => {
    if (mcpRoot === undefined) return Promise.resolve()
    rootCleanup ??= removeMcpResourceRoot(mcpRoot)
    return rootCleanup
  }
  const cleanupMcpRootWithError = async (label: string): Promise<void> => {
    try {
      await cleanupMcpRoot()
    } catch (error) {
      drainPending = true
      agentErrorCode ??= AGENT_ERROR_REASON
      agentErrorDetail = `${label}: ${errorMessage(error)}`
    }
  }

  try {
    if (!options.checkBudget()) throw new Error('Run budget unavailable')
    if (prepared.methodResources.mcpServers.length > 0) {
      mcpRoot = await createMcpResourceRoot()
    }
    const setupState = { started: false }
    let resolveSetup: () => void = () => {}
    const setupDone = new Promise<void>(resolve => {
      resolveSetup = resolve
    })
    const setup: AgentSetup = async (agentCtx, agent) => {
      setupState.started = true
      try {
        await buildAgentSetup(options, mcpRoot)(agentCtx, agent)
      } finally {
        resolveSetup()
      }
    }
    const acquiring = mode === 'create'
      ? request.ctx.agents.create({
        sessionId: request.sessionId as SessionId,
        meta: { cwd: prepared.workspace },
        agentOptions: request.agentOptions,
        signal: deadline,
        setup,
      }).then(handle => ({ handle, action: 'created' as const }))
      : resumeOrCreateAgent(request, prepared.workspace, setup, service, deadline)
    try {
      const acquired = await waitWithin(acquiring, remaining())
      handle = acquired.handle
      sessionAction = acquired.action
    } catch (error) {
      drainPending = error instanceof DOMException && error.name === 'TimeoutError'
      lateAcquisition = (async () => {
        let acquired: { readonly handle: AgentHandle } | undefined
        try {
          acquired = await acquiring
        } catch {
          acquired = undefined
        }
        if (setupState.started) await setupDone
        if (acquired !== undefined) {
          await acquired.handle.dispose()
        }
        await cleanupMcpRoot()
      })()
      void lateAcquisition.catch(() => undefined)
      throw error
    }
    deadline.throwIfAborted()
    if (!options.checkBudget()) throw new Error('Run budget unavailable')
    // The start wake text is derived from the frozen run/opened boundary, not
    // from the live clock: resuming must reproduce the same stable message body.
    wakeOutcome = await deliverWakeOnceOrFail(handle.agent, {
      wakeId: `${request.runId}:start`,
      text: startWakeText(contract.taskId, request.runId, options.startBudget),
    })
    await waitWithin(handle.agent.whenIdle(), remaining())
  } catch (error) {
    agentErrorCode = error instanceof WakeDeliveryRefusedError
      ? WAKE_REFUSED_REASON
      : error instanceof MethodResourceError ? error.code : AGENT_ERROR_REASON
    agentErrorDetail = errorMessage(error)
  } finally {
    options.stopBudget()
    deadline.removeEventListener('abort', cancel)
    try {
      if (handle !== undefined) {
        snapshot = snapshotSession(handle.agent.session)
        const disposing = handle.dispose()
        try {
          // Native dispose cancels, drains scoped jobs, and closes persistence.
          // Cleanup has a host-only grace period; no new work is admitted.
          await waitWithin(disposing, 5_000)
          await cleanupMcpRootWithError('MCP resource cleanup failed')
        } catch (error) {
          drainPending = true
          agentErrorCode = AGENT_ERROR_REASON
          agentErrorDetail = `dispose failed: ${errorMessage(error)}; MCP resource root retained until late disposal`
          void disposing.then(async () => {
            await cleanupMcpRootWithError('late MCP resource cleanup failed')
          }, () => undefined)
        }
        try {
          snapshot = snapshotSession(handle.agent.session)
        } catch {
          // Preserve the pre-dispose cut if the Session is already detached.
        }
      } else {
        const live = request.ctx.sessions.get(request.sessionId as SessionId)
        if (live !== undefined) snapshot = snapshotSession(live)
        if (mcpRoot !== undefined) {
          if (lateAcquisition === undefined) {
            await cleanupMcpRootWithError('MCP resource cleanup failed')
          } else {
            try {
              await waitWithin(lateAcquisition, 5_000)
            } catch (error) {
              drainPending = true
              agentErrorCode ??= AGENT_ERROR_REASON
              agentErrorDetail = `MCP resource root quarantined: late acquisition or cleanup did not settle: ${errorMessage(error)}`
            }
          }
        }
      }
      const orphanedJobId = jobDrain.failedJobId()
      if (orphanedJobId !== undefined) {
        drainPending = true
        if (agentErrorCode === undefined && snapshot.failure === undefined) {
          agentErrorCode = AGENT_ERROR_REASON
          agentErrorDetail = `owned job ${orphanedJobId} may be orphaned after teardown`
        }
      }
    } finally {
      jobDrain.dispose()
    }
  }
  return {
    snapshot,
    ...(agentErrorCode === undefined ? {} : { agentErrorCode }),
    ...(agentErrorDetail === undefined ? {} : { agentErrorDetail }),
    drainPending,
    sessionAction,
    ...(wakeOutcome === undefined ? {} : { wakeOutcome }),
  }
}

/** Host wait bound; DSH retains ownership of the pending operation. */
async function waitWithin<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([new Promise<never>((_resolve, reject) => {
      const expire = () => { reject(new DOMException('Run lifecycle deadline', 'TimeoutError')) }
      if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) expire()
      else timer = setTimeout(expire, Math.min(2_147_483_647, milliseconds))
    }), pending])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Observes the native signal left when DSH force-fails a job during teardown. */
function watchJobTeardown(
  ctx: Context,
  sessionId: string,
): { readonly failedJobId: () => string | undefined; readonly dispose: () => void } {
  const jobs = ctx.get('jobs', false)
  if (jobs === undefined) return { failedJobId: () => undefined, dispose: () => {} }
  let failedJobId: string | undefined
  const unsubscribe = jobs.events.subscribe({ owner: sessionId as SessionId }, event => {
    if (event.type === 'settled' && event.cause === 'teardown' && event.job.status === 'failed') {
      failedJobId ??= String(event.job.id)
    }
  })
  return { failedJobId: () => failedJobId, dispose: unsubscribe }
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
  signal.throwIfAborted()
  await prepareWorkspace(workspace, request.admission.contract.spec.inputs, service)
  signal.throwIfAborted()
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

function buildAgentSetup(options: DriveAgentOptions, mcpRoot: string | undefined): AgentSetup {
  const { prepared, request, controller } = options
  const { runtime } = prepared
  return async (agentCtx, agent) => {
    agentCtx.on('agent/request-error', () => Promise.resolve(undefined), { prepend: true })
    agentCtx.on('agent/pre-step', async ({ modelSelection, signal }, next) => {
      if (!options.checkBudget(0, 1)) return { kind: 'reject' }
      const info = await agentCtx.llm.resolveModelInfo(modelSelection.provider, modelSelection.model, signal)
      // Reserve the route's complete input + output capacity; estimates are not hard bounds.
      const capacity = info.context?.contextWindow
      if (!Number.isSafeInteger(capacity) || capacity === undefined || capacity <= 0
        || !options.checkBudget(capacity, 1)) return { kind: 'reject' }
      return next()
    })
    agentCtx.systemPrompt.section({
      name: 'singularity:worker-card',
      order: 100,
      text: renderWorkerCard(false),
      interpolate: false,
    })
    agentCtx.systemPrompt.section({
      name: METHOD_GUIDANCE_SECTION,
      order: METHOD_GUIDANCE_ORDER,
      text: prepared.methodResources.guidanceText,
      interpolate: false,
    })
    await registerSkills(agentCtx, prepared.methodResources.skills)
    if (prepared.methodResources.mcpServers.length > 0) {
      if (mcpRoot === undefined) {
        throw new MethodResourceError(
          'method',
          'UNSUPPORTED_RESOURCES',
          'host did not create the MCP resource root required by Method server bindings',
        )
      }
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
    assertSkillToolAvailability(globalNames, prepared.methodResources.skills)
    if (prepared.methodResources.skills.length > 0 && !allow.includes('skill')) allow.push('skill')
    if (allow.length > 0) {
      agentCtx.tools.restrict({ allow })
    } else if (globalNames.length > 0) {
      agentCtx.tools.restrict({ deny: globalNames })
    }
    assertMcpSurface(agentCtx, agent, prepared.methodResources.mcpServers)
    await assertSkillDiscovery(agentCtx, agent, prepared.methodResources.skills, prepared.workspace)
    assertPromptBudget(JSON.stringify(agentCtx.tools.schemas(agent)), 12 * 1024, 'visible tool schemas')
  }
}

export function snapshotSession(session: Session): SessionSnapshot {
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

function isPlatformPromptRenderer(value: unknown): value is PlatformPromptRenderer {
  return typeof value === 'object'
    && value !== null
    && 'render' in value
    && typeof (value as { readonly render?: unknown }).render === 'function'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
