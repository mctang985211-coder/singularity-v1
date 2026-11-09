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
  readonly reply?: TaskFeedback
}

/** Writes a question or reply with host-derived direct-parent identity. */
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
  if (suggestion.replyTo !== undefined && (input.reply?.id !== suggestion.replyTo
    || input.reply.directParentTaskId !== input.contract.taskId || input.reply.source !== 'child-worker')) {
    throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'replyTo must identify feedback from a direct child')
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
  if (input.reply === undefined && origin.kind !== 'child') {
    throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'only a child Task can send feedback to its direct parent')
  }
  const feedback = parseProtocolValue(taskFeedbackSchema, {
    ...suggestion,
    v: 1,
    id,
    source: input.reply === undefined ? source : 'parent-worker',
    sourceTaskId: input.contract.taskId,
    sourceRunId: input.runId,
    directParentTaskId: input.reply === undefined && origin.kind === 'child' ? origin.parentId : input.contract.taskId,
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

/** Reads direct-child questions and dispatcher replies, across retries. */
export interface DirectFeedbackEntry {
  readonly feedbackRef: Ref
  readonly feedback: TaskFeedback
}

export async function loadDirectFeedback(input: {
  readonly state: TaskRunState
  readonly parentTaskId: string
  readonly reader: CasObjectReader
  readonly session?: (runId: string) => Session | undefined
}): Promise<readonly DirectFeedbackEntry[]> {
  const entries: { readonly feedbackRef: Ref; readonly feedback: TaskFeedback }[] = []
  const seen = new Set<string>()
  const parent = input.state.tasks.get(input.parentTaskId)
  if (parent === undefined) throw new DecomposeError('INVALID_ARGUMENT', 'parent Task is missing')
  const refsFor = (runId: string) => {
    const run = input.state.runs.get(runId), session = input.session?.(runId)
    return [...(session === undefined ? [] : feedbackRefsFromSession(session)),
      ...(run?.submitted?.feedbackRefs ?? []), ...(run?.closed?.source === 'run/closed' ? run.closed.feedbackRefs ?? [] : [])]
  }
  const neighbors = [...parent.childIds, ...(parent.parentTaskId === undefined ? [] : [parent.parentTaskId])]
  for (const childId of neighbors) {
    const child = input.state.tasks.get(childId)
    if (child === undefined) continue
    for (const runId of child.runIds) {
      for (const ref of refsFor(runId)) {
        if (seen.has(refKey(ref))) continue
        seen.add(refKey(ref))
        const value = parseJsonText(decoder.decode((await input.reader.readObject(ref, 'object')).bytes))
        const feedback = parseProtocolValue(taskFeedbackSchema, value)
        if (feedback.sourceTaskId !== childId || feedback.sourceRunId !== runId
          || feedback.sourceContract !== child.contract.digest) continue
        if (feedback.source === 'parent-worker'
          ? !parent.runIds.some(id => refsFor(id).some(ref => ref.id === feedback.replyTo))
          : feedback.directParentTaskId !== input.parentTaskId) continue
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
  readonly session?: (runId: string) => Session | undefined
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
