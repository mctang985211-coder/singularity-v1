import type { TaskRunState } from '@singularity/protocol'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId,freezeMessage } from '@deepseek-ai/dsh-llm'
import type { RemainingBudgetPct } from './prompt.ts'

/** Stable identity and body of one host-initiated wake. */
export interface WakeRequest {
  readonly wakeId: string
  readonly text: string
}

export type WakeDeliveryOutcome = 'sent' | 'already-admitted'

/** Build the frozen user message for a wake. */
export function createWakeMessage(request: WakeRequest): UserMessage {
  return freezeMessage({
    id: MessageId(request.wakeId),
    role: 'user',
    content: [{ type: 'text', text: request.text }],
    source: { kind: 'user' },
  })
}

/** Reuse a recorded message id; let DSH own inbox state and delivery errors. */
export function deliverWakeOnceOrFail(
  agent: Agent,
  request: WakeRequest,
): Promise<WakeDeliveryOutcome> {
  return Promise.resolve().then(() => {
    if (agent.session.deriveMessages().some(message => message.role === 'user' && String(message.id) === request.wakeId)) {
      return 'already-admitted'
    }
    agent.followup(createWakeMessage(request))
    return 'sent'
  })
}

/** Prompt text for the first wake, using remaining percentages only. */
export function startWakeText(
  taskId: string,
  runId: string,
  percentages: { readonly tokensPct: number | null; readonly stepsPct: number; readonly wallClockPct: number; readonly taskSlotsPct: number },
): string {
  return [
    `Task ${taskId}; Run ${runId}; reason=start;`,
    `remaining-budget=${String(percentages.tokensPct ?? 'unknown')}/${String(percentages.stepsPct)}/${String(percentages.wallClockPct)}/${String(percentages.taskSlotsPct)}%.`,
    'Read self, submit a planning sketch, then work toward this Task\'s goal.',
  ].join(' ')
}

/** Latest complete batch gives one deterministic wake identity, independent of completion order. */
export function batchWakeRequest(state: TaskRunState, runId: string, budget?: RemainingBudgetPct): WakeRequest | undefined {
  const batch = [...state.batches.values()].filter(batch => batch.parentRunId === runId).at(-1)
  if (batch === undefined || batch.childIds.some(id => state.tasks.get(id)?.phase !== 'closed')) return undefined
  return {
    wakeId: `${runId}:${batch.batchId}:terminal`,
    text: `Task ${batch.parentTaskId}; Run ${runId}; reason=children-terminal; batch=${batch.batchId}; remainingBudgetPct=${JSON.stringify(budget ?? null)}. Read direct results, failed criteria/check reports and feedback. Update the completion path and disproved assumptions; correct locally, create a new bounded batch or report a blocker. Integrate outputs and check the real consumer before submit.`,
  }
}
