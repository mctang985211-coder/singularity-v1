import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { join } from 'node:path'


import type { Context } from '@deepseek-ai/cordis'

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { parseJsonText, sealPublicReceipt } from '@singularity/protocol'
import type {
  CompositionPayload,
  Fact,
  JsonValue,
  MethodRevision,
  Ref,
  TaskContract,
  TaskContractPayload,
  sealMethodRevision,
} from '@singularity/protocol'
import { DomainStore } from '@singularity/runtime'
import type { RunVerifier, VerifierRequest } from '@singularity/runtime'
import { bootSpikeProfile, buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import type { ChatCompletionsFixture } from './fixtures/chat-completions.ts'

import {
  agentOptions,
  CRITERION_ID,
  FROZEN_OUTPUT,
  OUTPUT_ID,
  OUTPUT_PATH,
  RUN_FACT_TYPES,
  fixtureUsage,
  textDecoder,
} from './task-fixture.ts'
import type { ReplyScript, Scenario, ScriptedReply, WireRequest } from './task-fixture.ts'

export function planReply(...args: [Scenario, string, string, string]): ScriptedReply {
  void args
  const sketch = {
    v: 1,
    objective: 'Produce the declared result file and submit it.',
    levels: [
      {
        level: 0,
        purpose: 'Write the declared output.',
        likelyChildren: [],
        expectedInputs: ['input.txt'],
        expectedOutputs: [OUTPUT_PATH],
      },
      {
        level: 1,
        purpose: 'No direct children are needed.',
        likelyChildren: [],
        expectedInputs: [],
        expectedOutputs: [],
      },
    ],
    directPlan: [],
    assumptions: ['The fixture model can use the native bash tool.'],
  }
  return {
    reasoning: 'Submit the plan for the current context epoch.',
    toolCalls: [{
      id: 's3c-plan',
      name: 'singularity_plan',
      arguments: JSON.stringify({ sketch }),
    }],
    usage: fixtureUsage(1),
  }
}

export function selfReadAndPlan(
  request: WireRequest,
  index: number,
  scenario: Scenario | undefined,
  taskId: string,
  runId: string,
): ScriptedReply | undefined {
  if (index === 0) {
    return {
      reasoning: 'Read the frozen self contract before planning.',
      toolCalls: [{
        id: 's3c-read',
        name: 'singularity_read',
        arguments: JSON.stringify({ kind: 'self' }),
      }],
      usage: fixtureUsage(0),
    }
  }
  if (index === 1) {
    assert.ok(scenario, 'scenario must exist before the scripted plan step')
    const epoch = contextEpochFrom(request)
    assert.ok(epoch, 'runtime did not deliver a contextEpoch to the scripted model')
    return planReply(scenario, taskId, runId, epoch)
  }
  return undefined
}

export function writeOutputReply(): ScriptedReply {
  return {
    reasoning: 'Write the declared output through the native bash tool.',
    toolCalls: [{
      id: 's3c-bash',
      name: 'bash',
      arguments: JSON.stringify({ command: `printf %s '${FROZEN_OUTPUT}' > ${OUTPUT_PATH}` }),
    }],
    usage: fixtureUsage(2),
  }
}

export function submitReply(): ScriptedReply {
  return {
    reasoning: 'Submit the declared output to the independent verifier.',
    toolCalls: [{
      id: 's3c-submit',
      name: 'singularity_submit',
      arguments: JSON.stringify({ outputIds: [OUTPUT_ID], includeLearningDrafts: false }),
    }],
    usage: fixtureUsage(3),
  }
}

interface Harness {
  readonly spike: Awaited<ReturnType<typeof bootSpikeProfile>>
  readonly fixture: ChatCompletionsFixture
  readonly workspace: string
  readonly home: string
  readonly storeRoot: string
}

export async function withHarness(
  script: ReplyScript,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 's3c-work-'))
  const home = await mkdtemp(join(tmpdir(), 's3c-home-'))
  const storeRoot = await mkdtemp(join(tmpdir(), 's3c-store-'))
  const fixture = await startChatCompletionsFixture(script)
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  try {
    spike = await bootSpikeProfile({ home, baseURL: fixture.baseURL, apiKey: 'fixture-key' })
    await run({ spike, fixture, workspace, home, storeRoot })
  } finally {
    await spike?.dispose()
    await fixture.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(storeRoot, { recursive: true, force: true })
  }
}

