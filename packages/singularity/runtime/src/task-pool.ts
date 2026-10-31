import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { BudgetReservation,TaskContract,UsageRecord } from '@singularity/protocol'
import { computeDigest } from '@singularity/protocol'

import { snapshotSession } from './agent.ts'
import { closeInterruptedSubtree } from './cancellation.ts'
import { DecomposeError,SingleRunError } from './errors.ts'
import { retrySingleRun } from './retry.ts'
import { usageCost } from './run-settlement.ts'
import type { ExecuteSingleRunRequest,ExecuteSingleRunResult,InterruptedRunResult,RunAttemptResult } from './run.ts'
import { continueYieldedRun,executeSingleRun } from './run.ts'
import { CommandService } from './service.ts'

export interface ResolveTaskRunInput {
  readonly contract: TaskContract
  readonly runId: string
  readonly sessionId: string
  readonly workspace: string
  readonly attempt: number
  readonly service: CommandService
}

/** The app composes every child using the same profile and composition factory. */
export interface ExecuteTaskTreeRequest extends ExecuteSingleRunRequest {
  readonly maxActive: number
  readonly workspaceRoot: string
  readonly resolveRun: (input: ResolveTaskRunInput) => Promise<Pick<ExecuteSingleRunRequest,
    'composition' | 'agentOptions' | 'verifier' | 'maxOutputBytes'>>
}

export interface ExecuteTaskTreeResult {
  readonly root: ExecuteSingleRunResult
  readonly runs: readonly ExecuteSingleRunResult[]
  readonly facts: ExecuteSingleRunResult['facts']
}

interface ReadyRun {
  readonly request: ExecuteSingleRunRequest
  readonly action: 'create' | 'resume' | 'retry'
  readonly previousRunId?: string
}

/**
 * Capacity only: each dispatched Run uses the shared Run driver and fresh business retry. A
 * yielded parent holds no slot; its latest batch must be wholly terminal before
 * it is requeued. Workflow and direct-child choices remain with each worker.
 */
