import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { bootSpikeProfile } from '../src/host-composition.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import type { CapturedChatRequest, ChatCompletionsFixture, FixtureReply, WireChatMessage } from './fixtures/chat-completions.ts'
import {
  deriveContextEpoch,
  evaluateContextEpochReceipt,
  issueContextEpochReceipt,
} from './helpers/context-epoch.ts'

const SELF_READ_TOOL = 'spike_self_read'
const PREVIEW_TOOL = 'spike_preview'
const SELF_READ_MARKER = 'self-read-source-only-7f1c9e'
const PREVIEW_MARKER = 'preview-source-only-2b8d4a'
const SELF_READ_CONTENT = `${SELF_READ_MARKER}\n${'persistent self-read contract detail '.repeat(80)}`
const PREVIEW_CONTENT = `${PREVIEW_MARKER}\n${'persistent child preview example detail '.repeat(80)}`
const SUMMARY_CONTENT = [
  '## Primary Request and Intent',
  '- Preserve the compacted contract evidence in one checkpoint.',
  '',
  '## Pending Jobs',
  '- (none)',
].join('\n')
const INITIAL_PROMPT = [
  `Call ${SELF_READ_TOOL} and ${PREVIEW_TOOL} in one tool-call batch.`,
  'Do not answer in text in this step.',
].join('\n')

interface CompactionResultLike {
  readonly compactionId: string
  readonly startSeq: SessionSeq
  readonly summarySeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly shadowedSeqs: readonly SessionSeq[]
}

interface CompactionServiceLike {
  compactNow(agent: Agent, signal: AbortSignal): Promise<CompactionResultLike | null>
}

type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>

/**
 * Read the committed session log for assertions. Alpha2 exposes no replacement
 * snapshot read API, so the deprecated reader remains the only durable view.
 */
function readSessionEvents(session: Session): readonly SessionEvent[] {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- test-only durable log inspection
  return session.snapshotEvents()
}

function eventsOf<T extends SessionEvent['type']>(session: Session, type: T): EventOf<T>[] {
  return readSessionEvents(session).filter((event): event is EventOf<T> => event.type === type)
}

function findEvent(session: Session, seq: SessionSeq): SessionEvent | undefined {
  return readSessionEvents(session).find(event => event.seq === seq)
}

function findToolResult(session: Session, callId: string): EventOf<'tool/result'> {
  const result = readSessionEvents(session).find((event): event is EventOf<'tool/result'> =>
    event.type === 'tool/result' && String(event.data.message.toolCallId) === callId
  )
  assert.ok(result, `missing persisted tool result for call ${callId}`)
  return result
}

