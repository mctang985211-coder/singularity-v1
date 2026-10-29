import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import { bootSpikeProfile } from '../src/host-composition.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import type { CapturedChatRequest, ChatCompletionsFixture, FixtureReply, WireChatMessage, WireTool } from './fixtures/chat-completions.ts'

const FINISH_TOOL = 'spike_finish'
const SKILL_NAME = 'spike-skill'
const SKILL_DESCRIPTION = 'Fixture skill used to verify scoped runtime skill discovery.'
const SKILL_CONTENT = '# Spike Skill\n\nUse this skill while validating the scoped host composition.'
const SYSTEM_TEXT = 'Scoped system section: follow the host composition checks.'
const CONTEXT_TEXT = 'Required context: scoped composition is active for this agent.'
const ALLOW_MESSAGE = 'fixture-complete'
const DENY_MESSAGE = 'deny-fixture-call'
const DENIAL_REASON = `${FINISH_TOOL} denied by scoped guard`
const ALLOW_CALL_ID = 'call-spike-finish-allow'
const DENY_CALL_ID = 'call-spike-finish-deny'
const BASH_CALL_ID = 'call-spike-bash'
const EXPECTED_TOOLS = ['skill', FINISH_TOOL, 'working_directory'] as const
const FIXTURE_USAGE = {
  inputTokens: 103,
  outputTokens: 17,
  totalTokens: 140,
  cacheReadTokens: 20,
} as const
const PROMPT_TEXT = [
  'Run the host composition check in one tool-call batch:',
  `1. Call ${FINISH_TOOL} with message "${ALLOW_MESSAGE}".`,
  `2. Call ${FINISH_TOOL} with message "${DENY_MESSAGE}".`,
  '3. Call bash with command "printf should-not-run".',
  'Do not answer in text.',
].join('\n')

interface CompositionState {
  setupRuns: number
  readonly finishBodies: string[]
}

function messageOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('message' in args)) return undefined
  const message = args.message
  return typeof message === 'string' ? message : undefined
}

function denialReason(execution: Readonly<ToolExecution>): string | undefined {
  if (execution.name !== FINISH_TOOL) return undefined
  const message = messageOf(execution.arguments)
  return message !== undefined && message.includes('deny') ? DENIAL_REASON : undefined
}

function createFinishTool(state: CompositionState) {
  return defineTool({
    name: FINISH_TOOL,
    description: 'Record the fixture result and conclude the current agent turn.',
    parameters: {
      message: { type: 'string', required: true, description: 'Short completion message.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute(args, exec) {
      state.finishBodies.push(args.message)
      exec.concludeTurn()
      return Promise.resolve({ message: args.message })
    },
  })
}

async function registerComposition(agentCtx: Context, state: CompositionState): Promise<void> {
  agentCtx.systemPrompt.section({
    name: 'spike:system',
    order: 250,
    text: SYSTEM_TEXT,
  })
  agentCtx.systemPrompt.context({
    name: 'spike:required-context',
    order: 250,
    text: CONTEXT_TEXT,
    required: true,
  })
  await agentCtx.inject(['skills'], skillsCtx => {
    skillsCtx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: SKILL_CONTENT,
      source: 'runtime',
    })
  })
  agentCtx.tools.register(createFinishTool(state))
  agentCtx.tools.restrict({ allow: ['working_directory', 'skill'] })
  agentCtx.tools.guard(execution => denialReason(execution))
  state.setupRuns += 1
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

