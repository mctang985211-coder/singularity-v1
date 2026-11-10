import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { createWakeMessage, deliverWakeOnceOrFail } from '@singularity/runtime'
import type { WakeRequest } from '@singularity/runtime'

import { bootSpikeProfile } from '../src/host-composition.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import type { ChatCompletionsFixture, FixtureReply } from './fixtures/chat-completions.ts'

const AGENT_OPTIONS = {
  provider: 'singularity-local',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: ReasoningEffortId('max'),
} satisfies AgentOptions
const FIXTURE_REPLY: FixtureReply = {
  content: 'wake acknowledged',
  usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
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

function userMessagesWithId(session: Session, wakeId: string): EventOf<'user/message'>[] {
  return eventsOf(session, 'user/message').filter(event => String(event.data.id) === wakeId)
}

function inboxInsertedIds(session: Session): string[] {
  return eventsOf(session, 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted.map(message => String(message.id)))
}

async function createAgent(
  ctx: Context,
  workspace: string,
  sessionId: SessionId,
): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId,
    meta: { cwd: workspace },
    agentOptions: AGENT_OPTIONS,
  })
}

async function deliverAndSettle(agent: Agent, request: WakeRequest): Promise<void> {
  assert.equal(await deliverWakeOnceOrFail(agent, request), 'sent')
  await agent.whenIdle()
}