interface LiveHarness {
  readonly spike: Awaited<ReturnType<typeof bootSpikeProfile>>
  readonly workspace: string
  readonly home: string
  readonly storeRoot: string
}

interface LiveCredentials {
  readonly apiKey: string
}

export function requireLiveEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when SINGULARITY_SPIKE_LIVE=1`)
  }
  return value
}

export async function assertSecretNotPersisted(directory: string, secret: string): Promise<void> {
  try {
    await access(directory)
  } catch {
    return
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const contents = await readFile(join(entry.parentPath, entry.name), 'utf8')
    assert.equal(
      contents.includes(secret),
      false,
      `live credential must not be persisted under ${directory}`,
    )
  }
}

export async function withLiveHarness(
  credentials: LiveCredentials,
  run: (harness: LiveHarness) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 's3c-live-work-'))
  const home = await mkdtemp(join(tmpdir(), 's3c-live-home-'))
  const storeRoot = await mkdtemp(join(tmpdir(), 's3c-live-store-'))
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  try {
    spike = await bootSpikeProfile({
      home,
      apiKey: credentials.apiKey,
    })
    await run({ spike, workspace, home, storeRoot })
  } finally {
    await spike?.dispose()
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(storeRoot, { recursive: true, force: true })
  }
}

export /** Counts the requests that reach the model route, per session when asked. */
function countAgentRequests(
  spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
  sessionId?: string,
): { readonly count: () => number; dispose(): void } {
  let requests = 0
  const dispose = spike.ctx.on('agent/request', (payload, next) => {
    if (sessionId === undefined || String(payload.agent.session.id) === sessionId) requests += 1
    return next()
  })
  return { count: () => requests, dispose: () => { dispose() } }
}

export /** Records committed Session events for one persisted session. */
function recordSessionEvents(
  spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
  sessionId: string,
): { readonly events: SessionEvent[]; dispose(): void } {
  const events: SessionEvent[] = []
  const dispose = spike.ctx.on('session/event', (session, event) => {
    if (String(session.id) === sessionId) events.push(event)
    return undefined
  })
  return { events, dispose: () => { dispose() } }
}

export /** Captures the dynamic context snapshot (NodeView) before the first model request. */
function captureAgentContexts(
  spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
  sessionId: string,
  contexts: string[],
): () => void {
  return spike.ctx.on('agent/created', async ({ agent }) => {
    if (String(agent.session.id) !== sessionId) return
    const assembly = await spike.ctx.systemPrompt.assemble({ scope: agent })
    contexts.push(renderContextSnapshot(assembly))
  })
}

export /** Captures the full scoped system prompt assembled by Agent setup. */
function captureAgentPrompts(
  spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
  sessionId: string,
  prompts: string[],
): () => void {
  return spike.ctx.on('agent/created', async ({ agent }) => {
    if (String(agent.session.id) !== sessionId) return
    const assembly = await spike.ctx.systemPrompt.assemble({ scope: agent })
    prompts.push(renderPrompt(assembly))
  })
}

export /** Captures the scoped DSH skill discovery set during Agent setup. */
function captureAgentSkills(
  spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
  sessionId: string,
  workspace: string,
  names: string[][],
  agents: string[],
): () => void {
  return spike.ctx.on('agent/created', async ({ agent }) => {
    if (String(agent.session.id) !== sessionId) return
    const skills = await spike.ctx.skills.list({ scope: agent, cwd: workspace })
    names.push(skills.map(skill => skill.name))
    agents.push(String(agent.session.id))
  })
}

export function toolCallNames(events: readonly SessionEvent[]): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type === 'tool/call') names.push(event.data.name)
  }
  return names
}

export function userMessageIds(events: readonly SessionEvent[]): string[] {
  return events
    .filter(event => event.type === 'user/message')
    .map(event => String(event.data.id))
}

export function compositionBase(composition: CompositionPayload): Omit<
  CompositionPayload,
  'contract' | 'dsh' | 'guidance' | 'modelRoute' | 'platformPrompt' | 'resources' | 'skills' | 'template' | 'mcpServers'
> {
  return {
    v: composition.v,
    seed: composition.seed,
  }
}

export function methodPayload(method: MethodRevision): Parameters<typeof sealMethodRevision>[0] {
  return {
    v: 1,
    id: method.id,
    ...(method.parent === undefined ? {} : { parent: method.parent }),
    ...(method.entryTemplateId === undefined ? {} : { entryTemplateId: method.entryTemplateId }),
    templates: method.templates,
    skills: method.skills,
    tools: method.tools,
  }
}

export function contractPayload(contract: TaskContract): TaskContractPayload {
  return {
    v: 1,
    taskId: contract.taskId,
    spec: contract.spec,
    origin: contract.origin,
    method: contract.method,
    template: contract.template,
    resources: contract.resources,
    acceptance: contract.acceptance,
    environment: contract.environment,
    limits: contract.limits,
  }
}

export async function currentComposition(
  ctx: Context,
  storeRoot: string,
  scenario: Scenario,
): Promise<CompositionPayload> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    return await buildSingleRunComposition(ctx, {
      store,
      id: 's3c',
      contract: scenario.contract,
      agentOptions: agentOptions(),
      base: compositionBase(scenario.composition),
    })
  } finally {
    await store.close()
  }
}

export async function readFacts(storeRoot: string): Promise<readonly Fact[]> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    return store.facts()
  } finally {
    await store.close()
  }
}

export function factsOfType<Type extends Fact['type']>(
  facts: readonly Fact[],
  type: Type,
): Extract<Fact, { readonly type: Type }>[] {
  return facts.filter((fact): fact is Extract<Fact, { readonly type: Type }> => fact.type === type)
}

export function sequenceOf(facts: readonly Fact[]): string[] {
  return facts.filter(fact => RUN_FACT_TYPES.has(fact.type)).map(fact => fact.type)
}

export async function readJson(store: DomainStore, ref: Ref, domain: 'object' | 'evidence'): Promise<JsonValue> {
  const { bytes } = await store.readObject(ref, domain)
  return parseJsonText(textDecoder.decode(bytes))
}

export function passingVerifier(
  scenario: Scenario,
  runId: string,
  workspace: string,
  calls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[],
): RunVerifier {
  return {
    provider: scenario.provider,
    async verify(request: VerifierRequest) {
      assert.equal(request.operationId, `${runId}:verify`)
      assert.equal(request.task.digest, scenario.contract.digest)
      assert.equal('workspace' in request, false, 'verifier must not receive the active workspace')
      const input = request.inputs[0]
      const output = request.outputs[0]
      assert.ok(input)
      assert.ok(output)
      const inputBytes = await request.readObject(input, 'object')
      assert.equal(textDecoder.decode(inputBytes.bytes), 'fixture input bytes\n')
      await writeFile(join(workspace, OUTPUT_PATH), 'mutated-after-submit\n', 'utf8')
      const outputBytes = await request.readObject(output, 'object')
      assert.equal(textDecoder.decode(outputBytes.bytes), FROZEN_OUTPUT)
      calls.push({ inputs: [...request.inputs], outputs: [...request.outputs] })
      return sealPublicReceipt({
        v: 1,
        provider: scenario.provider,
        operationId: request.operationId,
        contractDigest: request.task.digest,
        inputDigests: request.inputs.map(ref => ref.digest),
        outputDigests: request.outputs.map(ref => ref.digest),
        criteria: [{
          id: CRITERION_ID,
          verdict: 'pass',
          reason: 'The frozen output matches the declared fixture bytes.',
          metric: { name: 'exit', unit: 'code', value: 0 },
        }],
        exit: { code: 0, signal: null },
        timedOut: false,
      })
    },
  }
}

interface AgentSpy {
  create: number
  resume: number
  restore(): void
}

export function spyAgents(ctx: Context): AgentSpy {
  const agents = ctx.agents
  const create = agents.create.bind(agents)
  const resume = agents.resume.bind(agents)
  const spy: AgentSpy = {
    create: 0,
    resume: 0,
    restore() {
      agents.create = create
      agents.resume = resume
    },
  }
  agents.create = async options => {
    spy.create += 1
    return create(options)
  }
  agents.resume = async options => {
    spy.resume += 1
    return resume(options)
  }
  return spy
}