export async function executeTaskTree(
  request: ExecuteTaskTreeRequest,
  sharedWriter?: CommandService,
): Promise<ExecuteTaskTreeResult> {
  request = { ...request, transientInvalidReasons: sharedWriter?.retryPolicy(request.transientInvalidReasons) ?? request.transientInvalidReasons ?? [] }
  if (!Number.isSafeInteger(request.maxActive) || request.maxActive < 1) {
    throw new SingleRunError('INVALID_ARGUMENT', 'maxActive must be a positive safe integer')
  }
  const actor = request.actor ?? { kind: 'runtime', id: 'singularity-runtime' }
  const clock = request.clock ?? Date.now
  const service = sharedWriter ?? await CommandService.open({ root: request.journalRoot, actor, clock, transientInvalidReasons: request.transientInvalidReasons })
  const ready: ReadyRun[] = []
  const waiting = new Map<string, ReadyRun>()
  const requests = new Map<string, ExecuteSingleRunRequest>()
  const reported = new Map<string, UsageRecord>()
  const running = new Map<string, Promise<{ readonly job: ReadyRun; readonly result?: RunAttemptResult; readonly error?: unknown }>>()
  const settled: ExecuteSingleRunResult[] = []
  const interrupted: InterruptedRunResult[] = []
  const rootTaskId = request.admission.contract.taskId
  const cancellation = new AbortController()
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647,
    Math.max(0, request.admission.contract.limits.deadlineAt - clock())))
  const signal = AbortSignal.any([cancellation.signal, deadline, ...(request.signal === undefined ? [] : [request.signal])])

  const withinBudget = (contract: TaskContract): boolean => {
    const contracts = new Map([[rootTaskId, request.admission.contract]])
    const taskByRun = new Map([...requests].map(([runId, runRequest]) => [runId, runRequest.admission.contract.taskId]))
    for (const fact of service.facts()) {
      if (fact.type === 'task/children-admitted') {
        for (const child of fact.data.children) contracts.set(child.contract.taskId, child.contract)
      }
      if (fact.type === 'run/opened') taskByRun.set(fact.data.runId, fact.data.taskId)
    }
    const usage = new Map(reported)
    for (const [runId, runRequest] of requests) {
      const session = request.ctx.sessions.get(runRequest.sessionId as SessionId)
      if (session !== undefined) usage.set(runId, snapshotSession(session, false).usage)
    }
    for (const [runId, record] of usage) {
      const summary = request.summaries?.reportedUsage(runId)
      if (summary !== undefined) usage.set(runId, { ...record, summary })
    }
    for (const fact of service.facts()) {
      if (fact.type === 'run/closed') usage.set(fact.data.runId, fact.data.usage)
    }
    const isBelow = (taskId: string, ancestor: string): boolean => {
      let current = contracts.get(taskId)
      while (current !== undefined) {
        if (current.taskId === ancestor) return true
        current = current.origin.kind === 'child' ? contracts.get(current.origin.parentId) : undefined
      }
      return false
    }
    let ancestor: TaskContract | undefined = contract
    while (ancestor !== undefined) {
      const owner: TaskContract = ancestor
      const records = [...usage].flatMap(([runId, record]) => {
        const taskId = taskByRun.get(runId)
        return taskId !== undefined && isBelow(taskId, owner.taskId) ? [record] : []
      })
      const cost = usageCost(records)
      if (cost.unknown || cost.tokens >= owner.limits.maxTokens || clock() >= owner.limits.deadlineAt) return false
      ancestor = owner.origin.kind === 'child' ? contracts.get(owner.origin.parentId) : undefined
    }
    const rootUsage = [...usage].flatMap(([runId, record]) => {
      const taskId = taskByRun.get(runId)
      return taskId !== undefined && isBelow(taskId, rootTaskId) ? [record] : []
    })
    return request.checkReportedBudget?.(usageCost(rootUsage)) ?? true
  }

  const enqueue = (runRequest: ExecuteSingleRunRequest, action: ReadyRun['action'], previousRunId?: string) => {
    const scoped = { ...runRequest, signal,
      onBudgetExhausted: () => {
        if (!withinBudget(request.admission.contract)) cancellation.abort('budget-exhausted')
      },
      checkReportedBudget: () => !signal.aborted && withinBudget(runRequest.admission.contract) }
    requests.set(scoped.runId, scoped)
    ready.push({ request: scoped, action, ...(previousRunId === undefined ? {} : { previousRunId }) })
  }
  const newAttempt = async (contract: TaskContract, attempt: number, reservation: BudgetReservation,
    previous?: ExecuteSingleRunRequest): Promise<ExecuteSingleRunRequest> => {
    const runId = `${contract.taskId}:run:${String(attempt)}`
    const sessionId = `${runId}:session`
    const key = computeDigest('object', { runId }).slice('sha256:'.length)
    const workspace = join(request.workspaceRoot, key)
    const composition = previous === undefined
      ? await request.resolveRun({ contract, runId, sessionId, workspace, attempt, service })
      : { composition: previous.composition, agentOptions: previous.agentOptions,
        verifier: previous.verifier, maxOutputBytes: previous.maxOutputBytes }
    return {
      ctx: request.ctx, journalRoot: request.journalRoot, workspace, runId, sessionId,
      admission: { contract, attempt, budgetReservation: reservation },
      ...composition, actor, clock,
      ...(request.summaries === undefined ? {} : { summaries: request.summaries }),
      ...(request.canOpenRun === undefined ? {} : { canOpenRun: request.canOpenRun }),
      ...(request.transientInvalidReasons === undefined ? {} : { transientInvalidReasons: request.transientInvalidReasons }),
    }
  }
  const dispatch = async (job: ReadyRun): Promise<RunAttemptResult> => {
    const run = job.request
    if (job.action === 'resume') return continueYieldedRun(service, run.runId)
    if (job.action === 'retry') {
      return retrySingleRun({ ...run, previousRunId: job.previousRunId as string }, service)
    }
    await mkdir(run.workspace, { recursive: true })
    return executeSingleRun(run, service)
  }

  try {
    enqueue(request, 'create')
    while (ready.length > 0 || running.size > 0) {
      while (!signal.aborted && ready.length > 0 && running.size < request.maxActive) {
        const job = ready.shift()
        if (job === undefined) break
        running.set(job.request.runId, dispatch(job).then(result => ({ job, result }), (error: unknown) => ({ job, error })))
      }
      if (running.size === 0) break
      const { job, result, error } = await Promise.race(running.values())
      running.delete(job.request.runId)
      if (error !== undefined) {
        if (error instanceof DecomposeError && error.code === 'LIMIT_EXCEEDED') {
          cancellation.abort('evaluation-run-budget-exhausted')
          continue
        }
        throw error instanceof Error ? error : new Error('Run dispatch failed', { cause: error })
      }
      if (result === undefined) throw new Error('Run returned no observation')
      reported.set(result.runId, result.usage)
      if (result.kind === 'interrupted') {
        interrupted.push(result)
        continue
      }
      if (result.kind === 'yielded') {
        waiting.set(result.runId, job)
        if (signal.aborted) continue
        const batch = service.facts().find(fact => fact.type === 'task/children-admitted'
          && fact.data.parentRunId === result.runId && fact.data.batchId === result.batchId)
        if (batch?.type !== 'task/children-admitted') throw new Error('yielded batch is missing from the journal')
        for (const child of batch.data.children) {
          enqueue(await newAttempt(child.contract, 1, child.budgetReservation), 'create')
        }
      } else {
        settled.push(result)
        if (result.retry.allowed && !signal.aborted) {
          enqueue(await newAttempt(job.request.admission.contract, job.request.admission.attempt + 1,
            job.request.admission.budgetReservation, job.request), 'retry', result.runId)
        }
      }
      if (signal.aborted) continue
      const state = await service.taskRunState(request.transientInvalidReasons ?? [])
      for (const [runId, parent] of waiting) {
        const batches = [...state.batches.values()].filter(batch => batch.parentRunId === runId)
        const batch = batches.at(-1)
        if (batch !== undefined && batch.childIds.every(id => state.tasks.get(id)?.phase === 'closed')) {
          waiting.delete(runId)
          enqueue(parent.request, 'resume')
        }
      }
    }
    if (signal.aborted) {
      const state = await service.taskRunState(request.transientInvalidReasons ?? [])
      if (state.tasks.get(rootTaskId)?.phase !== 'closed') {
        settled.push(...await closeInterruptedSubtree({ ctx: request.ctx, service, actor, rootTaskId,
          reason: String(signal.reason), outcome: cancellation.signal.aborted || deadline.aborted ? 'failed' : 'cancelled',
          observations: interrupted, transientInvalidReasons: request.transientInvalidReasons ?? [],
          ...(request.summaries === undefined ? {} : { summaries: request.summaries }) }))
      }
    } else if (waiting.size > 0) throw new Error('RunPool ended with a nonterminal child batch')
    const root = settled.findLast(result => result.taskId === rootTaskId)
    if (root === undefined) throw new Error('RunPool ended without a settled root')
    return { root, runs: settled, facts: service.facts() }
  } finally {
    if (running.size > 0 || waiting.size > 0) cancellation.abort('tree-execution-failed')
    await Promise.allSettled(running.values())
    const summaries = request.summaries
    if (summaries !== undefined) await Promise.allSettled([...waiting.keys()].map(runId => summaries.cancelRun(runId)))
    if (sharedWriter === undefined) await service.close()
  }
}
