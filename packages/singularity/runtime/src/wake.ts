import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Stable identity and body of one host-initiated wake. */
export interface WakeRequest {
  /** Stable message id; resuming the same logical wake reuses it. */
  readonly wakeId: string
  /** Exact model-facing text of the wake. */
  readonly text: string
}

/** Raw-log conclusion for one wake id. */
export type WakeEventState = 'never-inserted' | 'removed' | 'pending' | 'admitted' | 'conflict'

/** What a successful delivery did. */
export type WakeDeliveryOutcome = 'sent' | 'already-admitted'

/** Why delivery refused to touch the model path. */
export type WakeRefusalState = 'removed' | 'pending' | 'corrupt'

/** Fail-closed wake delivery error. */
export class WakeDeliveryRefusedError extends Error {
  readonly state: WakeRefusalState
  readonly wakeId: string

  constructor(state: WakeRefusalState, wakeId: string, message: string) {
    super(message)
    this.name = 'WakeDeliveryRefusedError'
    this.state = state
    this.wakeId = wakeId
  }
}

interface WakeInspection {
  readonly state: WakeEventState
  readonly detail?: string
}

interface InboxFold {
  nextTurn: UserMessage[]
  nextStep: UserMessage[]
  readonly admissions: UserMessage[]
  inserted: boolean
  removed: boolean
  conflict?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUserMessage(value: unknown): value is UserMessage {
  if (!isRecord(value)) return false
  if (value.role !== 'user' || typeof value.id !== 'string') return false
  if (!Array.isArray(value.content) || !isRecord(value.source)) return false
  if (typeof value.source.kind !== 'string') return false
  return value.content.every(block => {
    if (!isRecord(block) || typeof block.type !== 'string') return false
    return block.type !== 'text' || typeof block.text === 'string'
  })
}

function textOf(message: Pick<UserMessage, 'content'>): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function sourceKindOf(message: UserMessage): string {
  const source: unknown = message.source
  return isRecord(source) && typeof source.kind === 'string' ? source.kind : ''
}

function sameWakeMessage(actual: UserMessage, expected: UserMessage): boolean {
  return textOf(actual) === textOf(expected) && sourceKindOf(actual) === sourceKindOf(expected)
}

function readSessionEvents(session: Session): readonly SessionEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- alpha2 exposes no replacement raw reader
  return session.snapshotEvents()
}

function markConflict(fold: InboxFold, detail: string): void {
  fold.conflict ??= detail
}

function applySplice(fold: InboxFold, raw: unknown, wakeId: string): void {
  if (!isRecord(raw)) {
    markConflict(fold, 'agent/inbox/spliced payload is not an object')
    return
  }
  const target = raw.target
  if (target !== 'next-turn' && target !== 'next-step') {
    markConflict(fold, 'agent/inbox/spliced carries an unknown target')
    return
  }
  const start = raw.start
  const removedCount = raw.removedCount ?? 0
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) {
    markConflict(fold, 'agent/inbox/spliced carries an invalid start')
    return
  }
  if (typeof removedCount !== 'number' || !Number.isSafeInteger(removedCount) || removedCount < 0) {
    markConflict(fold, 'agent/inbox/spliced carries an invalid removedCount')
    return
  }
  if (raw.outcome !== undefined && raw.outcome !== 'canceled') {
    markConflict(fold, 'agent/inbox/spliced carries an unknown outcome')
    return
  }
  const insertedRaw = raw.inserted
  if (!Array.isArray(insertedRaw)) {
    markConflict(fold, 'agent/inbox/spliced carries a non-array inserted field')
    return
  }
  const inserted: UserMessage[] = []
  for (const entry of insertedRaw) {
    if (!isUserMessage(entry)) {
      markConflict(fold, 'agent/inbox/spliced inserted a non-user message')
      return
    }
    inserted.push(entry)
  }
  const current = target === 'next-turn' ? fold.nextTurn : fold.nextStep
  if (start + removedCount > current.length) {
    markConflict(fold, 'agent/inbox/spliced removes past the pending list')
    return
  }
  const removed = current.slice(start, start + removedCount)
  const next = [...current.slice(0, start), ...inserted, ...current.slice(start + removedCount)]
  if (target === 'next-turn') fold.nextTurn = next
  else fold.nextStep = next
  if (removed.some(message => String(message.id) === wakeId)) fold.removed = true
  if (inserted.some(message => String(message.id) === wakeId)) fold.inserted = true
  const ids = new Set<string>()
  for (const message of [...fold.nextTurn, ...fold.nextStep]) {
    const id = String(message.id)
    if (ids.has(id)) {
      markConflict(fold, `multiple pending messages share id "${id}"`)
      return
    }
    ids.add(id)
  }
}

