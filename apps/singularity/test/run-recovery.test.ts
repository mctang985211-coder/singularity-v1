import assert from 'node:assert/strict'
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

import {
  admitRootTask,
  canonicalize,
  computeDigest,
  evidenceSchema,
  executionRecordSchema,
  parseJsonText,
  parseProtocolValue,
  planningSketchSchema,
  publicReceiptSchema,
  seal,
  sealMethodRevision,
  sealPublicReceipt,
  sealTaskContract,
  submissionManifestSchema,
  taskTemplateSchema,
  validateEvidence,
  validatePublicReceipt,
} from '@singularity/protocol'
import type {
  CompositionPayload,
  ExecutionRecord,
  Fact,
  FactActor,
  JsonValue,
  MethodRevision,
  NormalizedCommand,
  Ref,
  RootAdmissionInput,
  SkillAsset,
  SubmissionManifest,
  TaskContract,
  TaskContractPayload,
  ToolAsset,
} from '@singularity/protocol'
import {
  CommandService,
  DomainStore,
  DomainStoreError,
  JOURNAL_FILENAME,
  METHOD_GUIDANCE_SECTION,
  OBJECTS_DIRNAME,
  createWakeMessage,
  executeSingleRun,
  freezeSubmission,
  initialContextEpoch,
  resumeSingleRun,
  retrySingleRun,
  startWakeText,
} from '@singularity/runtime'
import type {
  FrozenSubmission,
  RunVerifier,
  SingleRunAdmission,
  VerifierRequest,
} from '@singularity/runtime'

import { bootSpikeProfile, buildSingleRunComposition } from '../src/host-composition.ts'
import {
  contextEpochFrom,
  messageTexts,
  startChatCompletionsFixture,
  toolSchemaNames,
  wireText,
} from './fixtures/chat-completions.ts'
import type {
  CapturedChatRequest,
  ChatCompletionReplyScript,
  ChatCompletionsFixture,
  FixtureReply,
} from './fixtures/chat-completions.ts'

const PROVIDER_ID = 'verifier:s3-c-fixture'
const CRITERION_ID = 'declared-output'
const OUTPUT_ID = 'result'
const OUTPUT_PATH = 'result.txt'
const FROZEN_OUTPUT = 'frozen-output-before-verify'
const LIVE = process.env.SINGULARITY_SPIKE_LIVE === '1'
const LIVE_TIMEOUT_MS = 1_800_000
const ACTOR: FactActor = { kind: 'runtime', id: 's3-c-test-host' }
const RUN_FACT_TYPES = new Set<string>([
  'task/admitted',
  'run/opened',
  'task/children-admitted',
  'run/submitted',
  'run/closed',
  'task/closed',
])

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

type WireRequest = CapturedChatRequest
type ScriptedReply = FixtureReply
type ReplyScript = ChatCompletionReplyScript

interface Scenario {
  readonly runAdmission: SingleRunAdmission
  readonly contract: TaskContract
  readonly method: MethodRevision
  readonly composition: CompositionPayload
  readonly provider: Ref
}

interface SkillFixture {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
  readonly extraFiles?: readonly { readonly path: string; readonly content: string }[]
}

interface McpServerFixture {
  readonly serverName: string
  readonly exposedTools: ToolAsset['server']['exposedTools']
  readonly instructions: string
  readonly capabilities: readonly string[]
  readonly source: string
  readonly entrypoint?: string
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value))
}

async function seedObject(
  store: DomainStore,
  id: string,
  value: unknown,
  domain: 'object' | 'method' = 'object',
): Promise<Ref> {
  return store.putObject(id, jsonBytes(value), domain)
}

async function seedRawTree(
  store: DomainStore,
  id: string,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<Ref> {
  const entries = []
  for (const file of files) {
    const bytes = textEncoder.encode(file.content)
    entries.push({
      path: file.path,
      bytes: bytes.byteLength,
      object: await store.putObject(`${id}:file:${file.path}`, bytes, 'object'),
    })
  }
  entries.sort((left, right) => compareBundlePath(left.path, right.path))
  const manifest = seal('object', { v: 1, kind: 'tree', files: entries })
  return store.putObject(id, jsonBytes(manifest), 'object')
}

function compareBundlePath(left: string, right: string): number {
  const leftSegments = left.split('/')
  const rightSegments = right.split('/')
  const length = Math.min(leftSegments.length, rightSegments.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftSegments[index]
    const b = rightSegments[index]
    if (a !== b) return a < b ? -1 : 1
  }
  return leftSegments.length - rightSegments.length
}

async function seedSkillBundle(store: DomainStore, skill: SkillFixture): Promise<Ref> {
  const inputs = [
    { path: 'SKILL.md', bytes: textEncoder.encode(skill.content) },
    ...(skill.extraFiles ?? []).map(file => ({ path: file.path, bytes: textEncoder.encode(file.content) })),
  ]
  const files = []
  for (const input of inputs) {
    files.push({
      path: input.path,
      bytes: input.bytes.byteLength,
      object: await store.putObject(`skill-file:${skill.id}:${input.path}`, input.bytes, 'object'),
    })
  }
  files.sort((left, right) => compareBundlePath(left.path, right.path))
  const manifest = seal('object', { v: 1, kind: 'tree', files })
  return store.putObject(`skill-bundle:${skill.id}`, jsonBytes(manifest), 'object')
}

async function seedMcpServer(
  store: DomainStore,
  fixture: McpServerFixture,
): Promise<{ readonly asset: ToolAsset; readonly bundle: Ref }> {
  const entrypoint = fixture.entrypoint ?? 'server.ts'
  const files = [{ path: entrypoint, content: fixture.source }]
  const bundle = await seedRawTree(store, `mcp-bundle:${fixture.serverName}`, files)
  const sourceFiles = await seedRawTree(store, `mcp-source:${fixture.serverName}`, files)
  const manifest = seal('object', {
    v: 1,
    serverName: fixture.serverName,
    transport: 'stdio',
    capabilities: [...fixture.capabilities],
    instructions: fixture.instructions,
    entrypoint,
    limits: {
      maxBundleBytes: 1024 * 1024,
      maxInstructionBytes: 8192,
      toolCallTimeoutMs: 5_000,
    },
  })
  const manifestRef = await store.putObject(
    `mcp-manifest:${fixture.serverName}`,
    jsonBytes(manifest),
    'object',
  )
  const config = seal('object', {
    v: 1,
    serverName: fixture.serverName,
    transport: 'stdio',
    command: 'node',
    args: [entrypoint],
    cwd: '.',
    env: {},
    toolCallTimeoutMs: 5_000,
    maxInstructionBytes: 8192,
    failOnStartupError: true,
    reconnect: { enabled: false },
  })
  const configRef = await store.putObject(
    `mcp-config:${fixture.serverName}`,
    jsonBytes(config),
    'object',
  )
  return {
    bundle,
    asset: {
      id: `tool:${fixture.serverName}`,
      name: fixture.serverName,
      description: `Frozen ${fixture.serverName} MCP server.`,
      kind: 'mcp-server',
      server: {
        bundle,
        manifest: manifestRef,
        sourceFiles,
        config: configRef,
        transport: 'stdio',
        capabilities: [...fixture.capabilities],
        exposedTools: [...fixture.exposedTools],
      },
    },
  }
}

function fixtureUsage(index: number): NonNullable<ScriptedReply['usage']> {
  return {
    promptTokens: 40 + index * 10,
    completionTokens: 8,
    totalTokens: 48 + index * 10,
    cachedTokens: 0,
  }
}

async function makeScenario(
  storeRoot: string,
  ctx: Context,
  options: {
    readonly taskId: string
    readonly maxRuns: number
    readonly deadlineAt?: number
    readonly maxStepsPerRun?: number
    readonly guidanceText?: string
    readonly otherGuidanceText?: string
    readonly skills?: readonly SkillFixture[]
    readonly mcpServers?: readonly McpServerFixture[]
  },
): Promise<Scenario> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    const skillAssets: SkillAsset[] = []
    const skillBundles: Ref[] = []
    for (const skill of options.skills ?? []) {
      const bundle = await seedSkillBundle(store, skill)
      skillBundles.push(bundle)
      skillAssets.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        bundle,
      })
    }
    const toolAssets: ToolAsset[] = []
    const mcpBundles: Ref[] = []
    for (const server of options.mcpServers ?? []) {
      const seeded = await seedMcpServer(store, server)
      toolAssets.push(seeded.asset)
      mcpBundles.push(seeded.bundle)
    }
    const guidance = await seedObject(store, 'guidance:s3c', {
      v: 1,
      text: options.guidanceText ?? 'Write the declared output.',
    })
    const otherGuidance = options.otherGuidanceText === undefined
      ? undefined
      : await seedObject(store, 'guidance:s3c-other', {
        v: 1,
        text: options.otherGuidanceText,
      })
    const example = await seedObject(store, 'example:s3c', { v: 1, goal: 'fixture example' })
    const acceptancePolicy = await seedObject(store, 'acceptance-policy:s3c', { v: 1, kind: 'fixture-policy' })
    const verifierObject = seal('object', {
      v: 1,
      kind: 'verifier-identity',
      name: PROVIDER_ID,
    })
    await store.putObject(PROVIDER_ID, jsonBytes(verifierObject), 'object')
    const provider: Ref = { id: PROVIDER_ID, digest: verifierObject.digest }

    const currentTemplate = {
      id: 'template:s3c',
      brief: 'Produce one declared file.',
      guidance,
      example,
      instanceSchema: {},
      requiredCriteria: [],
      requiredOutputs: [],
      acceptancePolicy,
      skills: skillAssets.map(skill => skill.id),
      tools: toolAssets.map(tool => tool.id),
      children: [],
    }
    const method = sealMethodRevision({
      v: 1,
      id: 'method:s3c',
      entryTemplateId: 'template:s3c',
      templates: otherGuidance === undefined
        ? [currentTemplate]
        : [
          currentTemplate,
          {
            ...currentTemplate,
            id: 'template:s3c-other',
            guidance: otherGuidance,
          },
        ],
      skills: skillAssets,
      tools: toolAssets,
    })
    await store.putObject(method.id, jsonBytes(method), 'method')
    const methodRef: Ref = { id: method.id, digest: method.digest }

    const input = await store.putObject(
      'input:source',
      textEncoder.encode('fixture input bytes\n'),
      'object',
    )
    const seed = await seedObject(store, 'seed:s3c', { v: 1, seed: 's3c-seed' })
    const profile = await seedObject(store, 'profile:s3c', { v: 1, profile: 's3c-profile' })
    const request = await seedObject(store, 'request:s3c', { v: 1, request: 'run recovery fixture' })
    const bashTool = await seedObject(store, 'base-tool:bash', { v: 1, name: 'bash' })

    const rootAdmission: RootAdmissionInput = {
      taskId: options.taskId,
      spec: {
        goal: {
          summary: `Use the native bash tool to write exactly ${JSON.stringify(FROZEN_OUTPUT)} to ${OUTPUT_PATH} with no trailing newline, then submit the declared output.`,
          deliverable: OUTPUT_PATH,
          scope: ['run recovery'],
          constraints: [
            'verifier consumes frozen CAS objects only',
            `${OUTPUT_PATH} must contain exactly ${JSON.stringify(FROZEN_OUTPUT)} with no trailing newline`,
          ],
        },
        criteria: [{
          id: CRITERION_ID,
          statement: `The declared output ${OUTPUT_PATH} exists and contains exactly ${JSON.stringify(FROZEN_OUTPUT)} with no trailing newline.`,
          required: true,
        }],
        localGuidance: [{
          id: 'exact-output',
          statement: `Use bash with printf, for example: printf %s ${JSON.stringify(FROZEN_OUTPUT)} > ${OUTPUT_PATH}`,
        }],
        inputs: [{
          id: 'source',
          object: input,
          path: 'input.txt',
          access: 'read',
        }],
        outputs: [{
          id: OUTPUT_ID,
          path: OUTPUT_PATH,
          kind: 'file',
          role: 'deliverable',
          required: true,
        }],
      },
      origin: { kind: 'root', purpose: 'work', requestRef: request },
      method: methodRef,
      template: { id: 'template:s3c', digest: method.digest },
      resources: { baseTools: [bashTool], skills: skillBundles, mcpServers: mcpBundles },
      acceptance: provider,
      environment: { seed, profile },
      limits: {
        maxRuns: options.maxRuns,
        maxStepsPerRun: options.maxStepsPerRun ?? 12,
        maxTokens: 1_000_000,
        deadlineAt: options.deadlineAt ?? Date.now() + 10 * 60 * 1000,
        maxDepth: 1,
        maxTasks: 1,
        maxBatchChildren: 1,
      },
    }

    const contract = admitRootTask(rootAdmission)
    const composition = await buildSingleRunComposition(ctx, {
      store,
      id: 's3c',
      contract,
      agentOptions: agentOptions(),
      base: {
        v: 1,
        seed,
      },
    })
    const runAdmission: SingleRunAdmission = {
      contract,
      attempt: 1,
      budgetReservation: {
        tokens: contract.limits.maxTokens,
        steps: 10,
        deadlineAt: contract.limits.deadlineAt,
      },
      acceptanceBytes: jsonBytes(verifierObject),
      workspaceSeedBytes: jsonBytes({ v: 1, seed: 's3c-seed' }),
    }

    return { runAdmission, contract, method, composition, provider }
  } finally {
    await store.close()
  }
}

