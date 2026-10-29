import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { bootSpikeProfile } from '../src/host-composition.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import type { CapturedChatRequest, ChatCompletionsFixture, FixtureReply } from './fixtures/chat-completions.ts'
import { createWakeMessage, deliverWakeOnceOrFail, WakeDeliveryRefusedError } from './helpers/wake-delivery.ts'
import type { WakeRequest, WakeRefusalState } from './helpers/wake-delivery.ts'

const CRASH_CHILD_PATH = fileURLToPath(new URL('./fixtures/wake-crash-child.ts', import.meta.url))
const AGENT_OPTIONS = {
  provider: 'singularity-local',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: ReasoningEffortId('max'),
} satisfies AgentOptions
const FIXTURE_REPLY: FixtureReply = {
  content: 'wake acknowledged',
  usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
}
const CHILD_READY_TIMEOUT_MS = 20_000
const CHILD_REQUEST_TIMEOUT_MS = 20_000

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

function isWakeRefusal(state: WakeRefusalState): (error: unknown) => boolean {
  return error => error instanceof WakeDeliveryRefusedError && error.state === state
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

interface HangingChatFixture {
  readonly baseURL: string
  readonly requests: readonly CapturedChatRequest[]
  close(): Promise<void>
}

/**
 * Local openai-completions endpoint that records the request and never
 * responds. A provider receipt is therefore a real external request, not a
 * DSH log marker.
 */
async function startHangingChatFixture(): Promise<HangingChatFixture> {
  const requests: CapturedChatRequest[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (part: string) => { body += part })
    request.on('end', () => {
      let parsed: CapturedChatRequest
      try {
        parsed = JSON.parse(body) as CapturedChatRequest
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid JSON"}')
        return
      }
      requests.push(parsed)
      // Deliberately leave the response pending: the test kills the child after receipt.
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve() })
      })
    },
  }
}

async function canAccess(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitForChild(
  check: () => boolean | Promise<boolean>,
  description: string,
  child: ChildProcess,
  stderr: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${description}: child exited (code ${String(child.exitCode)}, signal ${String(child.signalCode)}): ${stderr()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`${description}: timed out after ${String(timeoutMs)}ms: ${stderr()}`)
    }
    await delay(20)
  }
}

async function killChildAfterReceipt(child: ChildProcess): Promise<void> {
  assert.equal(child.exitCode, null, 'crash child must still be alive before SIGKILL')
  assert.equal(child.signalCode, null, 'crash child must still be alive before SIGKILL')
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, signal) => { resolve({ code, signal }) })
    child.once('error', reject)
  })
  assert.equal(child.kill('SIGKILL'), true)
  const outcome = await exited
  assert.equal(outcome.signal, 'SIGKILL')
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => { resolve() })
    child.once('error', () => { resolve() })
  })
  child.kill('SIGKILL')
  await exited
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
    fixture = await startChatCompletionsFixture([FIXTURE_REPLY, FIXTURE_REPLY, FIXTURE_REPLY, FIXTURE_REPLY, FIXTURE_REPLY])
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
    await assert.rejects(
      deliverWakeOnceOrFail(control.agent, controlWake),
      isWakeRefusal('corrupt'),
    )
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
      isWakeRefusal('pending'),
    )
    assert.equal(fixture.requests.length, 3, 'a pending wake must not request')
    assert.equal(readSessionEvents(pendingHandle.agent.session).length, pendingEventsBefore)
    assert.equal(eventsOf(pendingHandle.agent.session, 'turn/start').length, 0)
    assert.equal(userMessagesWithId(pendingHandle.agent.session, pendingWake.wakeId).length, 0)
    assert.deepEqual(inboxInsertedIds(pendingHandle.agent.session), [pendingWake.wakeId])
    assert.equal(pendingHandle.agent.inbox.remove(pendingMessage.id), true)
    assert.equal(pendingHandle.agent.inbox.nextStep.length, 0)
    assert.equal(await deliverWakeOnceOrFail(pendingHandle.agent, pendingWake), 'sent')
    await pendingHandle.agent.whenIdle()
    assert.equal(fixture.requests.length, 4, 'a removed, never-admitted wake can be sent once')
    assert.equal(eventsOf(pendingHandle.agent.session, 'turn/start').length, 1)
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