function textOfBlocks(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

function textOfMessage(message: Pick<UserMessage, 'content'>): string {
  return textOfBlocks(message.content)
}

function sourceKind(message: UserMessage): string {
  const source: unknown = message.source
  return isRecord(source) && typeof source.kind === 'string' ? source.kind : ''
}

function wireText(content: WireChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return content.map(part => typeof part.text === 'string' ? part.text : '').join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wireToolNames(tools: readonly WireTool[]): string[] {
  return tools
    .map(tool => tool.function?.name)
    .filter((name): name is string => typeof name === 'string')
    .sort()
}

function assertFinishParameters(parameters: unknown): void {
  assert.ok(isRecord(parameters), 'spike_finish must declare a JSON-schema parameter object')
  const properties = parameters.properties
  assert.ok(isRecord(properties), 'spike_finish must declare parameter properties')
  const message = properties.message
  assert.ok(isRecord(message), 'spike_finish must declare a message parameter')
  assert.equal(message.type, 'string')
}

async function assertComposition(ctx: Context, agent: Agent, workspace: string): Promise<void> {
  const declaredTools = ctx.tools.definitions(agent).map(definition => definition.name).sort()
  assert.deepEqual(declaredTools, [...EXPECTED_TOOLS].sort())
  const schemas = ctx.tools.schemas(agent)
  assert.deepEqual(schemas.map(schema => schema.name).sort(), [...EXPECTED_TOOLS].sort())

  const skills: SkillSummary[] = await ctx.skills.list({ scope: agent, cwd: workspace })
  assert.deepEqual(skills.map(skill => skill.name), [SKILL_NAME])
  const skill = await ctx.skills.get(SKILL_NAME, { scope: agent, cwd: workspace })
  assert.equal(skill?.content, SKILL_CONTENT)

  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  assert.ok(assembly.sections.some(section => section.name === 'spike:system' && section.text === SYSTEM_TEXT))
  assert.ok(assembly.contexts.some(context => context.name === 'spike:required-context' && context.text === CONTEXT_TEXT))
  assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [...EXPECTED_TOOLS].sort())
}

function assertRequestHeader(session: Session): void {
  const [headerEvent] = eventsOf(session, 'request/header')
  assert.ok(headerEvent)
  const { config, tools } = headerEvent.data.header
  assert.equal(config.provider, 'singularity-local')
  assert.equal(config.model, 'deepseek-v4.1-flash')
  assert.equal(config.reasoningEffort, 'max')
  assert.deepEqual(tools?.map(tool => tool.name).sort(), [...EXPECTED_TOOLS].sort())
}

function assertPersistedComposition(session: Session): void {
  const systems = eventsOf(session, 'system/message')
  assert.ok(systems.some(event => textOfBlocks(event.data.message.content).includes(SYSTEM_TEXT)))

  const users = eventsOf(session, 'user/message')
  assert.ok(users.some(event => sourceKind(event.data) === 'runtime-context' && textOfMessage(event.data).includes(CONTEXT_TEXT)))
  assert.ok(users.some(event => sourceKind(event.data) === 'skill-catalog' && textOfMessage(event.data).includes(SKILL_NAME) && textOfMessage(event.data).includes('<available_skills>')))
}

function assertUsage(session: Session, exact: boolean): void {
  const [assistant] = eventsOf(session, 'assistant/message')
  assert.ok(assistant)
  const usage = assistant.data.usage
  assert.ok(usage)
  if (exact) {
    assert.equal(usage.inputTokens, FIXTURE_USAGE.inputTokens)
    // The pi-ai adapter folds reasoning tokens into outputTokens; the fixture's
    // 17 completion tokens include its 7 reasoning tokens.
    assert.equal(usage.outputTokens, FIXTURE_USAGE.outputTokens)
    assert.equal(usage.totalTokens, FIXTURE_USAGE.totalTokens)
    assert.equal(usage.cacheReadTokens, FIXTURE_USAGE.cacheReadTokens)
    assert.ok(assistant.data.message.content.some(block => block.type === 'reasoning' && block.text === 'fixture-reasoning'))
  } else {
    assert.ok(usage.inputTokens > 0)
    assert.ok(usage.outputTokens > 0)
  }
}

function assertSingleCompletedStep(session: Session): void {
  assert.equal(eventsOf(session, 'turn/start').length, 1)
  assert.equal(eventsOf(session, 'turn/end').length, 1)
  assert.equal(eventsOf(session, 'step/start').length, 1)
  assert.equal(eventsOf(session, 'step/end').length, 1)
  assert.equal(eventsOf(session, 'assistant/message').length, 1)
  assert.equal(eventsOf(session, 'request/header').length, 1)
  const [turnEnd] = eventsOf(session, 'turn/end')
  assert.ok(turnEnd)
  assert.equal(turnEnd.data.reason.kind, 'completed')
}

function assertToolOutcomes(session: Session, state: CompositionState): void {
  const calls = new Map(eventsOf(session, 'tool/call').map(event => [String(event.data.callId), event.data]))
  assert.equal(calls.get(ALLOW_CALL_ID)?.name, FINISH_TOOL)
  assert.equal(calls.get(DENY_CALL_ID)?.name, FINISH_TOOL)
  assert.equal(calls.get(BASH_CALL_ID)?.name, 'bash')

  const results = new Map(eventsOf(session, 'tool/result').map(event => [String(event.data.message.toolCallId), event.data]))

  const allowed = results.get(ALLOW_CALL_ID)
  assert.ok(allowed)
  assert.equal(allowed.message.isError, false)
  assert.equal(textOfBlocks(allowed.message.content), ALLOW_MESSAGE)

  const denied = results.get(DENY_CALL_ID)
  assert.ok(denied)
  assert.equal(denied.message.isError, true)
  assert.equal(denied.error, undefined)
  assert.equal(textOfBlocks(denied.message.content), `Error: ${DENIAL_REASON}`)

  const bash = results.get(BASH_CALL_ID)
  assert.ok(bash)
  assert.equal(bash.message.isError, true)
  const bashError = bash.error
  assert.ok(bashError)
  assert.equal(bashError.name, 'ToolNotFoundError')
  assert.equal(bashError.code, 'UNKNOWN_TOOL')

  assert.deepEqual(state.finishBodies, [ALLOW_MESSAGE])
}

function assertWireRequest(request: CapturedChatRequest): void {
  assert.equal(request.reasoning_effort, 'max')
  assert.equal(request.model, 'deepseek-v4.1-flash')

  const messages = request.messages ?? []
  assert.ok(messages.some(message => message.role === 'system' && wireText(message.content).includes(SYSTEM_TEXT)))
  assert.ok(messages.some(message => message.role === 'user' && wireText(message.content).includes(CONTEXT_TEXT)))
  assert.ok(messages.some(message => message.role === 'user' && wireText(message.content).includes('<available_skills>') && wireText(message.content).includes(SKILL_NAME)))
  assert.ok(messages.some(message => message.role === 'user' && wireText(message.content).includes('one tool-call batch')))

  const tools = request.tools ?? []
  assert.deepEqual(wireToolNames(tools), [...EXPECTED_TOOLS].sort())
  const finish = tools.find(tool => tool.function?.name === FINISH_TOOL)
  assert.ok(finish)
  assertFinishParameters(finish.function?.parameters)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when SINGULARITY_SPIKE_LIVE=1`)
  }
  return value
}

async function assertSecretNotPersisted(directory: string, secret: string): Promise<void> {
  try {
    await access(directory)
  } catch {
    return
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const contents = await readFile(join(entry.parentPath, entry.name), 'utf8')
    assert.equal(contents.includes(secret), false, `credential must not be persisted under ${directory}`)
  }
}

void test('alpha2 agent composition keeps declarations, dispatch, persistence, and resume aligned', { timeout: 180_000 }, async () => {
  const live = process.env.SINGULARITY_SPIKE_LIVE === '1'
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-spike-work-'))
  const home = await mkdtemp(join(tmpdir(), 'singularity-spike-home-'))
  let fixture: ChatCompletionsFixture | undefined
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  let handle: AgentHandle | undefined
  let resumed: AgentHandle | undefined
  let disposeCreatedListener: (() => boolean) | undefined
  try {
    let baseURL: string
    let apiKey: string
    if (live) {
      baseURL = requireEnv('SINGULARITY_SPIKE_BASE_URL')
      apiKey = requireEnv('SINGULARITY_SPIKE_API_KEY')
    } else {
      const replies: readonly FixtureReply[] = [
        {
          reasoning: 'fixture-reasoning',
          toolCalls: [
            { id: ALLOW_CALL_ID, name: FINISH_TOOL, arguments: JSON.stringify({ message: ALLOW_MESSAGE }) },
            { id: DENY_CALL_ID, name: FINISH_TOOL, arguments: JSON.stringify({ message: DENY_MESSAGE }) },
            { id: BASH_CALL_ID, name: 'bash', arguments: JSON.stringify({ command: 'printf should-not-run' }) },
          ],
          usage: {
            promptTokens: 123,
            completionTokens: 17,
            totalTokens: 140,
            cachedTokens: 20,
            reasoningTokens: 7,
          },
        },
        { content: 'unexpected second request' },
      ]
      fixture = await startChatCompletionsFixture(replies)
      baseURL = fixture.baseURL
      apiKey = 'fixture-key'
    }

    spike = await bootSpikeProfile({ home, baseURL, apiKey })
    assert.equal(spike.dshVersion, '0.2.2-alpha.2')
    const ctx = spike.ctx
    assert.ok(ctx.llm.listProviders().some(provider => provider.id === 'singularity-local'), 'profile must mount the singularity-local pi-ai route')

    const state: CompositionState = { setupRuns: 0, finishBodies: [] }
    const setup: AgentSetup = async agentCtx => {
      await registerComposition(agentCtx, state)
    }
    const agentOptions = {
      provider: 'singularity-local',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: ReasoningEffortId('max'),
    } satisfies AgentOptions

    const sessionId = SessionId(`s1-a-agent-test-${String(process.pid)}-${String(Date.now())}`)
    const createdSnapshots: number[] = []
    disposeCreatedListener = ctx.on('agent/created', ({ agent }) => {
      if (agent.session.id === sessionId) createdSnapshots.push(state.setupRuns)
      return undefined
    })
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace },
      agentOptions,
      setup,
    })

    assert.equal(state.setupRuns, 1)
    assert.deepEqual(createdSnapshots, [1])
    assert.equal(ctx.agents.get(sessionId), handle.agent)
    assert.equal(handle.agent.status, 'idle')
    assert.equal(fixture?.requests.length ?? 0, 0)
    await assertComposition(ctx, handle.agent, workspace)

    const prompt = createUserMessage({
      content: [{ type: 'text', text: PROMPT_TEXT }],
      source: { kind: 'user' },
    })
    handle.agent.followup(prompt)
    await handle.agent.whenIdle()

    assertSingleCompletedStep(handle.agent.session)
    assertRequestHeader(handle.agent.session)
    assertPersistedComposition(handle.agent.session)
    assertUsage(handle.agent.session, !live)
    assertToolOutcomes(handle.agent.session, state)

    if (fixture !== undefined) {
      assert.equal(fixture.requests.length, 1)
      const [request] = fixture.requests
      assert.ok(request)
      assertWireRequest(request)
    }

    assert.equal(await ctx.sessions.flush(handle.agent.session), true)
    const persistedHistory = readSessionEvents(handle.agent.session)
    const persistedTypes = persistedHistory.map(event => event.type)
    await handle.dispose()
    handle = undefined
    assert.equal(ctx.agents.get(sessionId), undefined)

    await assertSecretNotPersisted(home, apiKey)
    const requestsAtResume = fixture?.requests.length ?? 0

    resumed = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions,
      setup,
    })
    assert.equal(state.setupRuns, 2)
    assert.deepEqual(createdSnapshots, [1, 2])
    assert.equal(ctx.agents.get(sessionId), resumed.agent)

    const restoredHistory = readSessionEvents(resumed.agent.session)
    assert.deepEqual(restoredHistory.map(event => event.type).slice(0, persistedTypes.length), persistedTypes)
    assert.deepEqual(restoredHistory.slice(0, persistedHistory.length), persistedHistory)
    for (const restoredMarker of restoredHistory.slice(persistedHistory.length)) {
      assert.equal(restoredMarker.type, 'session/end-seed')
    }

    const restoredCountAtResume = restoredHistory.length
    await resumed.agent.whenIdle()
    assert.equal(fixture?.requests.length ?? 0, requestsAtResume)
    assert.equal(readSessionEvents(resumed.agent.session).length, restoredCountAtResume)
    assertSingleCompletedStep(resumed.agent.session)
    assertRequestHeader(resumed.agent.session)
    assertPersistedComposition(resumed.agent.session)
    assertUsage(resumed.agent.session, !live)
    assertToolOutcomes(resumed.agent.session, state)
    await assertComposition(ctx, resumed.agent, workspace)
  } finally {
    disposeCreatedListener?.()
    await resumed?.dispose()
    await handle?.dispose()
    await spike?.dispose()
    await fixture?.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