function planReply(scenario: Scenario, taskId: string, runId: string, contextEpoch: string): ScriptedReply {
  const sketch = {
    v: 1,
    taskId,
    runId,
    contextEpoch,
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
    sourceContract: scenario.contract.digest,
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

function selfReadAndPlan(
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

function writeOutputReply(): ScriptedReply {
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

function submitReply(): ScriptedReply {
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

async function withHarness(
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

function requireLiveEnv(name: string): string {
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
    assert.equal(
      contents.includes(secret),
      false,
      `live credential must not be persisted under ${directory}`,
    )
  }
}

async function withLiveHarness(
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

/** Counts the requests that reach the model route, per session when asked. */
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

/** Records committed Session events for one persisted session. */
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

/** Captures the dynamic context snapshot (NodeView) before the first model request. */
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

/** Captures the full scoped system prompt assembled by Agent setup. */
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

/** Captures the scoped DSH skill discovery set during Agent setup. */
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

function toolCallNames(events: readonly SessionEvent[]): string[] {
  const names: string[] = []
  for (const event of events) {
    if (event.type === 'tool/call') names.push(event.data.name)
  }
  return names
}

function userMessageIds(events: readonly SessionEvent[]): string[] {
  return events
    .filter(event => event.type === 'user/message')
    .map(event => String(event.data.id))
}

function agentOptions(): AgentOptions {
  return {
    provider: 'singularity-local',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: ReasoningEffortId('max'),
  }
}

function compositionBase(composition: CompositionPayload): Omit<
  CompositionPayload,
  'contract' | 'dsh' | 'guidance' | 'modelRoute' | 'platformPrompt' | 'resources' | 'skills' | 'template' | 'mcpServers'
> {
  return {
    v: composition.v,
    seed: composition.seed,
  }
}

function methodPayload(method: MethodRevision): Parameters<typeof sealMethodRevision>[0] {
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

function contractPayload(contract: TaskContract): TaskContractPayload {
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

async function currentComposition(
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

async function readFacts(storeRoot: string): Promise<readonly Fact[]> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    return store.facts()
  } finally {
    await store.close()
  }
}

function factsOfType<Type extends Fact['type']>(
  facts: readonly Fact[],
  type: Type,
): Extract<Fact, { readonly type: Type }>[] {
  return facts.filter((fact): fact is Extract<Fact, { readonly type: Type }> => fact.type === type)
}

function sequenceOf(facts: readonly Fact[]): string[] {
  return facts.filter(fact => RUN_FACT_TYPES.has(fact.type)).map(fact => fact.type)
}

async function readJson(store: DomainStore, ref: Ref, domain: 'object' | 'evidence'): Promise<JsonValue> {
  const { bytes } = await store.readObject(ref, domain)
  return parseJsonText(textDecoder.decode(bytes))
}

function passingVerifier(
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

function spyAgents(ctx: Context): AgentSpy {
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

function hostCommand(
  commandId: string,
  tool: string,
  scope: { readonly taskId: string; readonly runId?: string },
  input: JsonValue,
): NormalizedCommand {
  return { v: 1, commandId, tool, toolVersion: 1, actor: ACTOR, scope, input }
}

async function writeContractObject(service: CommandService, contract: TaskContract): Promise<Ref> {
  return service.putObject(contract.taskId, jsonBytes(contract), 'contract')
}

async function writeCompositionObject(
  service: CommandService,
  runId: string,
  composition: CompositionPayload,
): Promise<Ref> {
  const sealed = seal('composition', composition)
  return service.putObject(`${runId}:composition`, jsonBytes(sealed), 'composition')
}

async function commitTaskAdmitted(
  service: CommandService,
  taskId: string,
  contractRef: Ref,
): Promise<Fact> {
  return service.commit({
    command: hostCommand(`test:${taskId}:admitted`, 'test', { taskId }, { taskId, contract: contractRef }),
    type: 'task/admitted',
    data: { taskId, contract: contractRef },
  })
}

async function commitRunOpened(
  service: CommandService,
  options: {
    readonly taskId: string
    readonly runId: string
    readonly attempt: number
    readonly sessionId: string
    readonly composition: Ref
    readonly workspaceSeed: Ref
    readonly deadlineAt: number
  },
): Promise<Fact> {
  return service.commit({
    command: hostCommand(
      `test:${options.runId}:opened`,
      'test',
      { taskId: options.taskId, runId: options.runId },
      {
        taskId: options.taskId,
        runId: options.runId,
        attempt: options.attempt,
        sessionId: options.sessionId,
        composition: options.composition,
        workspaceKey: options.runId,
        workspaceSeed: options.workspaceSeed,
        budgetReservation: {
          tokens: 100_000,
          steps: 10,
          deadlineAt: options.deadlineAt,
        },
      },
    ),
    type: 'run/opened',
    data: {
      taskId: options.taskId,
      runId: options.runId,
      attempt: options.attempt,
      sessionId: options.sessionId,
      composition: options.composition,
      workspaceKey: options.runId,
      workspaceSeed: options.workspaceSeed,
      budgetReservation: {
        tokens: 100_000,
        steps: 10,
        deadlineAt: options.deadlineAt,
      },
    },
  })
}

async function commitRunSubmitted(
  service: CommandService,
  options: {
    readonly taskId: string
    readonly runId: string
    readonly sessionId: string
    readonly outputs: Ref
    readonly planningSketchRef: Ref
  },
): Promise<Fact> {
  return service.commit({
    command: hostCommand(
      `test:${options.runId}:submitted`,
      'test',
      { taskId: options.taskId, runId: options.runId },
      {
        runId: options.runId,
        outputs: options.outputs,
        transcriptOffset: { sessionId: options.sessionId, seq: 0 },
        previewReceipts: [],
        readReceipts: [],
        planningSketchRef: options.planningSketchRef,
        feedbackRefs: [],
      },
    ),
    type: 'run/submitted',
    data: {
      runId: options.runId,
      outputs: options.outputs,
      transcriptOffset: { sessionId: options.sessionId, seq: 0 },
      previewReceipts: [],
      readReceipts: [],
      planningSketchRef: options.planningSketchRef,
      feedbackRefs: [],
    },
  })
}

async function seedOpenRun(
  storeRoot: string,
  scenario: Scenario,
  options: {
    readonly runId: string
    readonly sessionId: string
    readonly composition?: CompositionPayload
    readonly attempt?: number
  },
): Promise<void> {
  const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: () => Date.now() })
  try {
    const contractRef = await writeContractObject(service, scenario.contract)
    const compositionRef = await writeCompositionObject(
      service,
      options.runId,
      options.composition ?? scenario.composition,
    )
    await commitTaskAdmitted(service, scenario.contract.taskId, contractRef)
    await commitRunOpened(service, {
      taskId: scenario.contract.taskId,
      runId: options.runId,
      attempt: options.attempt ?? 1,
      sessionId: options.sessionId,
      composition: compositionRef,
      workspaceSeed: scenario.contract.environment.seed,
      deadlineAt: scenario.contract.limits.deadlineAt,
    })
  } finally {
    await service.close()
  }
}

interface SeededSubmission {
  readonly manifest: SubmissionManifest
  readonly manifestRef: Ref
}

async function seedSubmittedRun(
  storeRoot: string,
  scenario: Scenario,
  options: {
    readonly runId: string
    readonly sessionId: string
    readonly workspace: string
    readonly composition?: CompositionPayload
  },
): Promise<SeededSubmission> {
  const service = await CommandService.open({ root: storeRoot, actor: ACTOR, clock: () => Date.now() })
  try {
    const contractRef = await writeContractObject(service, scenario.contract)
    const compositionRef = await writeCompositionObject(
      service,
      options.runId,
      options.composition ?? scenario.composition,
    )
    await commitTaskAdmitted(service, scenario.contract.taskId, contractRef)
    await commitRunOpened(service, {
      taskId: scenario.contract.taskId,
      runId: options.runId,
      attempt: 1,
      sessionId: options.sessionId,
      composition: compositionRef,
      workspaceSeed: scenario.contract.environment.seed,
      deadlineAt: scenario.contract.limits.deadlineAt,
    })
    const frozen: FrozenSubmission = await freezeSubmission({
      contract: scenario.contract,
      runId: options.runId,
      workspace: options.workspace,
      outputIds: [OUTPUT_ID],
      includeLearningDrafts: false,
      maxOutputBytes: 1024 * 1024,
      writer: service,
    })
    const sketch = {
      v: 1,
      taskId: scenario.contract.taskId,
      runId: options.runId,
      contextEpoch: initialContextEpoch(options.sessionId),
      objective: 'Recover the frozen submission.',
      levels: [
        {
          level: 0,
          purpose: 'The output was already frozen before the crash.',
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
      assumptions: [],
      sourceContract: scenario.contract.digest,
    }
    const sketchRef = await service.putObject(
      `${options.runId}:planning-sketch`,
      jsonBytes(sketch),
      'object',
    )
    await commitRunSubmitted(service, {
      taskId: scenario.contract.taskId,
      runId: options.runId,
      sessionId: options.sessionId,
      outputs: frozen.manifestRef,
      planningSketchRef: sketchRef,
    })
    return { manifest: frozen.manifest, manifestRef: frozen.manifestRef }
  } finally {
    await service.close()
  }
}

/**
 * Persists one real DSH session with the exact stable start wake consumed by a
 * completed model request, then disposes the handle. The resume path must find
 * the admitted message instead of buying another turn.
 */
async function seedConsumedStartWake(
  spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
  options: {
    readonly taskId: string
    readonly runId: string
    readonly sessionId: string
    readonly workspace: string
    readonly live: boolean
  },
): Promise<readonly SessionEvent[]> {
  const recording = recordSessionEvents(spike, options.sessionId)
  const handle = await spike.ctx.agents.create({
    sessionId: options.sessionId as never,
    meta: { cwd: options.workspace },
    // A one-token cap still buys one real request and consumes the stable
    // wake, but cannot start an unbounded live tool loop during seeding.
    agentOptions: { ...agentOptions(), maxTokens: 1 },
  })
  try {
    handle.agent.followup(createWakeMessage({
      wakeId: `${options.runId}:start`,
      text: startWakeText(options.taskId, options.runId, {
        tokensPct: 100,
        stepsPct: 100,
        wallClockPct: 100,
        taskSlotsPct: 0,
      }),
    }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        handle.agent.whenIdle(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('seeded live session did not consume the start wake in time'))
          }, options.live ? 300_000 : 30_000)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    assert.equal(await spike.ctx.sessions.flush(handle.agent.session), true)
  } finally {
    await handle.dispose()
  }
  const events = [...recording.events]
  recording.dispose()
  const wakes = events.filter(event =>
    event.type === 'user/message' && String(event.data.id) === `${options.runId}:start`)
  assert.equal(wakes.length, 1, 'the seeded session must persist exactly one stable start wake')
  assert.ok(
    events.some(event => event.type === 'assistant/message'),
    'the seeded live session must complete at least one model request',
  )
  return events
}

for (const complete of [false, true]) {
  void test(`composition freezes the actual scoped platform prompt (complete=${String(complete)})`, { timeout: 240_000 }, async () => {
    const taskId = `task-s3c-prompt-${String(complete)}-${String(process.pid)}-${String(Date.now())}`
    await withHarness((_request, index) => ({ content: 'Finished without submitting.', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
      if (complete) {
        spike.ctx.systemPrompt.section({ name: 's3c:complete', order: 50, text: 'Complete host prompt.', complete: true })
      } else {
        spike.ctx.systemPrompt.section({ name: 's3c:after-worker', order: 200, text: 'Host guidance after the worker card.' })
      }
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
      let observed: Awaited<ReturnType<typeof spike.ctx.systemPrompt.assemble>> | undefined
      const dispose = spike.ctx.on('agent/created', async ({ agent }) => {
        observed = await spike.ctx.systemPrompt.assemble({ scope: agent })
      })
      try {
        await executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId: `${taskId}-session`,
          runId: `${taskId}-run`,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024,
          verifier: { provider: scenario.provider, verify() { throw new Error('no submission') } },
          transientInvalidReasons: [],
        })
        assert.ok(observed)
        const text = renderPrompt(observed)
        assert.equal(scenario.composition.platformPrompt, computeDigest('object', { v: 1, text }))
        if (complete) assert.equal(text, 'Complete host prompt.')
        else assert.ok(observed.sections.findIndex(section => section.name === 'singularity:worker-card')
          < observed.sections.findIndex(section => section.name === 's3c:after-worker'))
        assert.equal(fixture.requests.length, 1)
      } finally {
        dispose()
      }
    })
  })
}

void test('fresh retry starts attempt 2 with a new session and workspace and keeps both fact chains', { timeout: 240_000 }, async () => {
  const taskId = `task-s3c-retry-${String(process.pid)}-${String(Date.now())}`
  const firstRunId = `${taskId}-run-1`
  const firstSessionId = `${taskId}-session-1`
  const secondRunId = `${taskId}-run-2`
  const secondSessionId = `${taskId}-session-2`
  let scenario: Scenario | undefined
  let secondWorkspace = ''

  const fixtureScript: ReplyScript = (request, index) => {
    if (index === 0) {
      return { content: 'The first attempt ends without submitting.', usage: fixtureUsage(index) }
    }
    if (index === 1) {
      const reply = selfReadAndPlan(request, 0, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 2) {
      const reply = selfReadAndPlan(request, 1, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 3) return writeOutputReply()
    if (index === 4) return submitReply()
    return { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }

  await withHarness(fixtureScript, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 2 })
    const active = scenario

    const first = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId: firstSessionId,
      runId: firstRunId,
      admission: active.runAdmission,
      composition: await currentComposition(spike.ctx, storeRoot, active),
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: active.provider,
        verify() {
          throw new Error('the first attempt must not invoke the verifier')
        },
      },
      transientInvalidReasons: [],
    })
    assert.equal(first.classification, 'failed')
    assert.equal(first.retry.allowed, true, 'maxRuns=2 must leave the Task open for retry')
    assert.ok(first.executionRecordRef)
    await assert.rejects(access(join(workspace, OUTPUT_PATH)), 'the first attempt wrote no output')

    const factsAfterFirst = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(factsAfterFirst), ['task/admitted', 'run/opened', 'run/closed'])
    const firstOpened = factsOfType(factsAfterFirst, 'run/opened')[0]
    assert.ok(firstOpened)
    const firstOpenedDigest = firstOpened.digest
    const firstCompositionDigest = firstOpened.data.composition.digest
    const firstClosed = factsOfType(factsAfterFirst, 'run/closed')[0]
    assert.ok(firstClosed)
    assert.equal(firstClosed.data.classification, 'failed')
    const firstClosedDigest = firstClosed.digest
    const firstRecordRef = 'executionRecordRef' in firstClosed.data
      ? firstClosed.data.executionRecordRef
      : undefined
    assert.ok(firstRecordRef)
    const firstRecordStore = await DomainStore.open({ root: storeRoot })
    let firstRecord: ExecutionRecord
    try {
      firstRecord = parseProtocolValue(
        executionRecordSchema,
        await readJson(firstRecordStore, firstRecordRef, 'object'),
      )
    } finally {
      await firstRecordStore.close()
    }

    secondWorkspace = await mkdtemp(join(tmpdir(), 's3c-retry-work-'))
    const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
    try {
      const second = await retrySingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        previousRunId: firstRunId,
        runId: secondRunId,
        sessionId: secondSessionId,
        workspace: secondWorkspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(active, secondRunId, secondWorkspace, verifierCalls),
        transientInvalidReasons: [],
      })

      assert.equal(second.previousRunId, firstRunId)
      assert.equal(second.attempt, 2)
      assert.equal(second.retryPolicy.allowed, true)
      assert.equal(second.runId, secondRunId)
      assert.notEqual(second.runId, firstRunId)
      assert.equal(second.sessionId, secondSessionId)
      assert.notEqual(second.sessionId, firstSessionId)
      assert.equal(second.classification, 'verified')
      assert.equal(verifierCalls.length, 1)
      assert.equal(second.receipt?.operationId, `${secondRunId}:verify`)
      assert.equal(first.executionRecord?.digest, firstRecord.digest)
      assert.equal(first.receipt, undefined)
      assert.equal(second.executionRecord, undefined, 'a verified retry must not reuse the old record')
      assert.notEqual(second.evidenceRef?.digest, firstRecord.digest)
      assert.equal(
        await readFile(join(secondWorkspace, OUTPUT_PATH), 'utf8'),
        'mutated-after-submit\n',
        'the verifier ran against the new attempt workspace after freezing CAS',
      )
      await assert.rejects(access(join(workspace, OUTPUT_PATH)), 'the old workspace remains untouched')

      const facts = await readFacts(storeRoot)
      assert.deepEqual(sequenceOf(facts), [
        'task/admitted',
        'run/opened',
        'run/closed',
        'run/opened',
        'run/submitted',
        'run/closed',
        'task/closed',
      ])
      const opened = factsOfType(facts, 'run/opened')
      assert.deepEqual(opened.map(fact => fact.data.attempt), [1, 2])
      assert.deepEqual(opened.map(fact => fact.data.runId), [firstRunId, secondRunId])
      assert.deepEqual(opened.map(fact => fact.data.sessionId), [firstSessionId, secondSessionId])
      assert.deepEqual(opened.map(fact => fact.data.workspaceKey), [firstRunId, secondRunId])
      assert.equal(opened[0].digest, firstOpenedDigest, 'the first run/opened fact is preserved')
      assert.equal(opened[0].data.composition.digest, firstCompositionDigest)
      assert.equal(opened[1].data.composition.digest, firstCompositionDigest)
      assert.notEqual(
        opened[0].data.composition.id,
        opened[1].data.composition.id,
        'the retry stores its own composition object while the content stays identical',
      )

      const closed = factsOfType(facts, 'run/closed')
      assert.equal(closed[0]?.digest, firstClosedDigest, 'the first closure must be preserved unchanged')
      assert.equal(closed[0]?.data.classification, 'failed')
      assert.equal(closed[1]?.data.classification, 'verified')
      const secondClosed = closed[1]
      assert.ok(secondClosed)
      assert.equal('evidenceRef' in secondClosed.data, true)
      assert.equal('executionRecordRef' in firstClosed.data, true)

      const submitted = factsOfType(facts, 'run/submitted')
      assert.equal(submitted.length, 1)
      assert.equal(submitted[0]?.data.runId, secondRunId)
      const manifestRef = submitted[0]?.data.outputs
      assert.ok(manifestRef)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const manifest = parseProtocolValue(
          submissionManifestSchema,
          await readJson(store, manifestRef, 'object'),
        )
        assert.equal(manifest.runId, secondRunId)
        assert.equal(manifest.digest, manifestRef.digest)
        const outputRef = manifest.outputs[0]?.object
        assert.ok(outputRef)
        const { bytes } = await store.readObject(outputRef, 'object')
        assert.equal(textDecoder.decode(bytes), FROZEN_OUTPUT)
        const firstRecordAfter = parseProtocolValue(
          executionRecordSchema,
          await readJson(store, firstRecordRef, 'object'),
        )
        assert.equal(firstRecordAfter.digest, firstRecord.digest)
        assert.equal(second.manifestRef?.digest, manifestRef.digest)
        const secondEvidence = second.evidence
        assert.ok(secondEvidence)
        assert.equal(secondEvidence.runId, secondRunId)
        assert.equal(secondEvidence.verification.operationId, `${secondRunId}:verify`)
      } finally {
        await store.close()
      }

      const taskClosed = factsOfType(facts, 'task/closed')
      assert.equal(taskClosed.length, 1)
      assert.equal(taskClosed[0]?.data.outcome, 'verified')
      assert.equal(taskClosed[0]?.data.decisiveRunId, secondRunId)

      assert.equal(fixture.requests.length, 5, 'attempt 1 buys one request; attempt 2 buys four')
      assert.equal(
        (fixture.requests[0]?.messages ?? []).some(message => (message.tool_calls ?? []).length > 0),
        false,
        'the no-submission attempt must end with a plain text turn',
      )
      assert.ok(
        toolSchemaNames(fixture.requests[1] ?? {}).includes('singularity_submit'),
        'the retry attempt exposes the Task tools',
      )
    } finally {
      await rm(secondWorkspace, { recursive: true, force: true })
    }
  })
})

void test('resume with a changed full composition writes invalid without any agent or model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s3c-mismatch-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined
  let verifierCalls = 0

  await withHarness((_request, index) => {
    return { content: 'no model request is allowed', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const active = scenario
    await seedOpenRun(storeRoot, active, { runId, sessionId })

    const originalDigest = computeDigest('composition', active.composition)
    spike.ctx.systemPrompt.section({ name: 's3c:changed-platform', order: 90, text: 'Changed host guidance.' })
    await spike.ctx.loader.update('include:agent-loop', { config: { maxParallelToolCalls: 1 } })
    const changedOptions = { ...agentOptions(), maxTokens: 512 }
    const store = await DomainStore.open({ root: storeRoot })
    let changedComposition: CompositionPayload
    try {
      changedComposition = await buildSingleRunComposition(spike.ctx, {
        store,
        id: 's3c',
        contract: active.contract,
        agentOptions: changedOptions,
        base: compositionBase(active.composition),
      })
      const configText = textDecoder.decode((await store.readObject(changedComposition.dsh.config)).bytes)
      assert.equal(configText.includes('fixture-key'), false)
      assert.equal(configText.includes('SINGULARITY_SPIKE_API_KEY'), false)
      const fiber = spike.ctx.loader.resolve('include:agent-loop').fiber
      assert.ok(fiber)
      let sensitiveReads = 0
      Object.defineProperty(fiber, 'effectiveConfig', {
        configurable: true,
        value: { get headers() { sensitiveReads += 1; throw new Error('must not read sensitive fields') } },
      })
      try {
        await assert.rejects(buildSingleRunComposition(spike.ctx, {
          store,
          id: 's3c',
          contract: active.contract,
          agentOptions: changedOptions,
          base: compositionBase(active.composition),
        }), /headers is not public composition data/)
        assert.equal(sensitiveReads, 0, 'credential-bearing field accessors must not be evaluated')
      } finally {
        Reflect.deleteProperty(fiber, 'effectiveConfig')
      }
    } finally {
      await store.close()
    }
    assert.equal(computeDigest('composition', active.composition), originalDigest, 'the old caller payload stays unchanged')
    assert.notEqual(changedComposition.platformPrompt, active.composition.platformPrompt)
    assert.notEqual(changedComposition.dsh.config.digest, active.composition.dsh.config.digest)
    assert.notEqual(changedComposition.modelRoute.digest, active.composition.modelRoute.digest)
    assert.notEqual(
      computeDigest('composition', changedComposition),
      computeDigest('composition', active.composition),
    )

    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: changedComposition,
        agentOptions: changedOptions,
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            verifierCalls += 1
            throw new Error('composition mismatch must not invoke the verifier')
          },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }

    assert.equal(spy.create, 0, 'composition mismatch must not create an Agent')
    assert.equal(spy.resume, 0, 'composition mismatch must not resume an Agent')
    assert.equal(fixture.requests.length, 0, 'composition mismatch must not buy a model request')
    assert.equal(verifierCalls, 0)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.wakeOutcome, undefined)
    assert.equal(result.compositionMatched, false)
    assert.equal(result.recoveredSubmission, false)
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
    assert.equal(result.evidenceRef, undefined)
    assert.ok(result.executionRecord)
    assert.ok(result.executionRecordRef)
    assert.match(result.executionRecord.reason, /composition-mismatch/i)
    assert.ok(result.executionRecord.usage.unknownRequests > 0, 'unknown usage must not be reported as zero')
    assert.equal(result.usage.unknownRequests, result.executionRecord.usage.unknownRequests)

    const facts = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), ['task/admitted', 'run/opened', 'run/closed', 'task/closed'])
    assert.equal(factsOfType(facts, 'run/opened').length, 1, 'resume must not open a second Run')
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.ok(closed)
    assert.equal(closed.data.classification, 'invalid')
    assert.equal(closed.data.reason, 'composition-mismatch')
    assert.equal('evidenceRef' in closed.data, false)
    assert.equal('executionRecordRef' in closed.data, true)
    const taskClosed = factsOfType(facts, 'task/closed')[0]
    assert.ok(taskClosed)
    assert.equal(taskClosed.data.outcome, 'invalid')
    assert.equal(taskClosed.data.decisiveRunId, runId)
  })
})

