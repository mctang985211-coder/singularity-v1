import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { readSessionEvents } from './session-events.ts'

import type { ContextEpoch } from './epoch.ts'
import { deriveContextEpoch } from './epoch.ts'

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
  readonly surfaceVisible: boolean
}

/** Read-only DSH session view used for persistent prepare delivery receipts. */
export interface SessionToolView {
  readonly sessionId: string
  readonly epoch: ContextEpoch
  readonly calls: readonly ToolCallRecord[]
  readonly results: readonly ToolResultRecord[]
}

/**
 * Reads committed tool records and uses native surface/lifecycle fields for the
 * current surface and context epoch. This module owns DSH event shape only;
 * business validation belongs to its caller.
 */
export function readSessionToolView(session: Session): SessionToolView {
  // The synchronous receipt consumer shares the one alpha2 compatibility read.
  const events = readSessionEvents(session)
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
      surfaceVisible: surfaceNodes.has(event.seq),
    })
  }
  return {
    sessionId: String(session.id),
    epoch: deriveContextEpoch(session),
    calls,
    results,
  }
}

/** Resolve the native DSH call identity; DSH owns log integrity and uniqueness. */
export function findCurrentToolCall(view: SessionToolView, callId: string): ToolCallRecord {
  const call = view.calls.find(call => call.callId === callId)
  if (call === undefined) throw new Error(`DSH tool call ${JSON.stringify(callId)} is missing`)
  return call
}

function resultText(content: readonly ContentBlock[]): string | undefined {
  if (content.length === 0 || content.some(block => block.type !== 'text')) return undefined
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}
