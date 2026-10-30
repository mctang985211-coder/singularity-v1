import assert from 'node:assert/strict'
import { access, appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
  submissionManifestSchema,
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
  SubmissionManifest,
  TaskContract,
} from '@singularity/protocol'
import {
  CommandService,
  DomainStore,
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
  },
): Promise<Scenario> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    const guidance = await seedObject(store, 'guidance:s3c', { v: 1, text: 'Write the declared output.' })
    const example = await seedObject(store, 'example:s3c', { v: 1, goal: 'fixture example' })
    const acceptancePolicy = await seedObject(store, 'acceptance-policy:s3c', { v: 1, kind: 'fixture-policy' })
    const verifierObject = seal('object', {
      v: 1,
      kind: 'verifier-identity',
      name: PROVIDER_ID,
    })
    await store.putObject(PROVIDER_ID, jsonBytes(verifierObject), 'object')
    const provider: Ref = { id: PROVIDER_ID, digest: verifierObject.digest }

    const method = sealMethodRevision({
      v: 1,
      id: 'method:s3c',
      entryTemplateId: 'template:s3c',
      templates: [{
        id: 'template:s3c',
        brief: 'Produce one declared file.',
        guidance,
        example,
        instanceSchema: {},
        requiredCriteria: [],
        requiredOutputs: [],
        acceptancePolicy,
        skills: [],
        tools: [],
        children: [],
      }],
      skills: [],
      tools: [],
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
      resources: { baseTools: [bashTool], skills: [], mcpServers: [] },
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
    const compositionTemplate = await seedObject(store, 'composition-template:s3c', method.templates[0])
    const composition = await buildSingleRunComposition(ctx, {
      writer: store,
      id: 's3c',
      agentOptions: agentOptions(),
      base: {
        v: 1,
        contract: { id: contract.taskId, digest: contract.digest },
        template: compositionTemplate,
        skills: [],
        mcpServers: [],
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

async function currentComposition(ctx: Context, storeRoot: string, base: CompositionPayload): Promise<CompositionPayload> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    return await buildSingleRunComposition(ctx, { writer: store, id: 's3c', agentOptions: agentOptions(), base })
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
      composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        writer: store,
        id: 's3c',
        agentOptions: changedOptions,
        base: active.composition,
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
          writer: store, id: 's3c', agentOptions: changedOptions, base: active.composition,
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
        composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
          composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        composition: await currentComposition(spike.ctx, storeRoot, active.composition),
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
        writer: store,
        id: 's3c-changed',
        agentOptions: changedOptions,
        base: active.composition,
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