void test('resume with the original composition reuses the admitted wake without another request', { timeout: 240_000 }, async () => {
  const taskId = `task-s3c-wake-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined

  await withHarness((_request, index) => {
    return { content: 'seeded wake acknowledged', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const active = scenario
    await seedOpenRun(storeRoot, active, { runId, sessionId })

    const seedHandle = await spike.ctx.agents.create({
      sessionId: sessionId as never,
      meta: { cwd: workspace },
      agentOptions: agentOptions(),
    })
    const seedWakeText = startWakeText(taskId, runId, {
      tokensPct: 100,
      stepsPct: 100,
      wallClockPct: 100,
      taskSlotsPct: 0,
    })
    seedHandle.agent.followup(createWakeMessage({
      wakeId: `${runId}:start`,
      text: seedWakeText,
    }))
    await seedHandle.agent.whenIdle()
    assert.equal(fixture.requests.length, 1, 'the seeded session buys exactly one request')
    await spike.ctx.sessions.flush(seedHandle.agent.session)
    await seedHandle.dispose()

    const resumeEvents: SessionEvent[] = []
    const disposeEvents = spike.ctx.on('session/event', (session, event) => {
      if (String(session.id) === sessionId) resumeEvents.push(event)
      return undefined
    })
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            throw new Error('a run without a submission must not invoke the verifier')
          },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
      disposeEvents()
    }

    assert.equal(spy.create, 0, 'resume must reuse the persisted session instead of creating')
    assert.equal(spy.resume, 1, 'resume must load the persisted session')
    assert.equal(result.sessionAction, 'resumed')
    assert.equal(result.wakeOutcome, 'already-admitted')
    assert.equal(result.compositionMatched, true)
    assert.equal(result.recoveredSubmission, false)
    assert.equal(fixture.requests.length, 1, 'the admitted wake must not buy another request')
    assert.equal(
      resumeEvents.filter(event =>
        event.type === 'user/message' && String(event.data.id) === `${runId}:start`
      ).length,
      0,
      'resume must not append a second start wake',
    )
    assert.equal(
      resumeEvents.filter(event => event.type === 'turn/start').length,
      0,
      'resume must not open another model turn',
    )
    assert.equal(result.classification, 'failed')
    assert.ok(result.executionRecord)
    assert.equal(result.usage.steps, 1)
    assert.equal(result.usage.unknownRequests, 0)

    const facts = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), ['task/admitted', 'run/opened', 'run/closed', 'task/closed'])
    assert.equal(factsOfType(facts, 'run/opened').length, 1)
    assert.equal(factsOfType(facts, 'run/opened')[0]?.data.sessionId, sessionId)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.ok(closed)
    assert.equal(closed.data.classification, 'failed')
    assert.match(closed.data.reason, /no-submission/i)
  })
})

void test('resume after submission verifies the same CAS snapshot and operationId without a model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s3c-submitted-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined
  let seeded: SeededSubmission | undefined
  const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []

  await withHarness((_request, index) => {
    return { content: 'no model request is allowed', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const active = scenario
    await writeFile(join(workspace, OUTPUT_PATH), FROZEN_OUTPUT, 'utf8')
    seeded = await seedSubmittedRun(storeRoot, active, { runId, sessionId, workspace })
    const submission = seeded
    assert.ok(submission)
    await writeFile(join(workspace, OUTPUT_PATH), 'mutated-after-freeze\n', 'utf8')

    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(active, runId, workspace, verifierCalls),
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }

    assert.equal(spy.create, 0, 'submitted recovery must not create an Agent')
    assert.equal(spy.resume, 0, 'submitted recovery must not resume an Agent')
    assert.equal(fixture.requests.length, 0, 'submitted recovery must not buy a model request')
    assert.equal(verifierCalls.length, 1)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.wakeOutcome, undefined)
    assert.equal(result.compositionMatched, true)
    assert.equal(result.recoveredSubmission, true)
    assert.equal(result.classification, 'verified')
    assert.ok(result.evidence)
    assert.ok(result.evidenceRef)
    assert.equal(result.evidence.verification.operationId, `${runId}:verify`)
    assert.ok(result.usage.unknownRequests > 0, 'an unreplayed session must not claim zero usage')
    assert.deepEqual(result.evidence.usage, result.usage)

    const recorded = verifierCalls[0]
    assert.ok(recorded)
    assert.deepEqual(
      recorded.inputs.map(ref => ref.digest),
      active.contract.spec.inputs.map(input => input.object.digest),
    )
    const frozenOutput = submission.manifest.outputs[0]
    assert.ok(frozenOutput.object)
    assert.deepEqual(
      recorded.outputs.map(ref => ref.digest),
      [frozenOutput.object.digest],
    )
    assert.equal(submission.manifestRef.digest, submission.manifest.digest)

    const facts = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), [
      'task/admitted',
      'run/opened',
      'run/submitted',
      'run/closed',
      'task/closed',
    ])
    assert.equal(factsOfType(facts, 'run/submitted').length, 1, 'recovery must not re-freeze or append a submission')
    assert.equal(factsOfType(facts, 'run/opened').length, 1)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.ok(closed)
    assert.equal(closed.data.classification, 'verified')
    assert.equal('evidenceRef' in closed.data, true)
    const taskClosed = factsOfType(facts, 'task/closed')[0]
    assert.ok(taskClosed)
    assert.equal(taskClosed.data.outcome, 'verified')

    const store = await DomainStore.open({ root: storeRoot })
    try {
      const evidence = parseProtocolValue(
        evidenceSchema,
        await readJson(store, result.evidenceRef, 'evidence'),
      )
      const opened = factsOfType(facts, 'run/opened')[0]
      assert.ok(opened)
      const validation = validateEvidence(evidence, {
        contract: active.contract,
        runId,
        composition: opened.data.composition,
      })
      assert.equal(validation.valid, true)
      const receipt = parseProtocolValue(
        publicReceiptSchema,
        await readJson(store, evidence.verification.publicReceipt, 'object'),
      )
      const receiptValidation = validatePublicReceipt(receipt, {
        provider: active.provider,
        operationId: `${runId}:verify`,
        contractDigest: active.contract.digest,
        inputDigests: active.contract.spec.inputs.map(input => input.object.digest),
        outputDigests: recorded.outputs.map(ref => ref.digest),
        requiredCriteria: [CRITERION_ID],
      })
      assert.equal(receiptValidation.verdict, 'verified')
      assert.equal(
        parseProtocolValue(
          submissionManifestSchema,
          await readJson(store, submission.manifestRef, 'object'),
        ).digest,
        submission.manifest.digest,
      )
      const submitted = factsOfType(facts, 'run/submitted')[0]
      assert.ok(submitted)
      assert.equal(parseProtocolValue(planningSketchSchema, await readJson(
        store,
        submitted.data.planningSketchRef,
        'object',
      )).runId, runId)
    } finally {
      await store.close()
    }
  })
})

void test('live C-03 no-submission then fresh retry verified (fixture when LIVE=0)', { timeout: LIVE ? LIVE_TIMEOUT_MS : 240_000 }, async () => {
  const taskId = `task-s3c-live-c03-${String(process.pid)}-${String(Date.now())}`
  const firstRunId = `${taskId}-run-1`
  const firstSessionId = `${taskId}-session-1`
  const secondRunId = `${taskId}-run-2`
  const secondSessionId = `${taskId}-session-2`
  let scenario: Scenario | undefined
  let secondWorkspace = ''

  const fixtureScript: ReplyScript = (request, index) => {
    if (index === 0) {
      // Mirror the live first step: the host closes it after one admitted
      // step, before the model can plan, write, or submit.
      const reply = selfReadAndPlan(request, 0, scenario, taskId, firstRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 1) {
      const reply = selfReadAndPlan(request, 0, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 2) {
      const reply = selfReadAndPlan(request, 1, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 3) return writeOutputReply()
    if (index === 4) return submitReply()
    return { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }

  const runScenario = async (
    spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
    workspace: string,
    storeRoot: string,
    fixture: ChatCompletionsFixture | undefined,
    live: boolean,
  ): Promise<void> => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 2,
      deadlineAt: Date.now() + (live ? 30 : 10) * 60_000,
    })
    const active = scenario
    const firstEvents = recordSessionEvents(spike, firstSessionId)
    const secondEvents = recordSessionEvents(spike, secondSessionId)
    const retryContexts: string[] = []
    const disposeContexts = captureAgentContexts(spike, secondSessionId, retryContexts)
    const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
    try {
      // The first attempt receives one host step so the fixed budget boundary
      // closes it as failed/no-submission before any output or submission.
      const first = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId: firstSessionId,
        runId: firstRunId,
        admission: {
          ...active.runAdmission,
          budgetReservation: { ...active.runAdmission.budgetReservation, steps: 1 },
        },
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            throw new Error('the first attempt must not invoke the verifier')
          },
        },
        transientInvalidReasons: [],
      })

      assert.equal(first.runId, firstRunId)
      assert.equal(first.sessionId, firstSessionId)
      assert.equal(first.classification, 'failed')
      assert.equal(first.retry.allowed, true, 'maxRuns=2 must leave the Task open for retry')
      assert.equal(first.manifest, undefined)
      assert.equal(first.manifestRef, undefined)
      assert.equal(first.receipt, undefined)
      assert.equal(first.receiptRef, undefined)
      assert.equal(first.evidence, undefined)
      assert.equal(first.evidenceRef, undefined)
      assert.ok(first.executionRecord)
      assert.ok(first.executionRecordRef)
      assert.match(first.executionRecord.reason, /^(?:no-submission|stop:)/)
      assert.ok(first.usage.inputTokens + first.usage.outputTokens > 0, 'the first attempt must report real usage')
      assert.equal(first.usage.steps, 1)
      await assert.rejects(access(join(workspace, OUTPUT_PATH)), 'the first attempt wrote no output')

      const factsAfterFirst = await readFacts(storeRoot)
      assert.deepEqual(sequenceOf(factsAfterFirst), ['task/admitted', 'run/opened', 'run/closed'])
      const firstOpened = factsOfType(factsAfterFirst, 'run/opened')[0]
      assert.ok(firstOpened)
      const firstClosed = factsOfType(factsAfterFirst, 'run/closed')[0]
      assert.ok(firstClosed)
      assert.equal(firstClosed.data.classification, 'failed')
      assert.equal('evidenceRef' in firstClosed.data, false)
      assert.equal('executionRecordRef' in firstClosed.data, true)
      const firstReason = firstClosed.data.reason
      const firstOpenedDigest = firstOpened.digest
      const firstClosedDigest = firstClosed.digest
      const firstCompositionDigest = firstOpened.data.composition.digest
      const firstRecordRef = 'executionRecordRef' in firstClosed.data
        ? firstClosed.data.executionRecordRef
        : undefined
      assert.ok(firstRecordRef)
      const firstRecordStore = await DomainStore.open({ root: storeRoot })
      let firstRecord: ExecutionRecord
      try {
        firstRecord = parseProtocolValue(
          executionRecordSchema,
          await readJson(firstRecordStore, firstRecordRef, 'object'),
        )
        assert.equal(firstRecord.digest, first.executionRecord.digest)
        assert.match(firstRecord.reason, /^(?:no-submission|stop:)/)
      } finally {
        await firstRecordStore.close()
      }

      assert.equal(
        toolCallNames(firstEvents.events).includes('singularity_submit'),
        false,
        'the first attempt must not submit',
      )
      assert.ok(
        userMessageIds(firstEvents.events).includes(`${firstRunId}:start`),
        'the first attempt must persist its own start wake',
      )

      secondWorkspace = await mkdtemp(join(tmpdir(), 's3c-live-retry-work-'))
      const second = await retrySingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        previousRunId: firstRunId,
        runId: secondRunId,
        sessionId: secondSessionId,
        workspace: secondWorkspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(active, secondRunId, secondWorkspace, verifierCalls),
        transientInvalidReasons: [],
      })

      assert.equal(second.previousRunId, firstRunId)
      assert.equal(second.attempt, 2)
      assert.equal(second.runId, secondRunId)
      assert.equal(second.sessionId, secondSessionId)
      assert.notEqual(second.sessionId, firstSessionId, 'retry must use a fresh session')
      assert.equal(second.classification, 'verified')
      assert.equal(verifierCalls.length, 1)
      assert.equal(second.receipt?.operationId, `${secondRunId}:verify`)
      assert.equal(first.executionRecord.digest, firstRecord.digest)
      assert.equal(second.executionRecord, undefined, 'a verified retry must not reuse the old record')
      assert.ok(second.evidence)
      assert.ok(second.evidenceRef)
      assert.notEqual(second.evidenceRef.digest, firstRecord.digest)
      assert.deepEqual(second.evidence.usage, second.usage)
      assert.equal(second.usage.unknownRequests, 0)
      assert.ok(second.usage.inputTokens + second.usage.outputTokens > 0)
      assert.equal(
        await readFile(join(secondWorkspace, OUTPUT_PATH), 'utf8'),
        'mutated-after-submit\n',
        'the verifier ran against the new attempt workspace after freezing CAS',
      )

      assert.equal(retryContexts.length, 1, 'the retry worker context is assembled before its first request')
      const retryContext = retryContexts[0]
      assert.ok(retryContext)
      assert.ok(
        retryContext.includes(`"lastAttempt":{"runId":"${firstRunId}","reason":${JSON.stringify(firstReason)}}`),
        'the retry worker sees only the previous public Run id and closure reason',
      )

      const secondNames = toolCallNames(secondEvents.events)
      for (const name of ['singularity_read', 'singularity_plan', 'bash', 'singularity_submit']) {
        assert.ok(secondNames.includes(name), `the retry worker must call ${name}`)
      }
      assert.ok(
        secondNames.indexOf('singularity_read') < secondNames.indexOf('singularity_plan'),
        'the retry worker must read self before planning',
      )
      assert.ok(
        secondNames.indexOf('singularity_plan') < secondNames.lastIndexOf('bash'),
        'the retry worker must plan before writing the output',
      )
      assert.ok(
        secondNames.lastIndexOf('bash') < secondNames.lastIndexOf('singularity_submit'),
        'the retry worker must write the output before submitting',
      )
      assert.ok(userMessageIds(secondEvents.events).includes(`${secondRunId}:start`))
      assert.equal(
        userMessageIds(secondEvents.events).includes(`${firstRunId}:start`),
        false,
        'the retry session must not replay the previous start wake',
      )

      const facts = await readFacts(storeRoot)
      assert.deepEqual(sequenceOf(facts), [
        'task/admitted',
        'run/opened',
        'run/closed',
        'run/opened',
        'run/submitted',
        'run/closed',
        'task/closed',
      ])
      const opened = factsOfType(facts, 'run/opened')
      assert.deepEqual(opened.map(fact => fact.data.attempt), [1, 2])
      assert.deepEqual(opened.map(fact => fact.data.runId), [firstRunId, secondRunId])
      assert.deepEqual(opened.map(fact => fact.data.sessionId), [firstSessionId, secondSessionId])
      assert.deepEqual(opened.map(fact => fact.data.workspaceKey), [firstRunId, secondRunId])
      assert.equal(opened[0]?.digest, firstOpenedDigest, 'the first run/opened fact is preserved')
      assert.equal(opened[0]?.data.composition.digest, firstCompositionDigest)
      assert.equal(opened[1]?.data.composition.digest, firstCompositionDigest)

      const closed = factsOfType(facts, 'run/closed')
      assert.equal(closed[0]?.digest, firstClosedDigest, 'the first closure must be preserved unchanged')
      assert.equal(closed[0]?.data.classification, 'failed')
      assert.equal(closed[1]?.data.classification, 'verified')
      const secondClosed = closed[1]
      assert.ok(secondClosed)
      assert.equal('evidenceRef' in secondClosed.data, true)
      assert.equal('executionRecordRef' in firstClosed.data, true)

      const submitted = factsOfType(facts, 'run/submitted')
      assert.equal(submitted.length, 1)
      assert.equal(submitted[0]?.data.runId, secondRunId)
      const manifestRef = submitted[0]?.data.outputs
      assert.ok(manifestRef)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const manifest = parseProtocolValue(
          submissionManifestSchema,
          await readJson(store, manifestRef, 'object'),
        )
        assert.equal(manifest.runId, secondRunId)
        assert.equal(manifest.digest, manifestRef.digest)
        assert.equal(second.manifestRef?.digest, manifestRef.digest)
        const outputRef = manifest.outputs[0]?.object
        assert.ok(outputRef)
        const { bytes } = await store.readObject(outputRef, 'object')
        assert.equal(textDecoder.decode(bytes), FROZEN_OUTPUT)
        const firstRecordAfter = parseProtocolValue(
          executionRecordSchema,
          await readJson(store, firstRecordRef, 'object'),
        )
        assert.equal(firstRecordAfter.digest, firstRecord.digest)
      } finally {
        await store.close()
      }

      const taskClosed = factsOfType(facts, 'task/closed')
      assert.equal(taskClosed.length, 1)
      assert.equal(taskClosed[0]?.data.outcome, 'verified')
      assert.equal(taskClosed[0]?.data.decisiveRunId, secondRunId)

      if (live) {
        assert.equal(fixture, undefined, 'live mode must not start the scripted fixture')
        console.log('S3-C C-03 live evidence:', JSON.stringify({
          firstRunId,
          firstReason,
          firstExecutionRecord: first.executionRecordRef.digest,
          firstUsage: first.usage,
          secondRunId,
          secondSessionId,
          manifest: second.manifestRef.digest,
          receipt: second.receiptRef?.digest,
          evidence: second.evidenceRef.digest,
          usage: second.usage,
          sessionCut: second.sessionCut,
          taskClosed: taskClosed[0]?.digest,
        }))
      } else {
        assert.ok(fixture)
        assert.equal(fixture.requests.length, 5, 'attempt 1 buys one request; attempt 2 buys four')
        const retryWire = messageTexts(fixture.requests[1] ?? {}).join('\n')
        assert.ok(
          retryWire.includes(`"lastAttempt":{"runId":"${firstRunId}","reason":${JSON.stringify(firstReason)}}`),
          'the retry NodeView reaches the first retry request on the wire',
        )
      }

      // C-11: reuse this scenario's two real Runs. A closed Run must reconcile
      // to the original refs without a verifier, model request, or CAS freeze.
      const journalPath = join(storeRoot, 'journal.ndjson')
      const objectsPath = join(storeRoot, 'objects')
      const journalBeforeResume = await readFile(journalPath)
      const casEntriesBeforeResume = (await readdir(objectsPath)).sort()
      const casBytesBeforeResume = await Promise.all(
        casEntriesBeforeResume.map(entry => readFile(join(objectsPath, entry))),
      )
      const resumeSpy = spyAgents(spike.ctx)
      const requestCounter = countAgentRequests(spike)
      const requestsBeforeResume = requestCounter.count()
      let resumed: Awaited<ReturnType<typeof resumeSingleRun>> | undefined
      let requestsAfterResume = requestsBeforeResume
      try {
        resumed = await resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId: secondRunId,
          workspace: secondWorkspace,
          composition: await currentComposition(spike.ctx, storeRoot, active),
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: active.provider,
            verify() {
              throw new Error('closed-run resume must not invoke the verifier')
            },
          },
          transientInvalidReasons: [],
        })
        requestsAfterResume = requestCounter.count()
      } finally {
        resumeSpy.restore()
        requestCounter.dispose()
      }

      assert.ok(resumed)
      assert.equal(resumeSpy.create, 0, 'closed-run resume must not create an Agent')
      assert.equal(resumeSpy.resume, 0, 'closed-run resume must not resume an Agent')
      assert.equal(requestsAfterResume, requestsBeforeResume, 'closed-run resume must not buy a model request')
      assert.equal(resumed.compositionMatched, true)
      assert.equal(resumed.sessionAction, 'none')
      assert.equal(resumed.recoveredSubmission, false)
      assert.equal(resumed.wakeOutcome, undefined)
      assert.equal(resumed.classification, 'verified')
      assert.deepEqual(resumed.manifestRef, second.manifestRef)
      assert.deepEqual(resumed.receiptRef, second.receiptRef)
      assert.deepEqual(resumed.evidenceRef, second.evidenceRef)
      assert.deepEqual(resumed.manifest, second.manifest)
      assert.deepEqual(resumed.receipt, second.receipt)
      assert.deepEqual(resumed.evidence, second.evidence)
      assert.equal(resumed.runFact.digest, second.runFact.digest)
      assert.equal(resumed.taskFact?.digest, second.taskFact?.digest)
      assert.deepEqual(resumed.facts, facts)
      assert.deepEqual(resumed.usage, second.usage)
      assert.deepEqual(resumed.sessionCut, second.sessionCut)

      const journalAfterResume = await readFile(journalPath)
      assert.equal(
        journalAfterResume.equals(journalBeforeResume),
        true,
        'closed-run resume must not append facts',
      )
      const casEntriesAfterResume = (await readdir(objectsPath)).sort()
      const casBytesAfterResume = await Promise.all(
        casEntriesAfterResume.map(entry => readFile(join(objectsPath, entry))),
      )
      assert.deepEqual(casEntriesAfterResume, casEntriesBeforeResume)
      assert.deepEqual(casBytesAfterResume, casBytesBeforeResume)

      // DomainStore must reconstruct the original fact chain from the journal.
      let replayed: Fact[] | undefined
      const replayStore = await DomainStore.open({ root: storeRoot })
      try {
        replayed = await replayStore.replay()
      } finally {
        await replayStore.close()
      }
      assert.ok(replayed)
      assert.deepEqual(replayed, facts)

      // A complete JCS line without the commit LF is a torn EOF tail. Reopening
      // must truncate only those bytes and leave the journal and CAS intact.
      const tornTail = canonicalize({ v: 1, marker: 's3-c-c11-torn-tail', facts: facts.length })
      assert.equal(tornTail.endsWith('\n'), false)
      assert.doesNotThrow(() => parseJsonText(tornTail))
      await appendFile(journalPath, tornTail, 'utf8')
      const journalWithTornTail = await readFile(journalPath)
      assert.equal(
        journalWithTornTail.equals(Buffer.concat([journalAfterResume, Buffer.from(tornTail, 'utf8')])),
        true,
      )

      const restarted = await DomainStore.open({ root: storeRoot })
      try {
        assert.equal(restarted.tornTail(), tornTail)
        assert.deepEqual(restarted.facts(), facts)
        assert.deepEqual(await restarted.replay(), facts)
      } finally {
        await restarted.close()
      }
      const journalAfterRestart = await readFile(journalPath)
      assert.equal(
        journalAfterRestart.equals(journalAfterResume),
        true,
        'restart must truncate only the torn tail',
      )
      const casEntriesAfterRestart = (await readdir(objectsPath)).sort()
      const casBytesAfterRestart = await Promise.all(
        casEntriesAfterRestart.map(entry => readFile(join(objectsPath, entry))),
      )
      assert.deepEqual(casEntriesAfterRestart, casEntriesAfterResume)
      assert.deepEqual(casBytesAfterRestart, casBytesAfterResume)

      if (live) {
        console.log('S3-C C-11 live evidence:', JSON.stringify({
          taskId,
          firstRunId,
          firstExecutionRecord: first.executionRecordRef.digest,
          firstRunOpened: firstOpenedDigest,
          firstRunClosed: firstClosedDigest,
          secondRunId,
          manifestRef: second.manifestRef,
          receiptRef: second.receiptRef,
          evidenceRef: second.evidenceRef,
          runClosed: second.runFact.digest,
          taskClosed: second.taskFact?.digest,
          resumedManifestRef: resumed.manifestRef,
          resumedReceiptRef: resumed.receiptRef,
          resumedEvidenceRef: resumed.evidenceRef,
          resumedRunClosed: resumed.runFact.digest,
          resumedTaskClosed: resumed.taskFact?.digest,
          facts: facts.map(fact => ({
            type: fact.type,
            seq: fact.seq,
            digest: fact.digest,
            commandId: fact.commandId,
          })),
          replayedFacts: replayed.length,
          usage: resumed.usage,
          sessionCut: resumed.sessionCut,
          tornTail,
          tornTailTruncated: true,
        }))
      }
    } finally {
      disposeContexts()
      firstEvents.dispose()
      secondEvents.dispose()
      if (secondWorkspace.length > 0) {
        await rm(secondWorkspace, { recursive: true, force: true })
      }
    }
  }

  if (LIVE) {
    const credentials = {
      apiKey: requireLiveEnv('SINGULARITY_SPIKE_API_KEY'),
    }
    await withLiveHarness(credentials, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, undefined, true)
      // Close DSH before scanning its home so every session/log write is durable.
      await harness.spike.dispose()
      await assertSecretNotPersisted(harness.home, credentials.apiKey)
    })
  } else {
    await withHarness(fixtureScript, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, harness.fixture, false)
    })
  }
})

void test('live C-12 original composition resume reuses the consumed start wake (fixture when LIVE=0)', { timeout: LIVE ? LIVE_TIMEOUT_MS : 240_000 }, async () => {
  const taskId = `task-s3c-live-c12-wake-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined

  const fixtureScript: ReplyScript = (_request, index) => {
    return { content: 'seeded wake acknowledged', usage: fixtureUsage(index) }
  }

  const runScenario = async (
    spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
    workspace: string,
    storeRoot: string,
    fixture: ChatCompletionsFixture | undefined,
    live: boolean,
  ): Promise<void> => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      deadlineAt: Date.now() + (live ? 30 : 10) * 60_000,
    })
    const active = scenario
    await seedOpenRun(storeRoot, active, { runId, sessionId })
    const seededEvents = await seedConsumedStartWake(spike, {
      taskId,
      runId,
      sessionId,
      workspace,
      live,
    })
    const seedAssistant = seededEvents.find(event => event.type === 'assistant/message')
    assert.ok(seedAssistant, 'seeded session must contain one committed assistant message')
    const seedUsage = seedAssistant.data.usage
    assert.ok(seedUsage, 'seeded live request must report usage')

    const requests = countAgentRequests(spike, sessionId)
    const resumeEvents = recordSessionEvents(spike, sessionId)
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            throw new Error('a run without a submission must not invoke the verifier')
          },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
      requests.dispose()
      resumeEvents.dispose()
    }

    assert.equal(spy.create, 0, 'resume must reuse the persisted session instead of creating')
    assert.equal(spy.resume, 1, 'resume must load the persisted session')
    assert.equal(requests.count(), 0, 'resume of an admitted start wake must not buy a model request')
    assert.equal(result.sessionAction, 'resumed')
    assert.equal(result.wakeOutcome, 'already-admitted')
    assert.equal(result.compositionMatched, true)
    assert.equal(result.recoveredSubmission, false)
    assert.equal(result.classification, 'failed')
    assert.equal(result.evidence, undefined)
    assert.equal(result.evidenceRef, undefined)
    assert.ok(result.executionRecord)
    assert.ok(result.executionRecordRef)
    assert.match(result.executionRecord.reason, /no-submission/i)
    assert.equal(result.usage.unknownRequests, 0)
    assert.ok(
      result.usage.inputTokens + result.usage.outputTokens
        >= seedUsage.inputTokens + seedUsage.outputTokens,
      'resume must preserve the seeded usage, not reset it',
    )
    assert.ok(result.usage.steps >= 1, 'resume must retain the consumed step')
    assert.equal(result.sessionCut.sessionId, sessionId)
    assert.ok(result.sessionCut.to >= seededEvents.length)
    assert.equal(
      resumeEvents.events.filter(event => event.type === 'turn/start').length,
      0,
      'resume must not open another model turn',
    )
    assert.equal(
      resumeEvents.events.filter(event => event.type === 'assistant/message').length,
      0,
      'resume must not buy another assistant message',
    )
    assert.equal(userMessageIds(resumeEvents.events).length, 0, 'resume must not append a user message')

    const facts = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), ['task/admitted', 'run/opened', 'run/closed', 'task/closed'])
    assert.equal(factsOfType(facts, 'run/opened').length, 1)
    assert.equal(factsOfType(facts, 'run/opened')[0]?.data.sessionId, sessionId)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.ok(closed)
    assert.equal(closed.data.classification, 'failed')
    assert.match(closed.data.reason, /no-submission/i)
    assert.equal('evidenceRef' in closed.data, false)
    assert.equal('executionRecordRef' in closed.data, true)
    const taskClosed = factsOfType(facts, 'task/closed')[0]
    assert.ok(taskClosed)
    assert.equal(taskClosed.data.outcome, 'failed')
    assert.equal(taskClosed.data.decisiveRunId, runId)

    if (live) {
      assert.equal(fixture, undefined, 'live mode must not start the scripted fixture')
      console.log('S3-C C-12 match live evidence:', JSON.stringify({
        runId,
        sessionId,
        wakeOutcome: result.wakeOutcome,
        executionRecord: result.executionRecordRef.digest,
        runClosed: closed.digest,
        taskClosed: taskClosed.digest,
        usage: result.usage,
        sessionCut: result.sessionCut,
      }))
    } else {
      assert.ok(fixture)
      assert.equal(fixture.requests.length, 1, 'only the seed request may be purchased')
    }
  }

  if (LIVE) {
    const credentials = {
      apiKey: requireLiveEnv('SINGULARITY_SPIKE_API_KEY'),
    }
    await withLiveHarness(credentials, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, undefined, true)
      await harness.spike.dispose()
      await assertSecretNotPersisted(harness.home, credentials.apiKey)
    })
  } else {
    await withHarness(fixtureScript, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, harness.fixture, false)
    })
  }
})

