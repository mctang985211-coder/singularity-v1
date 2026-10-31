import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

import { deriveContextEpochFromEvents } from './epoch.ts'
import type { ContextEpoch } from './epoch.ts'

/** Stable diagnostic for a session log that cannot be read as committed events. */
type SessionReceiptErrorCode =
  | 'SESSION_LOG_INCOMPLETE'
  | 'DUPLICATE_TOOL_CALL'
  | 'TOOL_CALL_NOT_FOUND'

class SessionReceiptError extends Error {
  override readonly name = 'SessionReceiptError'
  readonly code: SessionReceiptErrorCode

  constructor(code: SessionReceiptErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** One committed tool invocation from the DSH session log. */
export interface ToolCallRecord {
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly name: string
  /** Raw model-authored JSON string from `tool/call.data.arguments`. */
  readonly argumentsText: string
}

/** One committed tool result correlated by call id. */
export interface ToolResultRecord {
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
  /** Concatenated text blocks; undefined when the result has no text block. */
  readonly text: string | undefined
  readonly surfaceOp: 'append' | 'replace'
  readonly sourceEventSeqs: readonly number[]
  readonly surfaceVisible: boolean
}

/** Read-only DSH session view used for persistent prepare delivery receipts. */
export interface SessionToolView {
  readonly sessionId: string
  readonly epoch: ContextEpoch
  readonly surfaceNodes: ReadonlySet<number>
  readonly calls: readonly ToolCallRecord[]
  readonly results: readonly ToolResultRecord[]
}

/**
 * Reads the committed DSH session log through `eventAt`/`seq` and derives the
 * current surface and context epoch. This module owns DSH event shape only;
 * business validation belongs to its caller.
 */
export function readSessionToolView(session: Session): SessionToolView {
  // alpha2 exposes no non-deprecated raw event reader; this adapter is the one
  // intentionally unmigrated consumer for persisted tool receipts.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const events = session.snapshotEvents()
  if (events.length !== Number(session.seq)) {
    throw new SessionReceiptError(
      'SESSION_LOG_INCOMPLETE',
      `session ${JSON.stringify(String(session.id))} logged ${String(events.length)} events for end offset ${String(session.seq)}`,
    )
  }
  const surfaceNodes = new Set(session.surface.nodes.map(Number))
  const calls: ToolCallRecord[] = []
  const results: ToolResultRecord[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.push({
        seq: event.seq,
        turn: event.data.turn,
        step: event.data.step,
        callId: String(event.data.callId),
        name: event.data.name,
        argumentsText: event.data.arguments,
      })
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = event.data.message
    const text = resultText(message.content)
    const surfaceOp = event.surfaceOp === 'append' ? 'append' : 'replace'
    results.push({
      seq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      callId: String(message.toolCallId),
      isError: message.isError === true,
      content: message.content,
      text,
      surfaceOp,
      sourceEventSeqs: (event.sourceEventSeqs ?? []).map(Number),
      surfaceVisible: surfaceNodes.has(event.seq),
    })
  }
  return {
    sessionId: String(session.id),
    epoch: deriveContextEpochFromEvents(session.id, events),
    surfaceNodes,
    calls,
    results,
  }
}

/** Finds exactly one committed call for a tool execution identity. */
export function findCurrentToolCall(view: SessionToolView, callId: string): ToolCallRecord {
  const matches = view.calls.filter(call => call.callId === callId)
  if (matches.length !== 1) {
    throw new SessionReceiptError(
      matches.length === 0 ? 'TOOL_CALL_NOT_FOUND' : 'DUPLICATE_TOOL_CALL',
      `expected exactly one tool/call for ${JSON.stringify(callId)}, found ${String(matches.length)}`,
    )
  }
  return matches[0]
}

function resultText(content: readonly ContentBlock[]): string | undefined {
  if (content.length === 0 || content.some(block => block.type !== 'text')) return undefined
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}