function textOfBlocks(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

function textOfMessages(messages: readonly Message[]): string {
  return messages.map(message => textOfBlocks(message.content)).join('\n')
}

function wireText(content: WireChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return content.map(part => typeof part.text === 'string' ? part.text : '').join('')
}

function wireTextOfRequest(request: CapturedChatRequest): string {
  return (request.messages ?? []).map(message => wireText(message.content)).join('\n')
}

function contentTool(name: string, content: string) {
  return defineTool({
    name,
    description: `Return the persisted ${name} fixture content.`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    execute() {
      return Promise.resolve({ content })
    },
  })
}

function registerFixtureTools(agentCtx: Context): void {
  agentCtx.tools.register(contentTool(SELF_READ_TOOL, SELF_READ_CONTENT))
  agentCtx.tools.register(contentTool(PREVIEW_TOOL, PREVIEW_CONTENT))
}

function scriptedReplies(selfCallId: string, previewCallId: string): readonly FixtureReply[] {
  return [
    {
      toolCalls: [
        { id: selfCallId, name: SELF_READ_TOOL, arguments: '{}' },
        { id: previewCallId, name: PREVIEW_TOOL, arguments: '{}' },
      ],
    },
    { content: 'Self-read and preview tool results are persisted.' },
    { content: SUMMARY_CONTENT },
  ]
}

/**
 * Read the profile-mounted `ctx.compaction` service. The app does not depend on
 * the compaction package, so the test supplies the minimal structural face it
 * invokes instead of importing the DSH implementation type.
 */
function requireCompaction(ctx: Context): CompactionServiceLike {
  const service: unknown = (ctx as Context & { readonly compaction?: unknown }).compaction
  if (typeof service !== 'object' || service === null || !('compactNow' in service) || typeof service.compactNow !== 'function') {
    throw new Error('the DSH profile must expose ctx.compaction')
  }
  return service as unknown as CompactionServiceLike
}

void test('alpha2 compaction invalidates context-epoch receipts on resume and surface replacement', { timeout: 180_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-compaction-work-'))
  const home = await mkdtemp(join(tmpdir(), 'singularity-compaction-home-'))
  let fixture: ChatCompletionsFixture | undefined
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  let handle: AgentHandle | undefined
  let resumed: AgentHandle | undefined
  try {
    const selfCallId = `call-self-${randomUUID()}`
    const previewCallId = `call-preview-${randomUUID()}`
    fixture = await startChatCompletionsFixture(scriptedReplies(selfCallId, previewCallId))
    spike = await bootSpikeProfile({ home, baseURL: fixture.baseURL, apiKey: 'fixture-key' })
    const ctx = spike.ctx
    const setup = (agentCtx: Context): void => {
      registerFixtureTools(agentCtx)
    }
    const agentOptions = {
      provider: 'singularity-local',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: ReasoningEffortId('max'),
    } satisfies AgentOptions

    const sessionId = SessionId(`s1-e-compaction-${String(process.pid)}-${String(Date.now())}`)
    handle = await ctx.agents.create({ sessionId, meta: { cwd: workspace }, agentOptions, setup })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: INITIAL_PROMPT }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    assert.equal(fixture.requests.length, 2, 'the tool turn and its completion must each make one model request')

    const session = handle.agent.session
    const selfResult = findToolResult(session, selfCallId)
    const previewResult = findToolResult(session, previewCallId)
    assert.equal(textOfBlocks(selfResult.data.message.content), SELF_READ_CONTENT)
    assert.equal(textOfBlocks(previewResult.data.message.content), PREVIEW_CONTENT)
    assert.equal(selfResult.data.message.isError, false)
    assert.equal(previewResult.data.message.isError, false)

    const selfReceipt = issueContextEpochReceipt(session, selfResult.seq)
    const previewReceipt = issueContextEpochReceipt(session, previewResult.seq)
    const epochBeforeDispose = deriveContextEpoch(session)
    assert.equal(selfReceipt.sessionId, sessionId)
    assert.equal(selfReceipt.epoch, epochBeforeDispose)
    assert.equal(previewReceipt.sessionId, sessionId)
    assert.equal(previewReceipt.epoch, epochBeforeDispose)
    assert.equal(evaluateContextEpochReceipt(session, selfReceipt).current, true)
    assert.equal(evaluateContextEpochReceipt(session, previewReceipt).current, true)
    assert.ok(session.surface.nodes.includes(selfResult.seq))
    assert.ok(session.surface.nodes.includes(previewResult.seq))

    assert.equal(await ctx.sessions.flush(session), true)
    await handle.dispose()
    handle = undefined
    assert.equal(ctx.agents.get(sessionId), undefined)

    const requestsAtResume = fixture.requests.length
    resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    await resumed.agent.whenIdle()
    assert.equal(fixture.requests.length, requestsAtResume, 'resume must not purchase a model request')

    const resumedSession = resumed.agent.session
    const epochAfterResume = deriveContextEpoch(resumedSession)
    assert.notEqual(epochAfterResume, epochBeforeDispose, 'session/end-seed must open a new context epoch')
    assert.ok(findEvent(resumedSession, selfResult.seq), 'the old tool result must still exist in the raw log')
    assert.ok(findEvent(resumedSession, previewResult.seq), 'the old preview must still exist in the raw log')
    assert.ok(resumedSession.surface.nodes.includes(selfResult.seq), 'the old tool result remains surface-visible after resume')
    assert.ok(resumedSession.surface.nodes.includes(previewResult.seq), 'the old preview remains surface-visible after resume')

    for (const receipt of [selfReceipt, previewReceipt]) {
      assert.deepEqual(evaluateContextEpochReceipt(resumedSession, receipt), {
        current: false,
        sessionMatches: true,
        epochMatches: false,
        digestMatches: true,
        eventExists: true,
        surfaceMember: true,
      })
    }

    const surfaceBeforeClear = [...resumedSession.surface.nodes]
    const requestsBeforeClear = fixture.requests.length
    const turnsBeforeClear = eventsOf(resumedSession, 'turn/start').length
    const nextTurnText = 'pending next-turn fixture input'
    const nextStepText = 'pending next-step fixture input'
    resumed.agent.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: nextTurnText }],
      source: { kind: 'user' },
    }))
    resumed.agent.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: nextStepText }],
      source: { kind: 'user' },
    }))
    assert.equal(resumed.agent.inbox.nextTurn.length, 1)
    assert.equal(resumed.agent.inbox.nextStep.length, 1)
    resumed.agent.inbox.clear()
    await resumed.agent.whenIdle()
    assert.equal(resumed.agent.inbox.nextTurn.length, 0)
    assert.equal(resumed.agent.inbox.nextStep.length, 0)
    const canceledSplices = eventsOf(resumedSession, 'agent/inbox/spliced')
      .filter(event => event.data.outcome === 'canceled')
    assert.equal(canceledSplices.length, 2, 'clear must durably cancel both pending lists')
    assert.equal(fixture.requests.length, requestsBeforeClear, 'inbox.clear must not purchase a model request')
    assert.equal(eventsOf(resumedSession, 'turn/start').length, turnsBeforeClear, 'inbox.clear must not open a turn')
    const admittedUserText = eventsOf(resumedSession, 'user/message')
      .map(event => textOfBlocks(event.data.content))
      .join('\n')
    assert.equal(admittedUserText.includes(nextTurnText), false, 'cleared next-turn input must not be admitted')
    assert.equal(admittedUserText.includes(nextStepText), false, 'cleared next-step input must not be admitted')
    assert.equal(deriveContextEpoch(resumedSession), epochAfterResume, 'inbox.clear must not change the context epoch')
    assert.deepEqual([...resumedSession.surface.nodes], surfaceBeforeClear, 'inbox.clear must not change the surface')
    assert.equal(evaluateContextEpochReceipt(resumedSession, selfReceipt).current, false)

    const compaction = requireCompaction(ctx)
    const requestsBeforeCompaction = fixture.requests.length
    const epochBeforeCompaction = deriveContextEpoch(resumedSession)
    const result = await compaction.compactNow(resumed.agent, new AbortController().signal)
    assert.ok(result, 'compactNow must compact the persisted conversation')
    // Request count comes from actual HTTP calls, not request/header log events.
    assert.equal(fixture.requests.length, requestsBeforeCompaction + 1, 'the summarizer must make exactly one additional model request')
    assert.ok(result.startSeq < result.summarySeq && result.summarySeq < result.endSeq)

    const startEvent = findEvent(resumedSession, result.startSeq)
    assert.ok(startEvent?.type === 'compaction/start')
    const summaryEvent = findEvent(resumedSession, result.summarySeq)
    assert.ok(summaryEvent?.type === 'compaction/summary')
    const endEvent = findEvent(resumedSession, result.endSeq)
    assert.ok(endEvent?.type === 'compaction/end')
    assert.equal(startEvent.data.compactionId, result.compactionId)
    assert.equal(summaryEvent.data.compactionId, result.compactionId)
    assert.equal(endEvent.data.compactionId, result.compactionId)
    assert.equal(endEvent.data.error, undefined)
    assert.deepEqual([...summaryEvent.data.shadowedSeqs], [...result.shadowedSeqs])
    assert.ok(result.shadowedSeqs.includes(selfResult.seq), 'compaction must shadow the self-read receipt source')
    assert.ok(result.shadowedSeqs.includes(previewResult.seq), 'compaction must shadow the preview receipt source')

    const summarizerRequest = fixture.requests.at(-1)
    assert.ok(summarizerRequest)
    const summarizerWireText = wireTextOfRequest(summarizerRequest)
    assert.ok(summarizerWireText.includes(SELF_READ_MARKER), 'the summarizer must replay the persisted self-read content')
    assert.ok(summarizerWireText.includes(PREVIEW_MARKER), 'the summarizer must replay the persisted preview content')
    const [summarizerInstruction] = (summarizerRequest.messages ?? []).slice(-1)
    assert.ok(summarizerInstruction)
    assert.match(wireText(summarizerInstruction.content), /acting as a compaction engine/)

    const epochAfterCompaction = deriveContextEpoch(resumedSession)
    assert.notEqual(epochAfterCompaction, epochBeforeCompaction, 'a successful compaction/end must open a new context epoch')
    assert.equal(eventsOf(resumedSession, 'compaction/start').length, 1)
    assert.equal(eventsOf(resumedSession, 'compaction/summary').length, 1)
    assert.equal(eventsOf(resumedSession, 'compaction/end').length, 1)
    assert.equal(eventsOf(resumedSession, 'compaction/end').filter(event => event.data.error !== undefined).length, 0)
    assert.ok(!resumedSession.surface.nodes.includes(selfResult.seq), 'the self-read result must leave the current surface')
    assert.ok(!resumedSession.surface.nodes.includes(previewResult.seq), 'the preview result must leave the current surface')
    assert.ok(findEvent(resumedSession, selfResult.seq), 'the shadowed self-read result remains in the raw log')
    assert.ok(findEvent(resumedSession, previewResult.seq), 'the shadowed preview remains in the raw log')
    assert.throws(() => issueContextEpochReceipt(resumedSession, selfResult.seq), /non-surface session event/)
    const derivedText = textOfMessages(resumedSession.deriveMessages())
    assert.equal(derivedText.includes(SELF_READ_MARKER), false, 'deriveMessages must not contain the shadowed self-read text')
    assert.equal(derivedText.includes(PREVIEW_MARKER), false, 'deriveMessages must not contain the shadowed preview text')

    for (const receipt of [selfReceipt, previewReceipt]) {
      assert.deepEqual(evaluateContextEpochReceipt(resumedSession, receipt), {
        current: false,
        sessionMatches: true,
        epochMatches: false,
        digestMatches: true,
        eventExists: true,
        surfaceMember: false,
      })
    }
  } finally {
    await resumed?.dispose()
    await handle?.dispose()
    await spike?.dispose()
    await fixture?.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