void test('live C-12 composition mismatch closes invalid before Agent, verifier, or model (fixture when LIVE=0)', { timeout: LIVE ? LIVE_TIMEOUT_MS : 240_000 }, async () => {
  const taskId = `task-s3c-live-c12-mismatch-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined

  const fixtureScript: ReplyScript = (_request, index) => {
    return { content: 'seeded wake acknowledged', usage: fixtureUsage(index) }
  }

  const runScenario = async (
    spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
    workspace: string,
    storeRoot: string,
    fixture: ChatCompletionsFixture | undefined,
    live: boolean,
  ): Promise<void> => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      deadlineAt: Date.now() + (live ? 30 : 10) * 60_000,
    })
    const active = scenario
    await seedOpenRun(storeRoot, active, { runId, sessionId })
    await seedConsumedStartWake(spike, {
      taskId,
      runId,
      sessionId,
      workspace,
      live,
    })

    spike.ctx.systemPrompt.section({
      name: 's3c:changed-platform',
      order: 90,
      text: 'Changed host guidance.',
    })
    await spike.ctx.loader.update('include:agent-loop', { config: { maxParallelToolCalls: 1 } })
    const changedOptions = { ...agentOptions(), maxTokens: 512 }
    const store = await DomainStore.open({ root: storeRoot })
    let changedComposition: CompositionPayload
    try {
      changedComposition = await buildSingleRunComposition(spike.ctx, {
        store,
        id: 's3c-changed',
        contract: active.contract,
        agentOptions: changedOptions,
        base: compositionBase(active.composition),
      })
    } finally {
      await store.close()
    }
    assert.notEqual(
      computeDigest('composition', changedComposition),
      computeDigest('composition', active.composition),
      'the mismatch must change the complete Composition, not just a preset name',
    )

    const requests = countAgentRequests(spike, sessionId)
    const resumeEvents = recordSessionEvents(spike, sessionId)
    const spy = spyAgents(spike.ctx)
    let verifierCalls = 0
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: changedComposition,
        agentOptions: changedOptions,
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            verifierCalls += 1
            throw new Error('composition mismatch must not invoke the verifier')
          },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
      requests.dispose()
      resumeEvents.dispose()
    }

    assert.equal(spy.create, 0, 'composition mismatch must not create an Agent')
    assert.equal(spy.resume, 0, 'composition mismatch must not resume an Agent')
    assert.equal(requests.count(), 0, 'composition mismatch must not buy a model request')
    assert.equal(verifierCalls, 0)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.wakeOutcome, undefined)
    assert.equal(result.compositionMatched, false)
    assert.equal(result.recoveredSubmission, false)
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
    assert.equal(result.evidenceRef, undefined)
    assert.ok(result.executionRecord)
    assert.ok(result.executionRecordRef)
    assert.match(result.executionRecord.reason, /composition-mismatch/i)
    assert.ok(result.usage.unknownRequests > 0, 'unknown usage must not be reported as zero')
    assert.equal(result.usage.unknownRequests, result.executionRecord.usage.unknownRequests)
    assert.equal(
      resumeEvents.events.filter(event => event.type === 'turn/start').length,
      0,
      'mismatch must not open a model turn',
    )
    assert.equal(
      resumeEvents.events.filter(event => event.type === 'assistant/message').length,
      0,
      'mismatch must not buy an assistant message',
    )

    const facts = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), ['task/admitted', 'run/opened', 'run/closed', 'task/closed'])
    assert.equal(factsOfType(facts, 'run/opened').length, 1, 'resume must not open a second Run')
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.ok(closed)
    assert.equal(closed.data.classification, 'invalid')
    assert.equal(closed.data.reason, 'composition-mismatch')
    assert.equal('evidenceRef' in closed.data, false)
    assert.equal('executionRecordRef' in closed.data, true)
    const taskClosed = factsOfType(facts, 'task/closed')[0]
    assert.ok(taskClosed)
    assert.equal(taskClosed.data.outcome, 'invalid')
    assert.equal(taskClosed.data.decisiveRunId, runId)

    if (live) {
      assert.equal(fixture, undefined, 'live mode must not start the scripted fixture')
      console.log('S3-C C-12 mismatch live evidence:', JSON.stringify({
        runId,
        sessionId,
        executionRecord: result.executionRecordRef.digest,
        runClosed: closed.digest,
        taskClosed: taskClosed.digest,
        usage: result.usage,
        sessionCut: result.sessionCut,
      }))
    } else {
      assert.ok(fixture)
      assert.equal(fixture.requests.length, 1, 'mismatch must not buy a second request')
    }
  }

  if (LIVE) {
    const credentials = {
      apiKey: requireLiveEnv('SINGULARITY_SPIKE_API_KEY'),
    }
    await withLiveHarness(credentials, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, undefined, true)
      await harness.spike.dispose()
      await assertSecretNotPersisted(harness.home, credentials.apiKey)
    })
  } else {
    await withHarness(fixtureScript, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, harness.fixture, false)
    })
  }
})

// ---------------------------------------------------------------------------
// S4-A1 — Method revision pin and current-layer guidance
// ---------------------------------------------------------------------------

const S4A1_CURRENT_MARKER = 'S4-A1 CURRENT GUIDANCE MARKER'
const S4A1_OTHER_MARKER = 'S4-A1 OTHER GUIDANCE MARKER'

void test('S4-A1 host derives template/guidance from the pinned Method and the first real DSH request carries only current guidance', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  await withHarness(
    (_request, index) => ({ content: 'S4-A1 finished without submitting.', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        guidanceText: S4A1_CURRENT_MARKER,
        otherGuidanceText: S4A1_OTHER_MARKER,
      })
      assert.equal(scenario.method.templates.length, 2)
      const currentTemplate = scenario.method.templates[0]
      assert.ok(currentTemplate)
      assert.deepEqual(scenario.composition.guidance, currentTemplate.guidance)

      const prompts: string[] = []
      const contexts: string[] = []
      const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
      const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
      try {
        const result = await executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId: `${taskId}-run`,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('no submission') },
          },
          transientInvalidReasons: [],
        })
        assert.equal(result.classification, 'failed')
      } finally {
        disposePrompts()
        disposeContexts()
      }

      assert.equal(fixture.requests.length, 1, 'the create path buys exactly one request')
      const texts = messageTexts(fixture.requests[0] ?? {})
      assert.ok(
        texts.some(text => text.includes(S4A1_CURRENT_MARKER)),
        'the first wire request must contain the current template guidance',
      )
      assert.equal(
        texts.some(text => text.includes(S4A1_OTHER_MARKER)),
        false,
        'another template guidance must not be injected',
      )
      assert.equal(prompts.length, 1)
      const prompt = prompts[0]
      assert.ok(prompt)
      assert.equal(
        scenario.composition.platformPrompt,
        computeDigest('object', { v: 1, text: prompt }),
        'the frozen platformPrompt must equal the actual scoped system prompt',
      )
      const systemMessage = fixture.requests[0]?.messages?.find(message => message.role === 'system')
      assert.ok(systemMessage, 'the first wire request must carry the assembled system prompt')
      assert.equal(
        wireText(systemMessage.content),
        prompt,
        'the first wire request system prompt must equal the actual scoped assembly',
      )
      assert.equal(contexts.length, 1)
      assert.ok(
        contexts[0]?.includes(
          '"ownTemplate":{"id":"template:s3c","brief":"Produce one declared file."}',
        ),
        'NodeView ownTemplate.brief must come from the pinned template, not the goal summary',
      )

      const store = await DomainStore.open({ root: storeRoot })
      try {
        const { bytes } = await store.readObject(scenario.composition.template, 'object')
        const template = parseProtocolValue(
          taskTemplateSchema,
          parseJsonText(textDecoder.decode(bytes)),
        )
        assert.deepEqual(template, currentTemplate)
      } finally {
        await store.close()
      }
    },
  )
})

void test('S4-A1 original composition resume re-verifies the Method guidance in the resumed Agent setup', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-resume-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness(
    (_request, index) => ({ content: 'seeded wake acknowledged', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        guidanceText: S4A1_CURRENT_MARKER,
        otherGuidanceText: S4A1_OTHER_MARKER,
      })
      await seedOpenRun(storeRoot, scenario, { runId, sessionId })
      const seededEvents = await seedConsumedStartWake(spike, {
        taskId,
        runId,
        sessionId,
        workspace,
        live: false,
      })
      assert.equal(fixture.requests.length, 1, 'the seed request is the only purchased request')

      const prompts: string[] = []
      const histories: (readonly SessionEvent[])[] = []
      const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
      const disposeHistory = spike.ctx.on('agent/created', ({ agent }) => {
        if (String(agent.session.id) !== sessionId) return undefined
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- alpha2 exposes no replacement raw reader
        histories.push(agent.session.snapshotEvents())
        return undefined
      })
      const resumeEvents = recordSessionEvents(spike, sessionId)
      const spy = spyAgents(spike.ctx)
      let result
      try {
        result = await resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: await currentComposition(spike.ctx, storeRoot, scenario),
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('no submission') },
          },
          transientInvalidReasons: [],
        })
      } finally {
        spy.restore()
        disposePrompts()
        disposeHistory()
        resumeEvents.dispose()
      }

      assert.equal(spy.create, 0, 'resume must reuse the persisted session')
      assert.equal(spy.resume, 1)
      assert.equal(fixture.requests.length, 1, 'resume must not buy another model request')
      assert.equal(result.compositionMatched, true)
      assert.equal(result.sessionAction, 'resumed')
      assert.equal(prompts.length, 1, 'the resumed Agent setup must assemble one scoped prompt')
      assert.ok(
        prompts[0]?.includes(S4A1_CURRENT_MARKER),
        'the resumed scoped prompt must contain the current template guidance',
      )
      assert.equal(
        prompts[0]?.includes(S4A1_OTHER_MARKER),
        false,
        'another template guidance must not be mounted on resume',
      )
      assert.equal(
        scenario.composition.platformPrompt,
        computeDigest('object', { v: 1, text: prompts[0] }),
      )
      assert.equal(
        resumeEvents.events.filter(event => event.type === 'turn/start').length,
        0,
        'resume must not open another model turn',
      )
      assert.equal(
        resumeEvents.events.filter(event => event.type === 'assistant/message').length,
        0,
        'resume must not buy another assistant message',
      )
      assert.equal(userMessageIds(resumeEvents.events).length, 0)
      assert.equal(histories.length, 1)
      const history = histories[0]
      assert.ok(history)
      assert.deepEqual(
        history.slice(0, seededEvents.length),
        seededEvents,
        'resume must preserve the persisted history prefix byte-for-byte',
      )
      const appended = history.slice(seededEvents.length)
      assert.ok(appended.length > 0)
      assert.equal(
        appended.every(event => event.type === 'session/end-seed'),
        true,
        'resume may only append the existing end-seed boundary',
      )
    },
  )
})

void test('S4-A1 resume rejects a missing guidance CAS before Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-missing-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness(
    (_request, index) => ({ content: 'missing guidance must not reach the model', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        guidanceText: S4A1_CURRENT_MARKER,
      })
      await seedOpenRun(storeRoot, scenario, { runId, sessionId })
      const guidance = scenario.method.templates[0]?.guidance
      assert.ok(guidance)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const objectPath = join(store.objectsPath, guidance.digest.slice('sha256:'.length))
        await rm(objectPath)
      } finally {
        await store.close()
      }
      const spy = spyAgents(spike.ctx)
      try {
        await assert.rejects(resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('missing guidance must not verify') },
          },
          transientInvalidReasons: [],
        }))
      } finally {
        spy.restore()
      }
      assert.equal(spy.create + spy.resume, 0, 'missing guidance must be rejected before Agent setup')
      assert.equal(fixture.requests.length, 0, 'missing guidance must not buy a model request')
    },
  )
})

void test('S4-A1 resume cannot switch to another Method revision', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-switch-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness(
    (_request, index) => ({ content: 'seeded wake acknowledged', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        guidanceText: S4A1_CURRENT_MARKER,
      })
      await seedOpenRun(storeRoot, scenario, { runId, sessionId })
      await seedConsumedStartWake(spike, {
        taskId,
        runId,
        sessionId,
        workspace,
        live: false,
      })
      assert.equal(fixture.requests.length, 1)

      const store = await DomainStore.open({ root: storeRoot })
      let switchedComposition: CompositionPayload
      try {
        const otherGuidance = await seedObject(store, 'guidance:s4a1-switched', {
          v: 1,
          text: S4A1_OTHER_MARKER,
        })
        const current = scenario.method.templates[0]
        assert.ok(current)
        const otherMethod = sealMethodRevision({
          ...methodPayload(scenario.method),
          id: 'method:s4a1-switched',
          entryTemplateId: current.id,
          templates: [{
            ...current,
            guidance: otherGuidance,
          }],
        })
        await store.putObject(otherMethod.id, jsonBytes(otherMethod), 'method')
        const otherContract = sealTaskContract({
          ...contractPayload(scenario.contract),
          method: { id: otherMethod.id, digest: otherMethod.digest },
          template: {
            id: scenario.contract.template.id,
            digest: otherMethod.digest,
          },
        })
        switchedComposition = await buildSingleRunComposition(spike.ctx, {
          store,
          id: 's4a1-switched',
          contract: otherContract,
          agentOptions: agentOptions(),
          base: compositionBase(scenario.composition),
        })
      } finally {
        await store.close()
      }

      const spy = spyAgents(spike.ctx)
      let result
      try {
        result = await resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: switchedComposition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('a switched Method pin must not verify') },
          },
          transientInvalidReasons: [],
        })
      } finally {
        spy.restore()
      }
      assert.equal(spy.create + spy.resume, 0, 'a switched pin must not create or resume an Agent')
      assert.equal(fixture.requests.length, 1, 'a switched pin must not buy another request')
      assert.equal(result.compositionMatched, false)
      assert.equal(result.classification, 'invalid')
      assert.equal(result.executionRecord?.reason, 'composition-mismatch')
    },
  )
})

void test('S4-A1 create rejects an actual scoped platformPrompt mismatch before any model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-platform-create-${String(process.pid)}-${String(Date.now())}`
  await withHarness(
    (_request, index) => ({ content: 'platform mismatch must not reach the model', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
      const wrongComposition: CompositionPayload = {
        ...scenario.composition,
        platformPrompt: computeDigest('object', { v: 1, text: 'wrong platform prompt' }),
      }
      const created: string[] = []
      const disposeCreated = spike.ctx.on('agent/created', ({ agent }) => {
        created.push(String(agent.session.id))
        return undefined
      })
      let result
      try {
        result = await executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId: `${taskId}-session`,
          runId: `${taskId}-run`,
          admission: scenario.runAdmission,
          composition: wrongComposition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('platform mismatch must not verify') },
          },
          transientInvalidReasons: [],
        })
      } finally {
        disposeCreated()
      }
      assert.equal(created.length, 0, 'platform mismatch must not publish an Agent')
      assert.equal(fixture.requests.length, 0, 'platform mismatch must not buy a model request')
      assert.equal(result.classification, 'invalid')
      assert.equal(result.evidence, undefined)
      assert.match(result.executionRecord?.reason ?? '', /^COMPOSITION_MISMATCH:/)
      const facts = await readFacts(storeRoot)
      assert.equal(factsOfType(facts, 'run/submitted').length, 0)
      assert.equal(factsOfType(facts, 'run/closed')[0]?.data.classification, 'invalid')
    },
  )
})