void test('crash after provider receipt resumes interrupted without resending', { timeout: 180_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-s1d-crash-work-'))
  const home = await mkdtemp(join(tmpdir(), 'singularity-s1d-crash-home-'))
  const suffix = `${String(process.pid)}-${String(Date.now())}`
  const pendingSessionId = SessionId(`s1d-crash-pending-${suffix}`)
  const crashSessionId = SessionId(`s1d-crash-receipt-${suffix}`)
  const pendingWake: WakeRequest = { wakeId: `s1d-crash-pending-wake-${suffix}`, text: 'pending crash wake' }
  const crashWake: WakeRequest = { wakeId: `s1d-crash-wake-${suffix}`, text: 'receipt crash wake' }
  const readyFile = join(home, 's1d-pending-ready')
  let fixture: HangingChatFixture | undefined
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  let pending: AgentHandle | undefined
  let crash: AgentHandle | undefined
  let child: ChildProcess | undefined
  try {
    fixture = await startHangingChatFixture()
    let childStderr = ''
    child = spawn(process.execPath, [CRASH_CHILD_PATH], {
      env: {
        ...process.env,
        S1_D_HOME: home,
        S1_D_BASE_URL: fixture.baseURL,
        S1_D_API_KEY: 'fixture-key',
        S1_D_WORKSPACE: workspace,
        S1_D_READY_FILE: readyFile,
        S1_D_PENDING_SESSION_ID: pendingSessionId,
        S1_D_CRASH_SESSION_ID: crashSessionId,
        S1_D_PENDING_WAKE_ID: pendingWake.wakeId,
        S1_D_PENDING_WAKE_TEXT: pendingWake.text,
        S1_D_CRASH_WAKE_ID: crashWake.wakeId,
        S1_D_CRASH_WAKE_TEXT: crashWake.text,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { childStderr += chunk })
    const stderr = () => childStderr

    await waitForChild(
      () => canAccess(readyFile),
      'pending wake persistence',
      child,
      stderr,
      CHILD_READY_TIMEOUT_MS,
    )
    await waitForChild(
      () => fixture !== undefined && fixture.requests.length >= 1,
      'provider receipt before SIGKILL',
      child,
      stderr,
      CHILD_REQUEST_TIMEOUT_MS,
    )
    assert.equal(fixture.requests.length, 1, 'child must have made exactly one external request before SIGKILL')
    await killChildAfterReceipt(child)
    child = undefined
    const requestsAfterCrash = fixture.requests.length

    spike = await bootSpikeProfile({ home, baseURL: fixture.baseURL, apiKey: 'fixture-key' })
    const ctx = spike.ctx

    pending = await ctx.agents.resume({ resumeSessionId: pendingSessionId, agentOptions: AGENT_OPTIONS })
    assert.equal(fixture.requests.length, requestsAfterCrash, 'resuming a pending-only session must not request')
    assert.equal(eventsOf(pending.agent.session, 'turn/start').length, 0)
    assert.equal(eventsOf(pending.agent.session, 'request/header').length, 0)
    assert.equal(userMessagesWithId(pending.agent.session, pendingWake.wakeId).length, 0)
    assert.deepEqual(inboxInsertedIds(pending.agent.session), [pendingWake.wakeId])
    assert.ok(
      eventsOf(pending.agent.session, 'session/end-seed').length >= 1,
      'resume appends the seed boundary',
    )
    const pendingEventsBefore = readSessionEvents(pending.agent.session).length
    await assert.rejects(
      deliverWakeOnceOrFail(pending.agent, pendingWake),
      isWakeRefusal('pending'),
    )
    assert.equal(fixture.requests.length, requestsAfterCrash, 'pending wake recovery must fail closed without requesting')
    assert.equal(readSessionEvents(pending.agent.session).length, pendingEventsBefore)
    await pending.dispose()
    pending = undefined

    crash = await ctx.agents.resume({ resumeSessionId: crashSessionId, agentOptions: AGENT_OPTIONS })
    assert.equal(fixture.requests.length, requestsAfterCrash, 'resuming the interrupted session must not request')
    const crashEvents = readSessionEvents(crash.agent.session)
    assert.equal(eventsOf(crash.agent.session, 'turn/start').length, 1)
    const turnEnds = eventsOf(crash.agent.session, 'turn/end')
    assert.equal(turnEnds.length, 1)
    assert.equal(turnEnds[0]?.data.reason.kind, 'interrupted')
    assert.equal(eventsOf(crash.agent.session, 'step/start').length, 1)
    assert.equal(eventsOf(crash.agent.session, 'step/end').length, 1)
    assert.equal(eventsOf(crash.agent.session, 'assistant/message').length, 0)
    assert.equal(eventsOf(crash.agent.session, 'assistant/attempt').length, 0)
    assert.equal(eventsOf(crash.agent.session, 'request/header').length, 1)
    assert.equal(userMessagesWithId(crash.agent.session, crashWake.wakeId).length, 1)
    assert.ok(crashEvents.some(event => event.type === 'session/end-seed'))
    const crashEventsBefore = readSessionEvents(crash.agent.session).length
    assert.equal(await deliverWakeOnceOrFail(crash.agent, crashWake), 'already-admitted')
    await crash.agent.whenIdle()
    assert.equal(fixture.requests.length, requestsAfterCrash, 'delivery after receipt crash must not request again')
    assert.equal(readSessionEvents(crash.agent.session).length, crashEventsBefore)
    assert.equal(eventsOf(crash.agent.session, 'request/header').length, 1)
    assert.equal(eventsOf(crash.agent.session, 'turn/start').length, 1)
    assert.equal(eventsOf(crash.agent.session, 'turn/end').length, 1)
    await crash.dispose()
    crash = undefined
  } finally {
    if (child !== undefined) await terminateChild(child)
    await crash?.dispose()
    await pending?.dispose()
    await spike?.dispose()
    await fixture?.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
