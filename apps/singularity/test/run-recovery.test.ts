import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

import { bootSpikeProfile } from '../src/host-composition.ts'

const PROVIDER_ID = 'verifier:s3-c-fixture'
const CRITERION_ID = 'declared-output'
const OUTPUT_ID = 'result'
const OUTPUT_PATH = 'result.txt'
const FROZEN_OUTPUT = 'frozen-output-before-verify'
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

interface WireToolCall {
  readonly function?: {
    readonly name?: string
    readonly arguments?: string
  }
}

interface WireMessage {
  readonly role?: string
  readonly content?: string | readonly { readonly type?: string; readonly text?: string }[] | null
  readonly tool_calls?: readonly WireToolCall[]
}

interface WireRequest {
  readonly model?: unknown
  readonly messages?: readonly WireMessage[]
  readonly tools?: readonly WireToolCall[]
  readonly [key: string]: unknown
}

interface ScriptedReply {
  readonly reasoning?: string
  readonly content?: string
  readonly toolCalls?: readonly {
    readonly id: string
    readonly name: string
    readonly arguments: string
  }[]
  readonly usage?: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly totalTokens: number
    readonly cachedTokens?: number
  }
}

type ReplyScript = (request: WireRequest, index: number) => ScriptedReply

interface DynamicChatFixture {
  readonly baseURL: string
  readonly requests: readonly WireRequest[]
  close(): Promise<void>
}

function wireText(content: WireMessage['content']): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return content.map(part => part.text ?? '').join('')
}

function messageTexts(request: WireRequest): string[] {
  const texts: string[] = []
  for (const message of request.messages ?? []) {
    const text = wireText(message.content)
    if (text.length > 0) texts.push(text)
    for (const call of message.tool_calls ?? []) {
      if (call.function?.arguments !== undefined) texts.push(call.function.arguments)
    }
  }
  return texts
}

function toolSchemaNames(request: WireRequest): string[] {
  return (request.tools ?? [])
    .map(tool => tool.function?.name)
    .filter((name): name is string => name !== undefined)
}

function contextEpochFrom(request: WireRequest): string | undefined {
  for (const text of messageTexts(request)) {
    const patterns = [
      /"contextEpoch"\s*:\s*"([^"]+)"/,
      /\\"contextEpoch\\"\s*:\s*\\"([^"\\]+)\\"/,
      /contextEpoch\s*[:=]\s*"([^"]+)"/,
      /contextEpoch[^A-Za-z0-9]{0,4}([A-Za-z0-9][A-Za-z0-9:_-]{7,})/,
    ]
    for (const pattern of patterns) {
      const match = pattern.exec(text)
      if (match?.[1] !== undefined) return match[1]
    }
  }
  return undefined
}

function sseChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function usageChunk(
  id: string,
  model: string,
  usage: NonNullable<ScriptedReply['usage']>,
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cachedTokens === undefined
        ? {}
        : { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }),
    },
  })}\n\n`
}

function replyChunks(id: string, model: string, reply: ScriptedReply): string[] {
  const chunks: string[] = []
  const calls = reply.toolCalls ?? []
  chunks.push(sseChunk(id, model, {
    role: 'assistant',
    ...(reply.reasoning === undefined ? {} : { reasoning_content: reply.reasoning }),
    ...(reply.content === undefined ? {} : { content: reply.content }),
    ...(reply.content === undefined && calls.length === 0 && reply.reasoning === undefined
      ? { content: '' }
      : {}),
  }))
  if (calls.length > 0) {
    chunks.push(sseChunk(id, model, {
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    }, 'tool_calls'))
  } else {
    chunks.push(sseChunk(id, model, {}, 'stop'))
  }
  if (reply.usage !== undefined) chunks.push(usageChunk(id, model, reply.usage))
  return chunks
}

async function startDynamicChatFixture(script: ReplyScript): Promise<DynamicChatFixture> {
  const requests: WireRequest[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (part: string) => { body += part })
    request.on('end', () => {
      let parsed: WireRequest
      try {
        parsed = JSON.parse(body) as WireRequest
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid JSON"}')
        return
      }
      const index = requests.length
      requests.push(parsed)
      const reply = script(parsed, index)
      const model = typeof parsed.model === 'string' ? parsed.model : 'deepseek-v4.1-flash'
      const id = `chatcmpl-s3c-${String(index + 1)}`
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const data of replyChunks(id, model, reply)) response.write(data)
      response.end('data: [DONE]\n\n')
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
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

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
  options: { readonly taskId: string; readonly maxRuns: number },
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
    const dshConfig = await seedObject(store, 'dsh-config:s3c', { v: 1, config: 'profile' })
    const modelRoute = await seedObject(store, 'model-route:s3c', { v: 1, route: 'singularity-local' })
    const resources = await seedObject(store, 'resources:s3c', { v: 1, resources: [] })
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
        maxStepsPerRun: 12,
        maxTokens: 1_000_000,
        deadlineAt: Date.now() + 10 * 60 * 1000,
        maxDepth: 1,
        maxTasks: 1,
        maxBatchChildren: 1,
      },
    }

    const contract = admitRootTask(rootAdmission)
    const compositionTemplate = await seedObject(store, 'composition-template:s3c', {
      v: 1,
      templateId: 'template:s3c',
    })
    const composition: CompositionPayload = {
      v: 1,
      dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-alpha.2', config: dshConfig },
      platformPrompt: computeDigest('object', { platformPrompt: 's3-c-run-recovery' }),
      contract: { id: contract.taskId, digest: contract.digest },
      template: compositionTemplate,
      skills: [],
      mcpServers: [],
      modelRoute,
      resources,
      seed,
    }
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
  readonly fixture: DynamicChatFixture
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
  const fixture = await startDynamicChatFixture(script)
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

function agentOptions(): AgentOptions {
  return {
    provider: 'singularity-local',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: ReasoningEffortId('max'),
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
    scenario = await makeScenario(storeRoot, { taskId, maxRuns: 2 })
    const active = scenario

    const first = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId: firstSessionId,
      runId: firstRunId,
      admission: active.runAdmission,
      composition: active.composition,
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
        composition: active.composition,
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
    scenario = await makeScenario(storeRoot, { taskId, maxRuns: 1 })
    const active = scenario
    await seedOpenRun(storeRoot, active, { runId, sessionId })

    const changedComposition: CompositionPayload = {
      ...active.composition,
      platformPrompt: computeDigest('object', { platformPrompt: 's3-c-changed-composition' }),
    }
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
        agentOptions: agentOptions(),
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
    scenario = await makeScenario(storeRoot, { taskId, maxRuns: 1 })
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
        composition: active.composition,
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
    scenario = await makeScenario(storeRoot, { taskId, maxRuns: 1 })
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
        composition: active.composition,
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