void test('S4-A1 resume rejects an actual scoped platformPrompt mismatch before Agent publication', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-platform-resume-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness(
    (_request, index) => ({ content: 'platform mismatch must not reach the model', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
      const wrongComposition: CompositionPayload = {
        ...scenario.composition,
        platformPrompt: computeDigest('object', { v: 1, text: 'wrong platform prompt on resume' }),
      }
      await seedOpenRun(storeRoot, scenario, {
        runId,
        sessionId,
        composition: wrongComposition,
      })
      const spy = spyAgents(spike.ctx)
      const created: string[] = []
      const disposeCreated = spike.ctx.on('agent/created', ({ agent }) => {
        created.push(String(agent.session.id))
        return undefined
      })
      let result
      try {
        result = await resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: wrongComposition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('platform mismatch must not verify') },
          },
          transientInvalidReasons: [],
        })
      } finally {
        spy.restore()
        disposeCreated()
      }
      assert.equal(spy.resume, 1, 'resume must reach the Agent setup for this check')
      assert.equal(created.length, 0, 'platform mismatch must not publish an Agent')
      assert.equal(fixture.requests.length, 0, 'platform mismatch must not buy a model request')
      assert.equal(result.compositionMatched, true)
      assert.equal(result.classification, 'invalid')
      assert.equal(result.sessionAction, 'none')
      assert.equal(result.evidence, undefined)
      assert.match(result.executionRecord?.reason ?? '', /^COMPOSITION_MISMATCH:/)
    },
  )
})

// ---------------------------------------------------------------------------
// S4-A2 — Method skill binding, native discovery, and read guard
// ---------------------------------------------------------------------------

const S4A2_SKILL_NAME = 's4a2-bounded-skill'
const S4A2_SKILL_BODY = '# S4A2 bounded skill body\n\nFollow the frozen instructions.'
const S4A2_SKILL_DESCRIPTION = 'Use the frozen S4-A2 skill while validating scoped discovery.'
const S4A2_REFERENCE_BODY = 'S4A2 REFERENCE NOTES'
const S4A2_RESOURCE_BASE = {
  kind: 'opaque' as const,
  description: 'Referenced files are frozen in the skill bundle; this slice exposes only SKILL.md.',
}

function s4a2Skill(): SkillFixture {
  return {
    id: 'skill:s4a2',
    name: S4A2_SKILL_NAME,
    description: S4A2_SKILL_DESCRIPTION,
    content: S4A2_SKILL_BODY,
    extraFiles: [{ path: 'refs/notes.txt', content: S4A2_REFERENCE_BODY }],
  }
}

function s4a2SecondSkill(): SkillFixture {
  return {
    id: 'skill:s4a2-b',
    name: 's4a2-second-skill',
    description: 'Use the second frozen S4-A2 skill for scoped discovery.',
    content: '# S4A2 second skill body\n',
  }
}

