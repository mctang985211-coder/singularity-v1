import assert from 'node:assert/strict'
import test from 'node:test'

import type { Session,SessionEvent } from '@deepseek-ai/dsh-session'

import {
findCurrentToolCall,
readSessionToolView,
} from '../src/receipts.ts'

interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  readonly sourceEventSeqs?: readonly number[]
}

function fakeSession(events: readonly FakeEvent[], nodes: readonly number[]): Session {
  return {
    id: 'session-receipts',
    get seq() { return events.length },
      snapshotEvents: () => events as unknown as readonly SessionEvent[],
    firstLiveSeq: 0,
    surface: { nodes, replaceGeneration: 0 },
  } as unknown as Session
}

function call(seq: number, turn: number, step: number, callId: string): FakeEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1,
    data: {
      turn,
      step,
      callId,
      name: 'singularity_decompose',
      arguments: JSON.stringify({ action: 'prepare', bindingId: 'b1' }),
    },
  }
}

function result(
  seq: number,
  turn: number,
  step: number,
  callId: string,
  text: string,
  options: { readonly isError?: boolean; readonly surfaceOp?: FakeEvent['surfaceOp'] } = {},
): FakeEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1,
    data: {
      turn,
      step,
      message: {
        role: 'tool',
        id: `result-${String(seq)}`,
        toolCallId: callId,
        isError: options.isError,
        content: [{ type: 'text', text }],
      },
    },
    surfaceOp: options.surfaceOp ?? 'append',
    sourceEventSeqs: [seq - 1],
  }
}

void test('S4-B1 receipt view pairs calls/results with turn, step, surface, and epoch', () => {
  const events = [
    call(0, 1, 1, 'prepare-1'),
    result(1, 1, 1, 'prepare-1', '{"status":"preview"}'),
    call(2, 1, 2, 'status-1'),
  ]
  const view = readSessionToolView(fakeSession(events, [1]))
  assert.equal(view.calls.length, 2)
  assert.equal(view.results.length, 1)
  assert.equal(view.results[0]?.callId, 'prepare-1')
  assert.equal(view.results[0]?.text, '{"status":"preview"}')
  assert.equal(view.results[0]?.surfaceVisible, true)
  assert.equal(view.epoch, view.epoch)
  const current = findCurrentToolCall(view, 'status-1')
  assert.equal(current.turn, 1)
  assert.equal(current.step, 2)
})

void test('S4-B1 receipt view keeps failed and shadowed results distinguishable', () => {
  const events = [
    call(0, 1, 1, 'prepare-1'),
    result(1, 1, 1, 'prepare-1', '{"status":"preview"}', { isError: true }),
    call(2, 1, 2, 'status-1'),
  ]
  const view = readSessionToolView(fakeSession(events, []))
  assert.equal(view.results[0]?.isError, true)
  assert.equal(view.results[0]?.surfaceVisible, false)
  assert.throws(() => findCurrentToolCall(view, 'missing'), /DSH tool call "missing" is missing/)
})