function inspectWakeEvents(
  events: readonly SessionEvent[],
  wakeId: string,
  expected: UserMessage,
): WakeInspection {
  const fold: InboxFold = {
    nextTurn: [],
    nextStep: [],
    admissions: [],
    inserted: false,
    removed: false,
  }
  let otherRole = false
  for (const event of events) {
    const type: string = event.type
    if (type.startsWith('agent/inbox/') && type !== 'agent/inbox/spliced') {
      markConflict(fold, `unknown inbox event type "${type}"`)
    }
    switch (event.type) {
      case 'agent/inbox/spliced':
        applySplice(fold, event.data, wakeId)
        break
      case 'user/message': {
        const message: unknown = event.data
        if (!isUserMessage(message)) {
          markConflict(fold, 'user/message payload is not a user message')
          break
        }
        if (String(message.id) === wakeId) {
          // A checkpoint replacement copies history; only an append admits new input.
          if (event.surfaceOp === 'append') fold.admissions.push(message)
          else markConflict(fold, 'the wake id appears in a surface replacement, not an admission append')
        }
        break
      }
      case 'system/message':
      case 'developer/message':
      case 'assistant/message':
      case 'tool/result': {
        const message: unknown = event.data.message
        if (isRecord(message) && message.id === wakeId) otherRole = true
        break
      }
      default:
        break
    }
    if (fold.conflict !== undefined) break
  }

  const pending = [...fold.nextTurn, ...fold.nextStep].filter(message => String(message.id) === wakeId)
  if (fold.conflict !== undefined) return { state: 'conflict', detail: fold.conflict }
  if (otherRole) return { state: 'conflict', detail: 'the wake id is already used by another message role' }
  if (fold.admissions.length > 1) return { state: 'conflict', detail: 'the wake id was admitted more than once' }
  if (pending.length > 1) return { state: 'conflict', detail: 'the wake id is pending more than once' }
  if (fold.admissions.length === 1) {
    const [admission] = fold.admissions
    if (!sameWakeMessage(admission, expected)) {
      return { state: 'conflict', detail: 'the admitted message body differs from this wake request' }
    }
    if (pending.length > 0) {
      return { state: 'conflict', detail: 'the admitted wake id is also pending in the inbox' }
    }
    return { state: 'admitted' }
  }
  if (pending.length === 1) return { state: 'pending' }
  if (fold.inserted || fold.removed) return { state: 'removed' }
  return { state: 'never-inserted' }
}

/** Build the frozen user message for a wake. */
export function createWakeMessage(request: WakeRequest): UserMessage {
  return freezeMessage({
    id: MessageId(request.wakeId),
    role: 'user',
    content: [{ type: 'text', text: request.text }],
    source: { kind: 'user' },
  })
}

/**
 * Deliver one wake with a stable message id, or fail closed when the raw DSH
 * session log already carries the id in a state the host must not duplicate.
 * This is the single runtime wake adapter: no second wake authority,
 * in-memory boolean, or provider exactly-once promise.
 */
export function deliverWakeOnceOrFail(
  agent: Agent,
  request: WakeRequest,
): Promise<WakeDeliveryOutcome> {
  try {
    const expected = createWakeMessage(request)
    const inspection = inspectWakeEvents(readSessionEvents(agent.session), request.wakeId, expected)
    switch (inspection.state) {
      case 'admitted':
        return Promise.resolve('already-admitted')
      case 'pending':
        return Promise.reject(new WakeDeliveryRefusedError(
          'pending',
          request.wakeId,
          `wake "${request.wakeId}" is still pending in the DSH inbox; refusing to duplicate it`,
        ))
      case 'conflict':
        return Promise.reject(new WakeDeliveryRefusedError(
          'corrupt',
          request.wakeId,
          `wake "${request.wakeId}" has contradictory raw session evidence: ${inspection.detail ?? 'unknown'}`,
        ))
      case 'never-inserted':
        agent.followup(expected)
        return Promise.resolve('sent')
      case 'removed':
        return Promise.reject(new WakeDeliveryRefusedError(
          'removed',
          request.wakeId,
          `wake "${request.wakeId}" was previously enqueued and removed; recovery semantics are undefined`,
        ))
    }
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? new WakeDeliveryRefusedError('corrupt', request.wakeId, `wake "${request.wakeId}" inspection failed: ${error.message}`)
      : new WakeDeliveryRefusedError('corrupt', request.wakeId, `wake "${request.wakeId}" inspection failed: ${String(error)}`))
  }
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