void test('S4-A2 create discovers the bound Method skill and reads it without touching the system prompt', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  const skill = s4a2Skill()
  await withHarness((_request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen skill before continuing.',
        toolCalls: [{
          id: 's4a2-skill-call',
          name: 'skill',
          arguments: JSON.stringify({ name: S4A2_SKILL_NAME }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'The skill was read without submitting.', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, home, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [skill],
    })
    assert.equal(scenario.composition.skills.length, 1)
    const prompts: string[] = []
    const contexts: string[] = []
    const discovered: string[][] = []
    const createdAgents: Agent[] = []
    const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    const disposeSkills = captureAgentSkills(spike, sessionId, workspace, discovered, [])
    const disposeAgents = spike.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.session.id) === sessionId) createdAgents.push(agent)
      return undefined
    })
    let result
    try {
      result = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('S4-A2 create must not verify without submission') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      disposePrompts()
      disposeContexts()
      disposeSkills()
      disposeAgents()
    }

    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 2, 'the catalog step and the skill read are two requests')
    assert.equal(prompts.length, 1)
    const prompt = prompts[0]
    assert.ok(prompt)
    assert.equal(
      scenario.composition.platformPrompt,
      computeDigest('object', { v: 1, text: prompt }),
      'skill binding must not change the A1 platformPrompt',
    )
    const firstRequest = fixture.requests[0] ?? {}
    const systemMessage = firstRequest.messages?.find(message => message.role === 'system')
    assert.ok(systemMessage)
    assert.equal(wireText(systemMessage.content), prompt)
    assert.ok(toolSchemaNames(firstRequest).includes('skill'), 'the native skill tool must be visible')
    assert.ok(Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])) <= 12 * 1024)
    assert.ok(Buffer.byteLength(contexts[0] ?? '') <= 8 * 1024)

    const firstTexts = messageTexts(firstRequest)
    const catalog = firstTexts.find(text => text.includes('<available_skills>'))
    assert.ok(catalog, 'the first request must contain the bound skill discovery entry')
    assert.ok(catalog.includes(S4A2_SKILL_NAME))
    assert.ok(catalog.includes(S4A2_SKILL_DESCRIPTION))
    assert.equal(
      firstTexts.filter(text => text.includes('<available_skills>')).length,
      1,
      'the first request must contain exactly one discovery catalog',
    )
    assert.equal(
      firstTexts.some(text => text.includes(S4A2_SKILL_BODY)),
      false,
      'skill body must not be injected into system or discovery messages',
    )

    const secondTexts = messageTexts(fixture.requests[1] ?? {})
    const expectedSkillResult = renderSkillContent({
      name: S4A2_SKILL_NAME,
      provider: 'runtime',
      resourceBase: S4A2_RESOURCE_BASE,
      content: S4A2_SKILL_BODY,
    })
    const skillResult = secondTexts.find(text => text.startsWith(`<skill_content name="${S4A2_SKILL_NAME}">`))
    assert.equal(skillResult, expectedSkillResult, 'the native skill result must equal renderSkillContent exactly')
    assert.ok(skillResult.includes(S4A2_RESOURCE_BASE.description), 'only the opaque resource description is exposed')
    assert.equal(skillResult.includes(S4A2_REFERENCE_BODY), false, 'referenced files are not inlined into the skill result')
    assert.equal(skillResult.includes('refs/notes.txt'), false, 'referenced paths are not exposed')
    assert.ok(Buffer.byteLength(skillResult) <= 16 * 1024)
    assert.equal(
      secondTexts.filter(text => text.includes('<available_skills>')).length,
      1,
      'the discovery catalog must not be duplicated on the next request',
    )
    const evidence = {
      systemBytes: Buffer.byteLength(prompt),
      catalogBytes: Buffer.byteLength(catalog),
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])),
      nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
      request0Bytes: Buffer.byteLength(JSON.stringify(firstRequest)),
      request1Bytes: Buffer.byteLength(JSON.stringify(fixture.requests[1] ?? {})),
      skillResultBytes: Buffer.byteLength(skillResult),
    }
    if (process.env.SINGULARITY_S4A2_EVIDENCE === '1') {
      console.log('S4-A2 byte evidence:', JSON.stringify(evidence))
    }
    assert.ok(evidence.systemBytes > 0 && evidence.catalogBytes > 0)
    assert.ok(evidence.toolSchemaBytes <= 12 * 1024)
    assert.ok(evidence.nodeViewBytes <= 8 * 1024)
    assert.deepEqual(discovered, [[S4A2_SKILL_NAME]])
    assert.deepEqual(result.usage, {
      inputTokens: 90,
      outputTokens: 16,
      steps: 2,
      unknownRequests: 0,
    })
    assert.equal(createdAgents.length, 1)
    assert.ok(contexts[0]?.includes('"skills":[{"id":"skill:s4a2","name":"s4a2-bounded-skill"}]'))
    assert.ok(contexts[0]?.includes('"name":"skill"'))

    const agent = createdAgents[0]
    assert.ok(agent)
    assert.equal(spike.ctx.agents.get(sessionId as never), undefined, 'the Run must dispose its Agent')
    assert.equal(
      await spike.ctx.skills.get(S4A2_SKILL_NAME, { scope: agent, cwd: workspace }),
      undefined,
      'disposal must remove the scoped skill registration',
    )
    const workspaceEntries = await readdir(workspace, { recursive: true, withFileTypes: true })
    const homeEntries = await readdir(home, { recursive: true, withFileTypes: true })
    for (const entries of [workspaceEntries, homeEntries]) {
      assert.equal(
        entries.some(entry => entry.isFile() && (entry.name === 'SKILL.md' || entry.name === 'notes.txt')),
        false,
        'the skill bundle and referenced files must not be materialized into workspace or HOME',
      )
    }
  })
})

void test('S4-A2 unbound skill dispatch is refused before the DSH skill body', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-unbound-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Attempt an unbound skill name.',
        toolCalls: [{
          id: 's4a2-unbound-call',
          name: 'skill',
          arguments: JSON.stringify({ name: 'unbound-skill' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'The unbound skill call was refused.', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    const result = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId,
      runId,
      admission: scenario.runAdmission,
      composition: scenario.composition,
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: scenario.provider,
        verify() { throw new Error('unbound skill must not verify') },
      },
      transientInvalidReasons: [],
    })
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 2)
    const texts = messageTexts(fixture.requests[1] ?? {})
    assert.ok(texts.some(text => text.includes('INPUT_NOT_AUTHORIZED')))
    assert.equal(texts.some(text => text.includes(S4A2_SKILL_BODY)), false, texts.join('\n---\n'))
  })
})

void test('S4-A2 inherited global skills fail closed before the first model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-global-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'global leak must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    const disposeGlobal = spike.ctx.skills.register({
      name: 'inherited-global-skill',
      description: 'Unexpected global skill that must not leak into a Task scope.',
      content: '# global leak\n',
      source: 'runtime',
    })
    let result
    try {
      result = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('global leak must not verify') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      disposeGlobal()
    }
    assert.equal(fixture.requests.length, 0, 'skill discovery mismatch must not buy a model request')
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
    assert.match(result.executionRecord?.reason ?? '', /skill|discovery|binding/i)
  })
})

void test('S4-A2 resume re-registers the frozen skill with zero new requests', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-resume-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'seeded wake acknowledged', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    await seedOpenRun(storeRoot, scenario, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1, 'seeding consumes exactly one request')
    const discovered: string[][] = []
    const disposeSkills = captureAgentSkills(spike, sessionId, workspace, discovered, [])
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('resume must not verify without submission') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      disposeSkills()
    }
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 1, 'resume must not buy another request')
    assert.deepEqual(discovered, [[S4A2_SKILL_NAME]])
  })
})

void test('S4-A2 changed Composition skills close invalid before Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-mismatch-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'changed skill composition must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    await seedOpenRun(storeRoot, scenario, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1)
    const changed: CompositionPayload = {
      ...scenario.composition,
      skills: [{
        id: 'skill:other',
        digest: computeDigest('object', { v: 1, kind: 'other-skill' }),
      }],
    }
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: changed,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('changed skill composition must not verify') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }
    assert.equal(result.compositionMatched, false)
    assert.equal(result.sessionAction, 'none')
    assert.equal(spy.create + spy.resume, 0, 'composition mismatch must not create or resume an Agent')
    assert.equal(fixture.requests.length, 1, 'composition mismatch must not buy a model request')
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
  })
})

void test('S4-A2 submitted recovery verifies the frozen snapshot with skill resources and no model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-submitted-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
  await withHarness((_request, index) => ({ content: 'submitted recovery must not buy a request', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    await writeFile(join(workspace, OUTPUT_PATH), FROZEN_OUTPUT, 'utf8')
    const seeded = await seedSubmittedRun(storeRoot, scenario, { runId, sessionId, workspace })
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: await currentComposition(spike.ctx, storeRoot, scenario),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(scenario, runId, workspace, verifierCalls),
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }
    assert.equal(spy.create + spy.resume, 0)
    assert.equal(fixture.requests.length, 0)
    assert.equal(verifierCalls.length, 1)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.compositionMatched, true)
    assert.equal(result.recoveredSubmission, true)
    assert.equal(result.classification, 'verified')
    assert.ok(result.evidence)
    assert.equal(result.evidence.verification.operationId, `${runId}:verify`)
    assert.equal(seeded.manifestRef.digest, seeded.manifest.digest)
    assert.equal(seeded.manifest.runId, runId)
  })
})

void test('S4-A2 dual-skill discovery keeps template order in NodeView and guards an unbound call', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-dual-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  const first = s4a2Skill()
  const second = s4a2SecondSkill()
  await withHarness((_request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read one bound skill and attempt one unbound name.',
        toolCalls: [
          { id: 's4a2-bound-call', name: 'skill', arguments: JSON.stringify({ name: first.name }) },
          { id: 's4a2-unbound-call', name: 'skill', arguments: JSON.stringify({ name: 'unbound-skill' }) },
        ],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'Dual skill step finished without submitting.', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [first, second],
    })
    assert.deepEqual(scenario.contract.resources.skills, scenario.composition.skills)
    assert.equal(scenario.composition.skills.length, 2)
    const contexts: string[] = []
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    let result
    try {
      result = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('dual skill create must not verify') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      disposeContexts()
    }
    assert.equal(result.classification, 'failed')
    assert.equal(fixture.requests.length, 2)
    const firstTexts = messageTexts(fixture.requests[0] ?? {})
    const catalog = firstTexts.find(text => text.includes('<available_skills>'))
    assert.ok(catalog)
    assert.ok(catalog.includes(first.name))
    assert.ok(catalog.includes(second.name))
    assert.equal(firstTexts.filter(text => text.includes('<available_skills>')).length, 1)
    assert.ok(contexts[0]?.includes(
      '"skills":[{"id":"skill:s4a2","name":"s4a2-bounded-skill"},{"id":"skill:s4a2-b","name":"s4a2-second-skill"}]',
    ), 'NodeView must keep the template binding order, not the DSH name order')
    assert.ok(contexts[0]?.includes('"name":"skill"'))
    const secondTexts = messageTexts(fixture.requests[1] ?? {})
    assert.ok(secondTexts.some(text => text.includes('<skill_content') && text.includes(first.content)))
    assert.ok(secondTexts.some(text => text.includes('INPUT_NOT_AUTHORIZED')))
    assert.equal(secondTexts.some(text => text.includes('<skill_content') && text.includes('unbound-skill')), false)
  })
})

void test('S4-A2 resume with a missing frozen skill bundle fails strict store replay with zero Agent/verifier/model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-missing-bundle-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'missing bundle must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    await seedOpenRun(storeRoot, scenario, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1)
    const bundle = scenario.composition.skills[0]
    assert.ok(bundle)
    await rm(join(storeRoot, OBJECTS_DIRNAME, bundle.digest.slice('sha256:'.length)), { force: true })
    const spy = spyAgents(spike.ctx)
    let verifierCalls = 0
    try {
      await assert.rejects(
        resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() {
              verifierCalls += 1
              throw new Error('missing skill bundle must not verify')
            },
          },
          transientInvalidReasons: [],
        }),
        error => {
          assert.ok(error instanceof DomainStoreError)
          assert.equal(error.code, 'OBJECT_MISSING')
          return true
        },
      )
    } finally {
      spy.restore()
    }
    assert.equal(spy.create + spy.resume, 0, 'missing skill bundle must not create or resume an Agent')
    assert.equal(verifierCalls, 0)
    assert.equal(fixture.requests.length, 1, 'missing skill bundle must not buy another request')
    const journalText = await readFile(join(storeRoot, JOURNAL_FILENAME), 'utf8')
    const journalTypes = journalText.split('\n').filter(line => line.length > 0)
      .map(line => (JSON.parse(line) as { readonly type: string }).type)
    assert.equal(journalTypes.includes('run/closed'), false, 'strict replay must not write a closure')
    assert.equal(journalTypes.includes('task/closed'), false)
  })
})

void test('S4-A2 resume with a semantically invalid frozen skill bundle closes invalid with zero Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-invalid-bundle-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'invalid bundle must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const base = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const store = await DomainStore.open({ root: storeRoot })
    let contract: TaskContract
    let composition: CompositionPayload
    try {
      const invalidBundle = await seedRawTree(store, 'skill-bundle:semantic-invalid', [
        { path: 'other.txt', content: 'not SKILL.md' },
      ])
      const template = base.method.templates[0]
      assert.ok(template)
      const method = sealMethodRevision({
        ...methodPayload(base.method),
        id: `method:s4a2-invalid-${String(Date.now())}`,
        templates: [{
          ...template,
          skills: ['skill:semantic-invalid'],
        }],
        skills: [{
          id: 'skill:semantic-invalid',
          name: 'semantic-invalid-skill',
          description: 'A valid bundle without SKILL.md.',
          bundle: invalidBundle,
        }],
      })
      await store.putObject(method.id, jsonBytes(method), 'method')
      contract = sealTaskContract({
        ...contractPayload(base.contract),
        method: { id: method.id, digest: method.digest },
        template: { id: template.id, digest: method.digest },
        resources: {
          ...base.contract.resources,
          skills: [invalidBundle],
        },
      })
      const compositionTemplate = await seedObject(store, 'semantic-invalid-composition-template', method.templates[0])
      composition = {
        ...base.composition,
        contract: { id: contract.taskId, digest: contract.digest },
        template: compositionTemplate,
        guidance: method.templates[0]?.guidance,

        skills: [invalidBundle],
      }
    } finally {
      await store.close()
    }
    await seedOpenRun(storeRoot, { ...base, contract, composition }, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1)
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: base.provider,
          verify() { throw new Error('semantic invalid skill bundle must not verify') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }
    assert.equal(result.compositionMatched, true)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
    assert.equal(spy.create + spy.resume, 0)
    assert.equal(fixture.requests.length, 1)
    assert.match(result.executionRecord?.reason ?? '', /^resource-invalid: method:/)
  })
})

// ---------------------------------------------------------------------------
// S4-A3 — Method MCP stdio binding, native mount, guard, and lifecycle
// ---------------------------------------------------------------------------

const S4A3_APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const S4A3_TMP_ROOT = join(S4A3_APP_ROOT, '.tmp', 's4a3-tests')
const S4A3_FIXTURE_URL = new URL('./fixtures/mcp-s4a3-stdio-server.ts', import.meta.url)
const S4A3_INSTRUCTIONS = [
  'SINGULARITY S4-A3 MCP stdio fixture.',
  'Use echo for a successful structuredContent result,',
  'echo_extra to prove the frozen exposedTools surface is exact,',
  'and the note resources to exercise native resource tools.',
].join(' ')
const S4A3_RESOURCE_TOOL_NAMES = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const
const S4A3_MESSAGE_PARAMETERS = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'Text echoed back in content and structuredContent.',
    },
  },
  required: ['message'],
  additionalProperties: false,
}
const S4A3_MESSAGE_OUTPUT = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
}

function s4a3ExposedTools(): ToolAsset['server']['exposedTools'] {
  return [
    {
      name: 'echo',
      description: 'Return the supplied message as text content and structuredContent.',
      parameters: S4A3_MESSAGE_PARAMETERS,
      output: S4A3_MESSAGE_OUTPUT,
    },
    {
      name: 'echo_extra',
      description: 'Return the supplied message from a tool that may be absent from a frozen asset.',
      parameters: S4A3_MESSAGE_PARAMETERS,
      output: S4A3_MESSAGE_OUTPUT,
    },
  ]
}

async function s4a3Server(
  logPath: string,
  options: {
    readonly serverName?: string
    readonly exposedTools?: ToolAsset['server']['exposedTools']
    readonly instructions?: string
    readonly source?: string
    readonly startDelayMs?: number
    readonly siblingCheckPath?: string
  } = {},
): Promise<McpServerFixture> {
  const source = options.source ?? (await readFile(S4A3_FIXTURE_URL, 'utf8'))
  return {
    serverName: options.serverName ?? 'calc',
    exposedTools: options.exposedTools ?? s4a3ExposedTools(),
    instructions: options.instructions ?? S4A3_INSTRUCTIONS,
    capabilities: ['tools', 'resources'],
    source: source
      .replace("'__S4A3_MCP_LOG__'", JSON.stringify(logPath))
      .replace('const START_DELAY_MS = 0', `const START_DELAY_MS = ${String(options.startDelayMs ?? 0)}`)
      .replace("const SIBLING_PATH = ''", `const SIBLING_PATH = ${JSON.stringify(options.siblingCheckPath ?? '')}`),
  }
}

