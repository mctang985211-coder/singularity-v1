import type { Fact,SessionCut,TaskRunState,UsageRecord } from '@singularity/protocol'

import type { AgentDriveResult } from './agent.ts'
import { activeChildBatch } from './decompose-commit.ts'
import type { RunToolSnapshot } from './tools.ts'
import type { WakeDeliveryOutcome } from './wake.ts'

/** A parent Run released its model slot while a committed child batch is active. */
export interface YieldedRunResult {
  readonly kind: 'yielded'
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly batchId: string
  readonly childTaskIds: readonly string[]
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly facts: readonly Fact[]
}

export interface ActiveBatchYieldInput {
  readonly state: TaskRunState
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly tools: RunToolSnapshot
  readonly observation: AgentDriveResult
  readonly facts: readonly Fact[]
}

/**
 * Returns the waiting-children outcome only when the Agent went idle without a
 * submission, stop, or infrastructure failure and the parent Run
 * still owns an active committed child batch. This function never settles.
 */
export function yieldedActiveChildBatch(
  input: ActiveBatchYieldInput,
): (YieldedRunResult & RunSessionAction) | undefined {
  const activeBatch = activeChildBatch(input.state, input.runId)
  if (activeBatch === undefined
    || input.tools.submission !== undefined
    || input.tools.stopped !== undefined
    || input.observation.agentErrorCode !== undefined
    || input.observation.snapshot.failure !== undefined) {
    return undefined
  }
  return {
    kind: 'yielded',
    taskId: input.taskId,
    runId: input.runId,
    sessionId: input.sessionId,
    batchId: activeBatch.batchId,
    childTaskIds: [...activeBatch.childIds],
    usage: input.observation.snapshot.usage,
    sessionCut: input.observation.snapshot.sessionCut,
    facts: input.facts,
    sessionAction: input.observation.sessionAction,
    ...(input.observation.wakeOutcome === undefined
      ? {}
      : { wakeOutcome: input.observation.wakeOutcome }),
  }
}

/** Session continuation fields shared by settled and yielded attempts. */
export interface RunSessionAction {
  readonly sessionAction: 'created' | 'none' | 'resumed'
  readonly wakeOutcome?: WakeDeliveryOutcome
}
