import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { seal } from '@singularity/protocol'
import type { CancellationCutAffected, FactActor } from '@singularity/protocol'

import { snapshotSessionEvents } from './agent.ts'
import type { ContractSummaryService } from './contract-summary.ts'
import type { ExecuteSingleRunResult, InterruptedRunResult } from './run.ts'
import { commitFact, putSealed } from './run-settlement.ts'
import type { CommandService } from './service.ts'
import { buildExecutionRecord } from './verification.ts'

/** Called only after every running native lifecycle has finished. */
export async function closeInterruptedSubtree(request: {
  readonly ctx: Context
  readonly service: CommandService
  readonly actor: FactActor
  readonly rootTaskId: string
  readonly reason: string
  readonly outcome: 'failed' | 'cancelled'
  readonly observations: readonly InterruptedRunResult[]
  readonly summaries?: ContractSummaryService
  readonly transientInvalidReasons?: readonly string[]
}): Promise<readonly ExecuteSingleRunResult[]> {
  const { service } = request
  const state = await service.taskRunState(request.transientInvalidReasons ?? [])
  const observations = new Map(request.observations.map(record => [record.runId, record]))
  const affected: CancellationCutAffected[] = []
  for (const task of state.tasks.values()) {
    if (task.rootTaskId !== request.rootTaskId || task.phase === 'closed') continue
    const runs = task.runIds.flatMap(id => {
      const run = state.runs.get(id)
      return run === undefined || run.phase === 'closed' ? [] : [run]
    })
    if (runs.length === 0) affected.push({ taskId: task.taskId })
    for (const run of runs) {
      let observation = observations.get(run.runId)
      if (observation === undefined) {
        // Waiting parents have disposed their handles and retain their native log.
        const persistence: SessionPersistence | undefined = request.ctx.get('sessionPersistence', false)
        if (persistence === undefined) throw new Error('Cancellation requires persisted final session usage')
        const handle = await persistence.open(run.opened.sessionId as SessionId, 'read')
        let snapshot
        try { snapshot = snapshotSessionEvents(String(handle.id), (await handle.read()).events) }
        finally { await handle.close() }
        const summary = await request.summaries?.finishRun(run.runId)
        const usage = { ...snapshot.usage, ...(summary === undefined ? {} : { summary }) }
        const executionRecord = buildExecutionRecord({ contract: task.contract, runId: run.runId,
          composition: run.opened.composition, usage, sessionCut: snapshot.sessionCut, reason: request.reason })
        const executionRecordRef = await putSealed(service, `${run.runId}:execution-record`, executionRecord, 'object')
        observation = { kind: 'interrupted', taskId: task.taskId, runId: run.runId,
          sessionId: run.opened.sessionId, usage, sessionCut: snapshot.sessionCut, executionRecord, executionRecordRef }
        observations.set(run.runId, observation)
      }
      affected.push({ taskId: task.taskId, runId: run.runId, executionRecordRef: observation.executionRecordRef })
    }
  }
  const cut = seal('object', { v: 1, targetTaskId: request.rootTaskId, affected })
  const cutRef = await putSealed(service, `${request.rootTaskId}:cancellation-cut`, cut, 'object')
  const fact = await commitFact(service, request.actor, `task:${request.rootTaskId}:subtree-closed`,
    'task.cancel-subtree', { taskId: request.rootTaskId }, { taskId: request.rootTaskId, reason: request.reason },
    'task/closed', { taskId: request.rootTaskId, outcome: request.outcome, reason: request.reason,
      scope: 'subtree', cancellationCutRef: cutRef, evidenceRefs: [] }, request.transientInvalidReasons ?? [])
  return [...observations.values()].map(observation => ({
    ...observation, kind: 'settled', classification: 'cancelled', runFact: fact, taskFact: fact,
    retry: { allowed: false, reason: request.reason }, facts: service.facts(),
  }))
}