async function withS4a3Tmp<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR
  await mkdir(S4A3_TMP_ROOT, { recursive: true })
  process.env.TMPDIR = S4A3_TMP_ROOT
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}

interface S4A3LogRecord {
  readonly type: 'start' | 'tool' | 'resource' | 'exit' | 'env' | 'sibling'
  readonly pid: number
  readonly name?: string
  readonly method?: string
  readonly uri?: string | null
  readonly cwd?: string
  readonly cwdMode?: number
  readonly rootMode?: number
  readonly exists?: boolean
  readonly code?: number
  readonly home?: string | null
  readonly sshAuthSock?: string | null
  readonly gpgAgentInfo?: string | null
  readonly kubeconfig?: string | null
  readonly dockerHost?: string | null
  readonly xdgConfigHome?: string | null
  readonly xdgCacheHome?: string | null
  readonly xdgDataHome?: string | null
  readonly xdgStateHome?: string | null
  readonly xdgRuntimeDir?: string | null
  readonly tmpDir?: string | null
}

async function readS4a3Log(path: string): Promise<S4A3LogRecord[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const records: S4A3LogRecord[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const value = JSON.parse(line) as S4A3LogRecord
      if (typeof value.type === 'string' && typeof value.pid === 'number') records.push(value)
    } catch {
      // Ignore a partially written final line.
    }
  }
  return records
}

function s4a3ProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitForS4a3Log(
  path: string,
  predicate: (records: readonly S4A3LogRecord[]) => boolean,
  label: string,
): Promise<readonly S4A3LogRecord[]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const records = await readS4a3Log(path)
    if (predicate(records)) return records
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function mcpToolReply(
  name: string,
  args: unknown,
  id: string,
  index: number,
): ScriptedReply {
  return {
    reasoning: `Invoke ${name} through the frozen MCP binding.`,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    usage: fixtureUsage(index),
  }
}

void test('S4-A3 mounts a frozen stdio MCP server, exposes exact resources, and cleans up', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active, 'scenario must exist before planning')
      const epoch = contextEpochFrom(request)
      assert.ok(epoch, 'runtime did not deliver a contextEpoch')
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) return mcpToolReply('mcp__calc__echo', { message: 's4a3-echo-ok' }, 's4a3-echo', index)
    if (index === 3) return mcpToolReply('list_mcp_resources', { server: 'calc' }, 's4a3-list', index)
    if (index === 4) return mcpToolReply('read_mcp_resource', { server: 'calc', uri: 's4a3://note' }, 's4a3-read-note', index)
    if (index === 5) return mcpToolReply('list_mcp_resource_templates', { server: 'calc' }, 's4a3-templates', index)
    if (index === 6) return mcpToolReply('read_mcp_resource', { server: 'calc', uri: 's4a3://note/42' }, 's4a3-read-template', index)
    if (index === 7) return writeOutputReply()
    if (index === 8) return submitReply()
    return { content: 'unexpected extra model request after submit', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-server.log')
    const server = await s4a3Server(logPath)
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const active = scenario
    const composition = active.composition
    assert.equal(composition.mcpServers.length, 1)
    const compositionServer = composition.mcpServers[0]
    assert.ok(compositionServer)
    assert.equal(compositionServer.transport, 'stdio')
    assert.deepEqual(compositionServer.capabilities, ['tools', 'resources'])

    const prompts: string[] = []
    const contexts: string[] = []
    const schemaNames: string[][] = []
    const createdAgents: Agent[] = []
    const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    const disposeAgents = spike.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.session.id) === sessionId) {
        createdAgents.push(agent)
        schemaNames.push(spike.ctx.tools.schemas(agent).map(schema => schema.name))
      }
      return undefined
    })
    const events = recordSessionEvents(spike, sessionId)
    const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: active.runAdmission,
        composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(active, runId, workspace, verifierCalls),
        transientInvalidReasons: [],
      }))
    } finally {
      disposePrompts()
      disposeContexts()
      disposeAgents()
    }

    assert.equal(result.classification, 'verified', result.executionRecord?.reason)
    assert.equal(verifierCalls.length, 1)
    assert.equal(fixture.requests.length, 9, 'MCP binding must not add extra model requests')

    assert.equal(prompts.length, 1)
    const prompt = prompts[0]
    assert.ok(prompt)
    assert.equal(composition.platformPrompt, computeDigest('object', { v: 1, text: prompt }))
    assert.ok(prompt.includes('### MCP server: calc'))
    assert.ok(prompt.includes(S4A3_INSTRUCTIONS))
    assert.ok(prompt.includes('## MCP resource servers'))
    assert.ok(prompt.includes('["calc"]'))
    const firstRequest = fixture.requests[0] ?? {}
    const systemMessage = firstRequest.messages?.find(message => message.role === 'system')
    assert.ok(systemMessage)
    assert.equal(wireText(systemMessage.content), prompt)
    const visibleTools = toolSchemaNames(firstRequest)
    for (const name of ['mcp__calc__echo', 'mcp__calc__echo_extra', ...S4A3_RESOURCE_TOOL_NAMES]) {
      assert.ok(visibleTools.includes(name), `${name} must be visible to the model`)
      assert.ok(schemaNames[0]?.includes(name), `${name} must be registered in the Agent scope`)
    }
    assert.ok(Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])) <= 12 * 1024)
    assert.ok(Buffer.byteLength(contexts[0] ?? '') <= 8 * 1024)
    assert.ok(contexts[0]?.includes('mcp__calc__echo'))

    const called = toolCallNames(events.events)
    for (const name of ['mcp__calc__echo', ...S4A3_RESOURCE_TOOL_NAMES]) {
      assert.ok(called.includes(name), `${name} must be dispatched through the DSH session`)
    }
    const echoResultText = messageTexts(fixture.requests[3] ?? {})
    assert.ok(echoResultText.some(text => text.includes('s4a3-echo-ok')))
    const resourceListText = messageTexts(fixture.requests[4] ?? {})
    assert.ok(resourceListText.some(text => text.includes('s4a3://note')))
    const resourceText = messageTexts(fixture.requests[5] ?? {})
    assert.ok(resourceText.some(text => text.includes('note:s4a3://note')))
    const templateText = messageTexts(fixture.requests[6] ?? {})
    assert.ok(templateText.some(text => text.includes('s4a3://note/{id}')))
    const expandedTemplateText = messageTexts(fixture.requests[7] ?? {})
    assert.ok(expandedTemplateText.some(text => text.includes('note:42')))

    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'tool' && entry.name === 'echo')
        && entries.some(entry => entry.type === 'resource' && entry.uri === 's4a3://note')
        && entries.some(entry => entry.type === 'resource' && entry.uri === 's4a3://note/42')
        && entries.filter(entry => entry.type === 'start').length > 0,
      'MCP fixture start/tool/resource records',
    )
    const starts = [...new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))]
    const exits = new Set(records.filter(entry => entry.type === 'exit').map(entry => entry.pid))
    assert.ok(starts.length > 0, 'the fixture must have started at least once')
    const firstStart = records.find(entry => entry.type === 'start')
    assert.ok(firstStart)
    assert.equal(firstStart.rootMode, 0o700, 'the Run MCP root must be owned 0700')
    assert.equal(firstStart.cwdMode, 0o700, 'each materialized server root must be 0700')
    for (const pid of starts) {
      assert.ok(exits.has(pid), `MCP fixture PID ${String(pid)} must record its exit`)
      assert.equal(s4a3ProcessAlive(pid), false, `MCP fixture PID ${String(pid)} must exit with the Agent`)
    }
    const leftovers = await readdir(S4A3_TMP_ROOT)
    assert.equal(leftovers.some(name => name.startsWith('singularity-mcp-')), false, 'MCP resource root must be removed')
    assert.equal(spike.ctx.tools.definitions().some(definition => definition.name.startsWith('mcp__')), false)

    const agent = createdAgents[0]
    assert.ok(agent)
    assert.equal(spike.ctx.tools.get('mcp__calc__echo', agent), undefined)

    const store = await DomainStore.open({ root: storeRoot })
    try {
      const schema = await readJson(store, compositionServer.schema, 'object')
      assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema))
      const tools = (schema as { readonly tools?: readonly { readonly name?: string }[] }).tools
      assert.deepEqual(tools?.map(tool => tool.name), ['echo', 'echo_extra'])
    } finally {
      await store.close()
    }

    const metrics = {
      systemPromptBytes: Buffer.byteLength(prompt),
      nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])),
      firstRequestBytes: Buffer.byteLength(JSON.stringify(firstRequest)),
      usage: result.usage,
    }
    console.log(`S4-A3 metrics ${JSON.stringify(metrics)}`)
  })
})

void test('S4-A3 rejects an actual extra MCP tool before Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-extra-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'extra MCP tool must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-extra.log')
    const server = await s4a3Server(logPath, {
      exposedTools: s4a3ExposedTools().filter(tool => tool.name === 'echo'),
    })
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('extra MCP tool must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      dispose()
    }
    assert.equal(result.classification, 'invalid')
    assert.match(result.executionRecord?.reason ?? '', /^UNSUPPORTED_RESOURCES:/)
    assert.equal(created, 0, 'surface mismatch must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'surface mismatch must not buy a model request')
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start')
        && entries.some(entry => entry.type === 'exit'),
      'extra-tool fixture exit',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'failed setup must roll back the MCP process')
    }
    assert.equal((await readdir(S4A3_TMP_ROOT)).some(name => name.startsWith('singularity-mcp-')), false)
  })
})

void test('S4-A3 rejects frozen instructions that differ from the mounted server before Agent', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-instructions-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'instruction mismatch must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-instructions.log')
    const server = await s4a3Server(logPath, { instructions: 'S4-A3 frozen instructions that the server does not send.' })
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('instruction mismatch must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      dispose()
    }
    assert.equal(result.classification, 'invalid')
    assert.match(result.executionRecord?.reason ?? '', /^COMPOSITION_MISMATCH:/)
    assert.equal(created, 0, 'platform prompt mismatch must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'platform prompt mismatch must not buy a model request')
    await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start') && entries.some(entry => entry.type === 'exit'),
      'instruction-mismatch fixture exit',
    )
  })
})

void test('S4-A3 rolls back the first server when the second stdio server fails startup', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-multi-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'failed second server must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const firstLog = join(storeRoot, 'mcp-first.log')
    const first = await s4a3Server(firstLog)
    const second = await s4a3Server(join(storeRoot, 'mcp-second.log'), {
      serverName: 'boom',
      exposedTools: [],
      instructions: 'Boom server.',
      source: "process.stderr.write('boom\\n'); process.exit(1)\n",
    })
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      mcpServers: [first, second],
    })
    assert.equal(scenario.composition.mcpServers.length, 2)
    assert.deepEqual(
      scenario.composition.mcpServers.map(server => server.bundle),
      scenario.contract.resources.mcpServers,
    )
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('failed second server must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      dispose()
    }
    assert.equal(result.classification, 'invalid')
    assert.match(result.executionRecord?.reason ?? '', /^agent-error:/)
    assert.equal(created, 0, 'partial mount failure must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'partial mount failure must not buy a model request')
    const records = await waitForS4a3Log(
      firstLog,
      entries => entries.some(entry => entry.type === 'start')
        && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
      'first server rollback exit',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'rollback must terminate the first server process')
    }
    assert.equal((await readdir(S4A3_TMP_ROOT)).some(name => name.startsWith('singularity-mcp-')), false)
  })
})

void test('S4-A3 resume remounts the frozen stdio server with zero new requests', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-resume-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'seeded wake acknowledged', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-resume.log')
    const server = await s4a3Server(logPath)
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    await seedOpenRun(storeRoot, scenario, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1, 'seeding consumes exactly one request')
    const prompts: string[] = []
    const schemaNames: string[][] = []
    const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
    const disposeAgent = spike.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.session.id) === sessionId) {
        schemaNames.push(spike.ctx.tools.schemas(agent).map(schema => schema.name))
      }
      return undefined
    })
    let result
    try {
      result = await withS4a3Tmp(() => resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('resume must not verify without submission') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      disposePrompts()
      disposeAgent()
    }
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 1, 'resume must not buy another request')
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0]?.includes('### MCP server: calc'))
    assert.ok(schemaNames[0]?.includes('mcp__calc__echo'))
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start')
        && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
      'resume mount and disposal',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'resume must dispose the remounted server')
    }
    assert.equal((await readdir(S4A3_TMP_ROOT)).some(name => name.startsWith('singularity-mcp-')), false)
  })
})

void test('S4-A3 resume with a missing frozen MCP bundle fails strict store replay with no closure', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-missing-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'missing MCP bundle must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-missing.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    await seedOpenRun(storeRoot, scenario, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1)
    const bundle = scenario.composition.mcpServers[0]?.bundle
    assert.ok(bundle)
    await rm(join(storeRoot, OBJECTS_DIRNAME, bundle.digest.slice('sha256:'.length)), { force: true })
    const spy = spyAgents(spike.ctx)
    let verifierCalls = 0
    try {
      await assert.rejects(
        resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() {
              verifierCalls += 1
              throw new Error('missing MCP bundle must not verify')
            },
          },
          transientInvalidReasons: [],
        }),
        error => {
          assert.ok(error instanceof DomainStoreError)
          assert.equal(error.code, 'OBJECT_MISSING')
          return true
        },
      )
    } finally {
      spy.restore()
    }
    assert.equal(spy.create + spy.resume, 0, 'missing MCP bundle must not create or resume an Agent')
    assert.equal(verifierCalls, 0)
    assert.equal(fixture.requests.length, 1, 'missing MCP bundle must not buy another request')
    const journalText = await readFile(join(storeRoot, JOURNAL_FILENAME), 'utf8')
    const journalTypes = journalText.split('\n').filter(line => line.length > 0)
      .map(line => (JSON.parse(line) as { readonly type: string }).type)
    assert.equal(journalTypes.includes('run/closed'), false, 'strict replay must not write a closure')
    assert.equal(journalTypes.includes('task/closed'), false)
  })
})

void test('S4-A3 denies an unbound resource server while the bound server still dispatches', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-guard-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-guard-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active)
      const epoch = contextEpochFrom(request)
      assert.ok(epoch)
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) return mcpToolReply('list_mcp_resources', { server: 'other' }, 's4a3-unbound-resource', index)
    if (index === 3) return mcpToolReply('read_mcp_resource', { server: 'calc', uri: 's4a3://note' }, 's4a3-bound-resource', index)
    if (index === 4) {
      return {
        reasoning: 'Stop after exercising the MCP dispatch guard.',
        toolCalls: [{
          id: 's4a3-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'S4-A3 guard check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra model request after stop', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-guard.log')
    const server = await s4a3Server(logPath)
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const active = scenario
    const result = await withS4a3Tmp(() => executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId,
      runId,
      admission: active.runAdmission,
      composition: active.composition,
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: active.provider,
        verify() { throw new Error('stopped guard run must not verify') },
      },
      transientInvalidReasons: [],
    }))
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.match(result.executionRecord?.reason ?? '', /^stop:blocked:/)
    assert.equal(fixture.requests.length, 5)
    const denied = messageTexts(fixture.requests[3] ?? {})
    assert.ok(denied.some(text => text.includes('INPUT_NOT_AUTHORIZED')), 'unbound resource server must be denied before dispatch')
    const bound = messageTexts(fixture.requests[4] ?? {})
    assert.ok(bound.some(text => text.includes('note:s4a3://note')), 'the bound resource server must still dispatch')
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'resource' && entry.uri === 's4a3://note')
        && entries.some(entry => entry.type === 'exit'),
      'guarded fixture resource and exit',
    )
    assert.equal(records.filter(entry => entry.type === 'resource' && entry.uri === 's4a3://note').length, 1)
  })
})