void test('wake delivery reuses admitted wake across resume and raw followup proves the guard', { timeout: 180_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-s1d-work-'))
  const home = await mkdtemp(join(tmpdir(), 'singularity-s1d-home-'))
  const suffix = `${String(process.pid)}-${String(Date.now())}`
  const guardedSessionId = SessionId(`s1d-guarded-${suffix}`)
  const guardedWake: WakeRequest = { wakeId: `s1d-guarded-wake-${suffix}`, text: 'guarded wake' }
  const controlWake: WakeRequest = { wakeId: `s1d-control-wake-${suffix}`, text: 'control wake' }
  const pendingWake: WakeRequest = { wakeId: `s1d-pending-wake-${suffix}`, text: 'pending wake' }
  let fixture: ChatCompletionsFixture | undefined
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  let guarded: AgentHandle | undefined
  let resumed: AgentHandle | undefined
  let control: AgentHandle | undefined
  let pending: AgentHandle | undefined
  try {
    fixture = await startChatCompletionsFixture([FIXTURE_REPLY, FIXTURE_REPLY, FIXTURE_REPLY, FIXTURE_REPLY])
    spike = await bootSpikeProfile({ home, baseURL: fixture.baseURL, apiKey: 'fixture-key' })
    const ctx = spike.ctx

    guarded = await createAgent(ctx, workspace, guardedSessionId)
    await deliverAndSettle(guarded.agent, guardedWake)
    assert.equal(fixture.requests.length, 1, 'first deliver must buy exactly one external request')
    assert.equal(eventsOf(guarded.agent.session, 'turn/start').length, 1)
    const guardedTurns = eventsOf(guarded.agent.session, 'turn/end')
    assert.equal(guardedTurns.length, 1)
    assert.equal(guardedTurns[0]?.data.reason.kind, 'completed')
    assert.equal(userMessagesWithId(guarded.agent.session, guardedWake.wakeId).length, 1)

    assert.equal(await deliverWakeOnceOrFail(guarded.agent, guardedWake), 'already-admitted')
    assert.equal(fixture.requests.length, 1, 'a second deliver of an admitted wake must not request')
    assert.equal(eventsOf(guarded.agent.session, 'turn/start').length, 1)

    assert.equal(await ctx.sessions.flush(guarded.agent.session), true)
    const persistedTypes = readSessionEvents(guarded.agent.session).map(event => event.type)
    await guarded.dispose()
    guarded = undefined
    const requestsAtResume = fixture.requests.length

    resumed = await ctx.agents.resume({ resumeSessionId: guardedSessionId, agentOptions: AGENT_OPTIONS })
    assert.equal(fixture.requests.length, requestsAtResume, 'resume itself must not request')
    const resumedEvents = readSessionEvents(resumed.agent.session)
    assert.deepEqual(resumedEvents.map(event => event.type).slice(0, persistedTypes.length), persistedTypes)
    assert.ok(
      resumedEvents.slice(persistedTypes.length).every(event => event.type === 'session/end-seed'),
      'resume appends only its own seed boundary',
    )
    assert.equal(await deliverWakeOnceOrFail(resumed.agent, guardedWake), 'already-admitted')
    await resumed.agent.whenIdle()
    assert.equal(fixture.requests.length, requestsAtResume, 'post-resume deliver of the admitted wake must not request')
    assert.equal(eventsOf(resumed.agent.session, 'turn/start').length, 1)
    assert.equal(userMessagesWithId(resumed.agent.session, guardedWake.wakeId).length, 1)
    await resumed.dispose()
    resumed = undefined

    control = await createAgent(ctx, workspace, SessionId(`s1d-control-${suffix}`))
    await deliverAndSettle(control.agent, controlWake)
    assert.equal(fixture.requests.length, 2, 'control wake buys its first request')
    const controlMessage = createWakeMessage(controlWake)
    control.agent.followup(controlMessage)
    await control.agent.whenIdle()
    assert.equal(fixture.requests.length, 3, 'raw DSH followup with an admitted id buys a second request')
    assert.equal(eventsOf(control.agent.session, 'turn/start').length, 2)
    assert.equal(userMessagesWithId(control.agent.session, controlWake.wakeId).length, 2)
    const controlEventsBefore = readSessionEvents(control.agent.session).length
    assert.equal(await deliverWakeOnceOrFail(control.agent, controlWake), 'already-admitted')
    assert.equal(fixture.requests.length, 3, 'conflicting admissions must not request')
    assert.equal(readSessionEvents(control.agent.session).length, controlEventsBefore)
    assert.equal(eventsOf(control.agent.session, 'turn/start').length, 2)
    await control.dispose()
    control = undefined

    const pendingHandle = await createAgent(ctx, workspace, SessionId(`s1d-pending-${suffix}`))
    pending = pendingHandle
    const pendingMessage = createWakeMessage(pendingWake)
    pendingHandle.agent.inject(pendingMessage)
    assert.equal(pendingHandle.agent.status, 'idle')
    assert.throws(() => { pendingHandle.agent.inject(pendingMessage) }, /already pending/)
    const pendingEventsBefore = readSessionEvents(pendingHandle.agent.session).length
    await assert.rejects(
      deliverWakeOnceOrFail(pendingHandle.agent, pendingWake),
      /already pending/,
    )
    assert.equal(fixture.requests.length, 3, 'a pending wake must not request')
    assert.equal(readSessionEvents(pendingHandle.agent.session).length, pendingEventsBefore)
    assert.equal(eventsOf(pendingHandle.agent.session, 'turn/start').length, 0)
    assert.equal(userMessagesWithId(pendingHandle.agent.session, pendingWake.wakeId).length, 0)
    assert.deepEqual(inboxInsertedIds(pendingHandle.agent.session), [pendingWake.wakeId])
    assert.equal(pendingHandle.agent.inbox.remove(pendingMessage.id), true)
    assert.equal(pendingHandle.agent.inbox.nextStep.length, 0)
    await deliverAndSettle(pendingHandle.agent, pendingWake)
    assert.equal(fixture.requests.length, 4, 'a wake without a recorded message is delivered normally')
    assert.equal(userMessagesWithId(pendingHandle.agent.session, pendingWake.wakeId).length, 1)
    await pendingHandle.dispose()
    pending = undefined
  } finally {
    await pending?.dispose()
    await control?.dispose()
    await resumed?.dispose()
    await guarded?.dispose()
    await spike?.dispose()
    await fixture?.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
