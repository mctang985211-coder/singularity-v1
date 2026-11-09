import type { Fact,Ref,SessionCut,TaskRunState,UsageRecord } from '@singularity/protocol'

import type { AgentDriveResult } from './agent.ts'
import { activeChildBatch } from './decompose-commit.ts'
import type { RunToolSnapshot } from './tools.ts'
import type { WakeDeliveryOutcome } from './wake.ts'

/** A Run released its model slot while waiting for children or its dispatcher. */
export interface YieldedRunResult {
  readonly kind: 'yielded'
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly batchId?: string
  readonly feedbackWait?: Ref
  readonly childTaskIds: readonly string[]
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly facts: readonly Fact[]
}

export interface RunYieldInput {
  readonly state: TaskRunState
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
  readonly tools: RunToolSnapshot
  readonly observation: AgentDriveResult
  readonly facts: readonly Fact[]
}

/** An idle Agent with pending children or a question yields without settlement. */
export function yieldedRun(
  input: RunYieldInput,
): (YieldedRunResult & RunSessionAction) | undefined {
  const activeBatch = activeChildBatch(input.state, input.runId)
  if ((activeBatch === undefined && input.tools.feedbackWait === undefined)
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
    ...(activeBatch === undefined ? {} : { batchId: activeBatch.batchId }),
    ...(input.tools.feedbackWait === undefined ? {} : { feedbackWait: input.tools.feedbackWait }),
    childTaskIds: [...(activeBatch?.childIds ?? [])],
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