for (const variant of [
  {
    name: 'a missing frozen tool',
    exposedTools: (): ToolAsset['server']['exposedTools'] => [
      ...s4a3ExposedTools(),
      {
        name: 'missing',
        description: 'A frozen tool the server does not expose.',
        parameters: S4A3_MESSAGE_PARAMETERS,
        output: S4A3_MESSAGE_OUTPUT,
      },
    ],
  },
  {
    name: 'a drifted description',
    exposedTools: (): ToolAsset['server']['exposedTools'] => [
      { ...s4a3ExposedTools()[0], description: 'A description the server does not send.' },
      s4a3ExposedTools()[1],
    ],
  },
  {
    name: 'drifted parameters',
    exposedTools: (): ToolAsset['server']['exposedTools'] => [
      {
        ...s4a3ExposedTools()[0],
        parameters: {
          type: 'object',
          properties: { other: { type: 'string' } },
          required: ['other'],
          additionalProperties: false,
        },
      },
      s4a3ExposedTools()[1],
    ],
  },
] as const) {
  void test(`S4-A3 rejects ${variant.name} before Agent or model`, { timeout: 240_000 }, async () => {
    const taskId = `task-s4a3-surface-${variant.name.replace(/ /g, '-')}-${String(process.pid)}-${String(Date.now())}`
    const sessionId = `${taskId}-session`
    const runId = `${taskId}-run`
    await withHarness((_request, index) => ({ content: 'surface mismatch must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
      const logPath = join(storeRoot, 'mcp-surface.log')
      const server = await s4a3Server(logPath, { exposedTools: variant.exposedTools() })
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
      let created = 0
      const dispose = spike.ctx.on('agent/created', () => {
        created += 1
        return undefined
      })
      let result
      try {
        result = await withS4a3Tmp(() => executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('surface mismatch must not verify') },
          },
          transientInvalidReasons: [],
        }))
      } finally {
        dispose()
      }
      assert.equal(result.classification, 'invalid')
      assert.match(result.executionRecord?.reason ?? '', /^UNSUPPORTED_RESOURCES:/)
      assert.equal(created, 0, 'surface mismatch must not publish an Agent')
      assert.equal(fixture.requests.length, 0, 'surface mismatch must not buy a model request')
      await waitForS4a3Log(
        logPath,
        entries => entries.some(entry => entry.type === 'start')
          && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
        'surface mismatch fixture exit',
      )
    })
  })
}

void test('S4-A3 resume with a missing MCP bundle file fails strict replay with no closure', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-missing-leaf-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'missing MCP file must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-missing-leaf.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    await seedOpenRun(storeRoot, scenario, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1)
    const bundle = scenario.composition.mcpServers[0]?.bundle
    assert.ok(bundle)
    const store = await DomainStore.open({ root: storeRoot })
    let leaf: Ref | undefined
    try {
      const tree = await readJson(store, bundle, 'object') as {
        readonly files?: readonly { readonly object?: Ref }[]
      }
      leaf = tree.files?.[0]?.object
    } finally {
      await store.close()
    }
    assert.ok(leaf, 'MCP bundle must declare a file leaf')
    await rm(join(storeRoot, OBJECTS_DIRNAME, leaf.digest.slice('sha256:'.length)), { force: true })
    const spy = spyAgents(spike.ctx)
    let verifierCalls = 0
    try {
      await assert.rejects(
        resumeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          runId,
          workspace,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() {
              verifierCalls += 1
              throw new Error('missing MCP file must not verify')
            },
          },
          transientInvalidReasons: [],
        }),
        error => {
          assert.ok(error instanceof DomainStoreError)
          assert.equal(error.code, 'OBJECT_MISSING')
          return true
        },
      )
    } finally {
      spy.restore()
    }
    assert.equal(spy.create + spy.resume, 0, 'missing MCP file must not create or resume an Agent')
    assert.equal(verifierCalls, 0)
    assert.equal(fixture.requests.length, 1, 'missing MCP file must not buy another request')
    const journalText = await readFile(join(storeRoot, JOURNAL_FILENAME), 'utf8')
    const journalTypes = journalText.split('\n').filter(line => line.length > 0)
      .map(line => (JSON.parse(line) as { readonly type: string }).type)
    assert.equal(journalTypes.includes('run/closed'), false, 'strict replay must not write a closure')
    assert.equal(journalTypes.includes('task/closed'), false)
  })
})

void test('S4-A3 submitted recovery validates frozen MCP resources with no Agent or model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-submitted-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
  await withHarness((_request, index) => ({ content: 'submitted recovery must not buy a request', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-submitted.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    await writeFile(join(workspace, OUTPUT_PATH), FROZEN_OUTPUT, 'utf8')
    const seeded = await seedSubmittedRun(storeRoot, scenario, { runId, sessionId, workspace })
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition: await currentComposition(spike.ctx, storeRoot, scenario),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(scenario, runId, workspace, verifierCalls),
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }
    assert.equal(spy.create + spy.resume, 0)
    assert.equal(fixture.requests.length, 0)
    assert.equal(verifierCalls.length, 1)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.compositionMatched, true)
    assert.equal(result.recoveredSubmission, true)
    assert.equal(result.classification, 'verified')
    assert.ok(result.evidence)
    assert.equal(result.evidence.verification.operationId, `${runId}:verify`)
    assert.equal(seeded.manifestRef.digest, seeded.manifest.digest)
  })
})

void test('S4-A3 resume with a semantically invalid MCP asset closes invalid with no Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-invalid-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  await withHarness((_request, index) => ({ content: 'semantic invalid MCP asset must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const base = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
    const store = await DomainStore.open({ root: storeRoot })
    let contract: TaskContract
    let composition: CompositionPayload
    try {
      const seeded = await seedMcpServer(store, await s4a3Server(join(storeRoot, 'mcp-invalid.log')))
      const asset: ToolAsset = {
        ...seeded.asset,
        server: { ...seeded.asset.server, transport: 'streamable-http' },
      }
      const template = {
        ...base.method.templates[0],
        tools: [asset.id],
        skills: [],
      }
      assert.ok(template)
      const templateRef = await seedObject(store, 'semantic-invalid-mcp-template', template)
      const method = sealMethodRevision({
        ...methodPayload(base.method),
        id: `method:s4a3-invalid-${String(Date.now())}`,
        templates: [template],
        tools: [asset],
      })
      await store.putObject(method.id, jsonBytes(method), 'method')
      contract = sealTaskContract({
        ...contractPayload(base.contract),
        method: { id: method.id, digest: method.digest },
        template: { id: template.id, digest: method.digest },
        resources: {
          ...base.contract.resources,
          mcpServers: [seeded.bundle],
        },
      })
      const schema = seal('object', { v: 1, serverName: asset.server.manifest.id, tools: [] })
      const schemaRef = await store.putObject('semantic-invalid-mcp-schema', jsonBytes(schema), 'object')
      composition = {
        ...base.composition,
        contract: { id: contract.taskId, digest: contract.digest },
        template: templateRef,
        guidance: template.guidance,
        skills: [],
        mcpServers: [{
          manifest: asset.server.manifest,
          bundle: asset.server.bundle,
          schema: schemaRef,
          config: asset.server.config,
          transport: 'streamable-http',
          capabilities: [...asset.server.capabilities],
        }],
      }
    } finally {
      await store.close()
    }
    await seedOpenRun(storeRoot, { ...base, contract, composition }, { runId, sessionId })
    await seedConsumedStartWake(spike, { taskId, runId, sessionId, workspace, live: false })
    assert.equal(fixture.requests.length, 1)
    const spy = spyAgents(spike.ctx)
    let result
    try {
      result = await resumeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        runId,
        workspace,
        composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: base.provider,
          verify() { throw new Error('semantic invalid MCP asset must not verify') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      spy.restore()
    }
    assert.equal(result.compositionMatched, true)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
    assert.equal(spy.create + spy.resume, 0)
    assert.equal(fixture.requests.length, 1)
    assert.match(result.executionRecord?.reason ?? '', /^resource-invalid: method:/)
  })
})

void test('S4-A3 clears credential channels and redirects XDG paths into the Run HOME', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-env-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-env-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active)
      const epoch = contextEpochFrom(request)
      assert.ok(epoch)
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) {
      return {
        reasoning: 'Stop after mounting the MCP server.',
        toolCalls: [{
          id: 's4a3-env-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'S4-A3 env check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra model request after stop', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-env.log')
    const server = await s4a3Server(logPath)
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const active = scenario
    const sentinels = {
      SSH_AUTH_SOCK: '/tmp/s4a3-ssh-auth-sock-sentinel',
      GPG_AGENT_INFO: '/tmp/s4a3-gpg-agent-sentinel:1:1',
      KUBECONFIG: '/tmp/s4a3-kubeconfig-sentinel',
      DOCKER_HOST: 'tcp://s4a3-docker-sentinel:2375',
    }
    const previous = Object.fromEntries(Object.keys(sentinels).map(name => [name, process.env[name]]))
    Object.assign(process.env, sentinels)
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: active.runAdmission,
        composition: active.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() { throw new Error('stopped env run must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 3)
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'env') && entries.some(entry => entry.type === 'exit'),
      'MCP fixture env record',
    )
    const env = records.find(entry => entry.type === 'env')
    assert.ok(env)
    assert.ok(env.home?.includes('singularity-mcp-'))
    assert.notEqual(env.home, process.env.HOME)
    const clearedFields = {
      sshAuthSock: sentinels.SSH_AUTH_SOCK,
      gpgAgentInfo: sentinels.GPG_AGENT_INFO,
      kubeconfig: sentinels.KUBECONFIG,
      dockerHost: sentinels.DOCKER_HOST,
    }
    const observedEnv = env as unknown as Record<string, string | null>
    for (const [field, sentinel] of Object.entries(clearedFields)) {
      const value = observedEnv[field]
      assert.ok(value === '' || value === null, `${field} must be cleared, received ${JSON.stringify(value)}`)
      assert.notEqual(value, sentinel)
    }
    const home = env.home
    assert.ok(home)
    assert.equal(env.xdgConfigHome, join(home, '.config'))
    assert.equal(env.xdgCacheHome, join(home, '.cache'))
    assert.equal(env.xdgDataHome, join(home, '.local/share'))
    assert.equal(env.xdgStateHome, join(home, '.local/state'))
    assert.equal(env.xdgRuntimeDir, join(home, 'run'))
    assert.equal(env.tmpDir, join(home, 'tmp'))
  })
})

async function s4a3RootLeftovers(): Promise<string[]> {
  try {
    return (await readdir(S4A3_TMP_ROOT)).filter(name => name.startsWith('singularity-mcp-'))
  } catch {
    return []
  }
}

async function waitForS4a3RootsGone(label: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await s4a3RootLeftovers()).length === 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`timed out waiting for ${label}`)
}

void test('S4-A3 deadline during MCP acquisition cleans a late handle within bounded grace', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-timeout-clean-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'timed-out acquisition must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-timeout-clean.log')
    const server = await s4a3Server(logPath, { startDelayMs: 2_500 })
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      deadlineAt: Date.now() + 1_000,
      mcpServers: [server],
    })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('timed-out acquisition must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      dispose()
    }
    assert.equal(result.classification, 'invalid', result.executionRecord?.reason)
    assert.equal(result.executionRecord?.drainPending, true, 'deadline acquisition must be reported as pending teardown')
    assert.equal(created, 0, 'timed-out acquisition must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'timed-out acquisition must not buy a model request')
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start')
        && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
      'timed-out fixture exit',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'late acquisition must dispose the fixture process')
    }
    await waitForS4a3RootsGone('late acquisition resource root cleanup')
    assert.equal((await s4a3RootLeftovers()).length, 0)
  })
})

void test('S4-A3 quarantines the MCP root when acquisition never settles', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-timeout-quarantine-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'quarantined acquisition must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-timeout-quarantine.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      deadlineAt: Date.now() + 200,
      mcpServers: [server],
    })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })
    const agents = spike.ctx.agents
    const originalCreate = agents.create.bind(agents)
    agents.create = (() => new Promise<never>(() => {})) as typeof agents.create
    let result
    try {
      try {
        result = await withS4a3Tmp(() => executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('quarantined acquisition must not verify') },
          },
          transientInvalidReasons: [],
        }))
      } finally {
        agents.create = originalCreate
      }
    } finally {
      dispose()
    }
    assert.equal(result.classification, 'invalid', result.executionRecord?.reason)
    assert.equal(created, 0, 'quarantined acquisition must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'quarantined acquisition must not buy a model request')
    assert.match(result.executionRecord?.reason ?? '', /MCP resource root quarantined/)
    const leftovers = await s4a3RootLeftovers()
    assert.equal(leftovers.length, 1, 'unsettled acquisition must retain its resource root')
    for (const name of leftovers) {
      await rm(join(S4A3_TMP_ROOT, name), { recursive: true, force: true })
    }
    assert.equal((await s4a3RootLeftovers()).length, 0)
  })
})

void test('S4-A3 materializes every server before mount and isolates server roots', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-two-paths-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-two-paths-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active)
      const epoch = contextEpochFrom(request)
      assert.ok(epoch)
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) {
      return {
        reasoning: 'Stop after mounting both servers.',
        toolCalls: [{
          id: 's4a3-two-paths-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'S4-A3 two-server path check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra model request after stop', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const firstLog = join(storeRoot, 'mcp-first.log')
    const secondLog = join(storeRoot, 'mcp-second.log')
    const first = await s4a3Server(firstLog, { serverName: 'calc', siblingCheckPath: '../1-other/server.ts' })
    const second = await s4a3Server(secondLog, { serverName: 'other' })
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      mcpServers: [first, second],
    })
    const active = scenario
    assert.equal(active.composition.mcpServers.length, 2)
    const result = await withS4a3Tmp(() => executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId,
      runId,
      admission: active.runAdmission,
      composition: active.composition,
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: active.provider,
        verify() { throw new Error('stopped two-server run must not verify') },
      },
      transientInvalidReasons: [],
    }))
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 3)
    const firstRecords = await waitForS4a3Log(
      firstLog,
      entries => entries.some(entry => entry.type === 'sibling') && entries.some(entry => entry.type === 'exit'),
      'first server sibling record and exit',
    )
    const sibling = firstRecords.find(entry => entry.type === 'sibling')
    assert.ok(sibling)
    assert.equal(sibling.exists, true, 'the second bundle must exist before the first server starts')
    const firstStart = firstRecords.find(entry => entry.type === 'start')
    assert.ok(firstStart)
    assert.ok(firstStart.cwd?.endsWith('/0-calc'))
    const secondRecords = await waitForS4a3Log(
      secondLog,
      entries => entries.some(entry => entry.type === 'start') && entries.some(entry => entry.type === 'exit'),
      'second server start and exit',
    )
    const secondStart = secondRecords.find(entry => entry.type === 'start')
    assert.ok(secondStart)
    assert.ok(secondStart.cwd?.endsWith('/1-other'))
    assert.notEqual(firstStart.cwd, secondStart.cwd)
  })
})

void test('S4-A3 host disposes partial prompt sections when MCP section registration conflicts', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-section-conflict-${String(process.pid)}-${String(Date.now())}`
  await withHarness((_request, index) => ({ content: 'section conflict must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-section-conflict.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const duplicate = spike.ctx.systemPrompt.section({
      name: 'mcp:calc',
      order: spike.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      text: 'host duplicate MCP section',
      interpolate: false,
    })
    const store = await DomainStore.open({ root: storeRoot })
    try {
      await assert.rejects(
        buildSingleRunComposition(spike.ctx, {
          store,
          id: 's4a3-section-conflict',
          contract: scenario.contract,
          agentOptions: agentOptions(),
          base: { v: 1, seed: scenario.contract.environment.seed },
        }),
        /already|duplicate|registered/i,
      )
      const assembly = await spike.ctx.systemPrompt.assemble()
      assert.equal(
        assembly.sections.some(section => section.name === METHOD_GUIDANCE_SECTION),
        false,
        'partially registered guidance must be disposed after a later section conflict',
      )
      const duplicates = assembly.sections.filter(section => section.name === 'mcp:calc')
      assert.equal(duplicates.length, 1)
      assert.equal(duplicates[0]?.text, 'host duplicate MCP section')
    } finally {
      duplicate()
      await store.close()
    }
    assert.equal(fixture.requests.length, 0, 'section conflict must not buy a model request')
  })
})

void test('S4-A3 retains the MCP root when a late handle dispose rejects', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-late-dispose-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'late dispose failure must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-late-dispose.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      deadlineAt: Date.now() + 300,
      mcpServers: [server],
    })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })
    const agents = spike.ctx.agents
    const originalCreate = agents.create.bind(agents)
    agents.create = (() => new Promise<AgentHandle>(resolve => {
      setTimeout(() => {
        resolve({
          agent: { session: { id: sessionId, snapshotEvents: () => [] } } as unknown as Agent,
          dispose: () => Promise.reject(new Error('injected late dispose failure')),
        } as AgentHandle)
      }, 700)
    })) as typeof agents.create
    let result
    try {
      try {
        result = await withS4a3Tmp(() => executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('late dispose failure must not verify') },
          },
          transientInvalidReasons: [],
        }))
      } finally {
        agents.create = originalCreate
      }
    } finally {
      dispose()
    }
    assert.equal(result.classification, 'invalid', result.executionRecord?.reason)
    const record = result.executionRecord
    assert.ok(record)
    assert.equal(record.drainPending, true)
    assert.equal(created, 0, 'late dispose failure must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'late dispose failure must not buy a model request')
    assert.match(record.reason, /MCP resource root quarantined/)
    assert.match(record.reason, /injected late dispose failure/)
    const leftovers = await s4a3RootLeftovers()
    assert.equal(leftovers.length, 1, 'dispose rejection must retain the MCP resource root')
    for (const name of leftovers) {
      await rm(join(S4A3_TMP_ROOT, name), { recursive: true, force: true })
    }
    assert.equal((await s4a3RootLeftovers()).length, 0)
  })
})
