import type { Session } from '@deepseek-ai/dsh-session'
import {
  canonicalize,
  parseJsonText,
  parseProtocolValue,
  refSchema,
  taskFeedbackInputSchema,
  taskFeedbackSchema,
} from '@singularity/protocol'
import type { JsonValue, Ref, TaskContract, TaskFeedback, TaskFeedbackInput, TaskRunState } from '@singularity/protocol'

import { DecomposeError } from './errors.ts'
import { readSessionToolView } from './receipts.ts'
import type { CasObjectReader, CasObjectWriter } from './workspace.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

interface FeedbackIdentity {
  readonly contract: TaskContract
  readonly runId: string
  readonly createdAt: number
  readonly writer: CasObjectWriter
}

/** Writes a non-blocking suggestion with host-derived direct-parent identity. */
export async function createTaskFeedback(input: FeedbackIdentity & {
  readonly callId: string
  readonly input: TaskFeedbackInput
  readonly authorizedRefs?: readonly Ref[]
}): Promise<Ref> {
  const suggestion = parseProtocolValue(taskFeedbackInputSchema, input.input)
  const allowed = new Set((input.authorizedRefs ?? []).map(refKey))
  if (suggestion.refs.some(ref => !allowed.has(refKey(ref)))) {
    throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'feedback refs must be public objects owned by this source Run')
  }
  return writeFeedback(input, `feedback:${input.runId}:${input.callId}`, 'child-worker', suggestion)
}

/** Closure coordination writes this only after its public result is durable. */
export function createSchedulerFeedback(input: FeedbackIdentity & {
  readonly reason: string
  readonly resultRef: Ref
}): Promise<Ref> {
  return writeFeedback(input, `feedback:${input.runId}:scheduler`, 'scheduler', {
    kind: 'needs-replan',
    summary: input.reason,
    proposedChanges: [],
    refs: [input.resultRef],
  })
}

async function writeFeedback(
  input: FeedbackIdentity,
  id: string,
  source: TaskFeedback['source'],
  suggestion: TaskFeedbackInput,
): Promise<Ref> {
  const origin = input.contract.origin
  if (origin.kind !== 'child') {
    throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'only a child Task can send feedback to its direct parent')
  }
  const feedback = parseProtocolValue(taskFeedbackSchema, {
    ...suggestion,
    v: 1,
    id,
    source,
    sourceTaskId: input.contract.taskId,
    sourceRunId: input.runId,
    directParentTaskId: origin.parentId,
    sourceContract: input.contract.digest,
    createdAt: input.createdAt,
  })
  return input.writer.putObject(id, encoder.encode(canonicalize(feedback)), 'object')
}

/** Successful persisted DSH results are the receipt; compaction does not erase them. */
export function feedbackRefsFromSession(session: Session): readonly Ref[] {
  const view = readSessionToolView(session)
  const calls = new Map(view.calls.map(call => [call.callId, call]))
  const refs = new Map<string, Ref>()
  for (const result of view.results) {
    if (result.isError || result.text === undefined) continue
    const call = calls.get(result.callId)
    if (call === undefined || result.seq <= call.seq) continue
    if (call.name !== 'singularity_feedback' && call.name !== 'singularity_read') continue
    const parsed: unknown = parseJsonText(result.text)
    if (!isRecord(parsed)) continue
    if (call.name === 'singularity_feedback') {
      const ref = refSchema.safeParse(parsed['feedbackRef'])
      if (ref.success) refs.set(refKey(ref.data), ref.data)
      continue
    }
    const args: unknown = parseJsonText(call.argumentsText)
    if (!isRecord(args) || args['kind'] !== 'feedback') continue
    const data = parsed['data']
    if (!Array.isArray(data)) continue
    for (const item of data) {
      if (!isRecord(item)) continue
      const ref = refSchema.safeParse(item['feedbackRef'])
      if (ref.success) refs.set(refKey(ref.data), ref.data)
    }
  }
  return [...refs.values()]
}

/** Reads only feedback authored by the caller's direct children, across retries. */
export interface DirectFeedbackEntry {
  readonly feedbackRef: Ref
  readonly feedback: TaskFeedback
}

export async function loadDirectFeedback(input: {
  readonly state: TaskRunState
  readonly parentTaskId: string
  readonly reader: CasObjectReader
}): Promise<readonly DirectFeedbackEntry[]> {
  const entries: { readonly feedbackRef: Ref; readonly feedback: TaskFeedback }[] = []
  const seen = new Set<string>()
  const parent = input.state.tasks.get(input.parentTaskId)
  if (parent === undefined) throw new DecomposeError('INVALID_ARGUMENT', 'parent Task is missing')
  for (const childId of parent.childIds) {
    const child = input.state.tasks.get(childId)
    if (child === undefined) continue
    for (const runId of child.runIds) {
      const run = input.state.runs.get(runId)
      // The closed fact indexes suggestions after the source Run has settled.
      const refs = [...(run?.submitted?.feedbackRefs ?? []), ...(run?.closed?.source === 'run/closed' ? run.closed.feedbackRefs ?? [] : [])]
      for (const ref of refs) {
        if (seen.has(refKey(ref))) continue
        seen.add(refKey(ref))
        const value = parseJsonText(decoder.decode((await input.reader.readObject(ref, 'object')).bytes))
        const feedback = parseProtocolValue(taskFeedbackSchema, value)
        if (feedback.sourceTaskId !== childId || feedback.sourceRunId !== runId
          || feedback.directParentTaskId !== input.parentTaskId || feedback.sourceContract !== child.contract.digest) continue
        entries.push({ feedbackRef: ref, feedback })
      }
    }
  }
  return entries
}

export async function readDirectFeedback(input: {
  readonly state: TaskRunState
  readonly parentTaskId: string
  readonly reader: CasObjectReader
  readonly id?: string
  readonly cursor?: string
  readonly page?: number
}): Promise<{ readonly data: JsonValue; readonly nextCursor?: string }> {
  const entries = (await loadDirectFeedback(input)).filter(entry => input.id === undefined
    || input.id === entry.feedback.id || input.id === entry.feedbackRef.digest)
  const prefix = `feedback:${input.parentTaskId}:`
  const offset = input.cursor === undefined ? 0 : Number(input.cursor.slice(prefix.length))
  const pageSize = input.page ?? 8
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length
    || (input.cursor !== undefined && input.cursor !== `${prefix}${String(offset)}`)
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 32) {
    throw new DecomposeError('INVALID_ARGUMENT', 'feedback page cursor or size is invalid')
  }
  const end = Math.min(entries.length, offset + pageSize)
  return {
    data: entries.slice(offset, end) as unknown as JsonValue,
    ...(end < entries.length ? { nextCursor: `${prefix}${String(end)}` } : {}),
  }
}

function refKey(ref: Ref): string {
  return `${ref.id}:${ref.digest}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
