import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
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
  validateSubmissionManifest,
  verifyDigest,
} from '@singularity/protocol'
import type {
  CompositionPayload,
  ExecutionRecord,
  Fact,
  JsonValue,
  MethodRevision,
  Ref,
  RootAdmissionInput,
  TaskContract,
} from '@singularity/protocol'
import { DomainStore, executeSingleRun } from '@singularity/runtime'
import type {
  RunVerifier,
  SingleRunAdmission,
  VerifierRequest,
} from '@singularity/runtime'

import { bootSpikeProfile } from '../src/host-composition.ts'

const PROVIDER_ID = 'verifier:s3-b2-fixture'
const CRITERION_ID = 'declared-output'
const OUTPUT_ID = 'result'
const OUTPUT_PATH = 'result.txt'
const FROZEN_OUTPUT = 'frozen-output-before-verify'
const LIVE = process.env.SINGULARITY_SPIKE_LIVE === '1'
const VERIFIED_TEST_TIMEOUT_MS = LIVE ? 900_000 : 240_000

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
  readonly hang?: true
  readonly httpError?: true
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

function toolNames(request: WireRequest): string[] {
  const names: string[] = []
  for (const message of request.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      if (call.function?.name !== undefined) names.push(call.function.name)
    }
  }
  return names
}

function toolSchemaNames(request: WireRequest): string[] {
  return (request.tools ?? [])
    .map(tool => tool.function?.name)
    .filter((name): name is string => name !== undefined)
}

/**
 * Extract the runtime-owned context epoch from a prior tool result. The test
 * never guesses this value: it only forwards what the runtime already
 * delivered to the scripted model.
 */
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

/** Minimal dynamic chat endpoint; every request is captured for assertions. */
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
      if (reply.httpError) {
        response.writeHead(500).end('{"error":{"message":"fixture failure"}}')
        return
      }
      if (reply.hang) {
        const timer = setTimeout(() => { response.destroy() }, 4000)
        response.once('close', () => { clearTimeout(timer) })
        return
      }
      const model = typeof parsed.model === 'string' ? parsed.model : 'deepseek-v4.1-flash'
      const id = `chatcmpl-s3b2-${String(index + 1)}`
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
  options: {
    readonly taskId: string
    readonly limits?: Partial<TaskContract['limits']>
    readonly reservation?: Partial<SingleRunAdmission['budgetReservation']>
  },
): Promise<Scenario> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    const guidance = await seedObject(store, 'guidance:s3b2', { v: 1, text: 'Write the declared output.' })
    const example = await seedObject(store, 'example:s3b2', { v: 1, goal: 'fixture example' })
    const acceptancePolicy = await seedObject(store, 'acceptance-policy:s3b2', { v: 1, kind: 'fixture-policy' })
    const verifierObject = seal('object', {
      v: 1,
      kind: 'verifier-identity',
      name: PROVIDER_ID,
    })
    await store.putObject(PROVIDER_ID, jsonBytes(verifierObject), 'object')
    const provider: Ref = { id: PROVIDER_ID, digest: verifierObject.digest }

    const method = sealMethodRevision({
      v: 1,
      id: 'method:s3b2',
      entryTemplateId: 'template:s3b2',
      templates: [{
        id: 'template:s3b2',
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
    const seed = await seedObject(store, 'seed:s3b2', { v: 1, seed: 's3b2-seed' })
    const profile = await seedObject(store, 'profile:s3b2', { v: 1, profile: 's3b2-profile' })
    const request = await seedObject(store, 'request:s3b2', { v: 1, request: 'single run fixture' })
    const dshConfig = await seedObject(store, 'dsh-config:s3b2', { v: 1, config: 'profile' })
    const modelRoute = await seedObject(store, 'model-route:s3b2', { v: 1, route: 'singularity-local' })
    const resources = await seedObject(store, 'resources:s3b2', { v: 1, resources: [] })
    const bashTool = await seedObject(store, 'base-tool:bash', { v: 1, name: 'bash' })

    const rootAdmission: RootAdmissionInput = {
      taskId: options.taskId,
      spec: {
        goal: {
          summary: `Use the native bash tool to write exactly ${JSON.stringify(FROZEN_OUTPUT)} to ${OUTPUT_PATH} with no trailing newline, then submit the declared output.`,
          deliverable: OUTPUT_PATH,
          scope: ['single run'],
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
      template: { id: 'template:s3b2', digest: method.digest },
      resources: { baseTools: [bashTool], skills: [], mcpServers: [] },
      acceptance: provider,
      environment: { seed, profile },
      limits: {
        maxRuns: 1,
        maxStepsPerRun: 12,
        maxTokens: 1_000_000,
        deadlineAt: Date.now() + 10 * 60 * 1000,
        maxDepth: 1,
        maxTasks: 1,
        maxBatchChildren: 1,
        ...options.limits,
      },
    }

    const contract = admitRootTask(rootAdmission)
    const compositionTemplate = await seedObject(store, 'composition-template:s3b2', {
      v: 1,
      templateId: 'template:s3b2',
    })
    const composition: CompositionPayload = {
      v: 1,
      dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-alpha.2', config: dshConfig },
      platformPrompt: computeDigest('object', { platformPrompt: 's3-b2-single-run' }),
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
        ...options.reservation,
      },
      acceptanceBytes: jsonBytes(verifierObject),
      workspaceSeedBytes: jsonBytes({ v: 1, seed: 's3b2-seed' }),
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
      id: 's3b2-plan',
      name: 'singularity_plan',
      arguments: JSON.stringify({ sketch }),
    }],
    usage: fixtureUsage(1),
  }
}

/** First two model steps shared by every submitted Run. */
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
        id: 's3b2-read',
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
      id: 's3b2-bash',
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
      id: 's3b2-submit',
      name: 'singularity_submit',
      arguments: JSON.stringify({ outputIds: [OUTPUT_ID], includeLearningDrafts: false }),
    }],
    usage: fixtureUsage(3),
  }
}

interface Harness {
  readonly spike: Awaited<ReturnType<typeof bootSpikeProfile>>
  readonly fixture?: DynamicChatFixture
  readonly workspace: string
  readonly home: string
  readonly storeRoot: string
}

interface FixtureHarness extends Harness {
  readonly fixture: DynamicChatFixture
}

interface LiveHarness extends Harness {
  readonly fixture?: undefined
}

interface LiveCredentials {
  readonly baseURL: string
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

async function withHarness(
  script: ReplyScript,
  run: (harness: FixtureHarness) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 's3b2-work-'))
  const home = await mkdtemp(join(tmpdir(), 's3b2-home-'))
  const storeRoot = await mkdtemp(join(tmpdir(), 's3b2-store-'))
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

async function withLiveHarness(
  credentials: LiveCredentials,
  run: (harness: LiveHarness) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 's3b2-work-'))
  const home = await mkdtemp(join(tmpdir(), 's3b2-home-'))
  const storeRoot = await mkdtemp(join(tmpdir(), 's3b2-store-'))
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  try {
    spike = await bootSpikeProfile({
      home,
      baseURL: credentials.baseURL,
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

function agentOptions(): AgentOptions {
  return {
    provider: 'singularity-local',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: ReasoningEffortId('max'),
  }
}

async function readRunFacts(storeRoot: string): Promise<readonly Fact[]> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    return store.facts()
  } finally {
    await store.close()
  }
}

function runFactOf(facts: readonly Fact[]): Extract<Fact, { type: 'run/closed' }> {
  const fact = facts.find(candidate => candidate.type === 'run/closed')
  assert.ok(fact, 'run/closed fact must exist')
  return fact
}

function runOpenedFactOf(facts: readonly Fact[]): Extract<Fact, { type: 'run/opened' }> {
  const fact = facts.find(candidate => candidate.type === 'run/opened')
  assert.ok(fact, 'run/opened fact must exist')
  return fact
}

function taskFactOf(facts: readonly Fact[]): Extract<Fact, { type: 'task/closed' }> {
  const fact = facts.find(candidate => candidate.type === 'task/closed')
  assert.ok(fact, 'task/closed fact must exist')
  return fact
}

function sequenceOf(facts: readonly Fact[]): string[] {
  return facts.filter(fact => RUN_FACT_TYPES.has(fact.type)).map(fact => fact.type)
}

async function readJson(store: DomainStore, ref: Ref, domain: 'object' | 'evidence'): Promise<JsonValue> {
  const { bytes } = await store.readObject(ref, domain)
  return parseJsonText(textDecoder.decode(bytes))
}

interface ObservedToolCall {
  readonly name: string
  readonly arguments: JsonValue | undefined
}

function parseToolArguments(raw: string): JsonValue | undefined {
  try {
    return parseJsonText(raw)
  } catch {
    return undefined
  }
}

function observedToolCalls(events: readonly SessionEvent[]): ObservedToolCall[] {
  const calls: ObservedToolCall[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    calls.push({
      name: event.data.name,
      arguments: parseToolArguments(event.data.arguments),
    })
  }
  return calls
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}

function planSketchOf(call: ObservedToolCall): Record<string, JsonValue> | undefined {
  if (!isJsonRecord(call.arguments)) return undefined
  const sketch = call.arguments['sketch']
  return isJsonRecord(sketch) ? sketch : undefined
}

/**
 * Assertion by semantics, never by a fixed message/tool id. The runtime
 * enforces the guard order; this independently proves the persisted DSH trace
 * recorded one self read, one semantic PlanningSketch, a native bash step, and
 * a submission in that order. It runs for both fixture and live models.
 */
function assertVerifiedToolSemantics(
  events: readonly SessionEvent[],
  expected: { readonly taskId: string; readonly runId: string; readonly contractDigest: string },
): void {
  assert.equal(
    events.filter(event => event.type === 'turn/start').length,
    1,
    'Run must open exactly one turn from the single stable wake',
  )
  const wakeMessages = events.filter(
    event => event.type === 'user/message'
      && String(event.data.id) === `${expected.runId}:start`,
  )
  assert.equal(wakeMessages.length, 1, 'Run must persist exactly one start wake')

  const calls = observedToolCalls(events)
  const selfRead = calls.findIndex(call =>
    call.name === 'singularity_read'
    && isJsonRecord(call.arguments)
    && call.arguments['kind'] === 'self'
  )
  const plan = calls.findIndex(call => {
    if (call.name !== 'singularity_plan') return false
    const sketch = planSketchOf(call)
    return sketch !== undefined
      && sketch['taskId'] === expected.taskId
      && sketch['runId'] === expected.runId
      && sketch['sourceContract'] === expected.contractDigest
      && typeof sketch['contextEpoch'] === 'string'
      && sketch['contextEpoch'].length > 0
  })
  const bash = lastIndexWhere(calls, call => call.name === 'bash')
  const submit = lastIndexWhere(calls, call => call.name === 'singularity_submit')

  assert.ok(selfRead >= 0, 'model must call singularity_read(kind="self")')
  assert.ok(plan >= 0, 'model must persist a task/run/contract PlanningSketch')
  assert.ok(bash >= 0, 'model must use the native bash tool for the declared output')
  assert.ok(submit >= 0, 'model must call singularity_submit')
  assert.ok(selfRead < plan, 'self read must precede the PlanningSketch')
  assert.ok(plan < bash, 'PlanningSketch must precede the output-writing bash call')
  assert.ok(bash < submit, 'the output-writing bash call must precede submission')
}

void test('single Run verified: self-read, plan, native bash output, independent CAS verifier', { timeout: VERIFIED_TEST_TIMEOUT_MS }, async () => {
  const taskId = `task-s3b2-verified-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined
  const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []

  const fixtureScript: ReplyScript = (request, index) => {
    const base = selfReadAndPlan(request, index, scenario, taskId, runId)
    if (base !== undefined) return base
    if (index === 2) return writeOutputReply()
    if (index === 3) return submitReply()
    return { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }

  const runVerified = async (
    harness: Harness,
    live: boolean,
    liveApiKey?: string,
  ): Promise<void> => {
    const { spike, workspace, home, storeRoot } = harness
    scenario = await makeScenario(storeRoot, { taskId, reservation: { steps: 4 } })
    const activeScenario = scenario
    const verifier: RunVerifier = {
      provider: activeScenario.provider,
      async verify(request: VerifierRequest) {
        assert.equal(request.operationId, `${runId}:verify`)
        assert.equal(request.task.digest, activeScenario.contract.digest)
        assert.equal(request.inputs.length, 1)
        assert.equal(request.outputs.length, 1)
        assert.equal('workspace' in request, false, 'verifier must not receive the active workspace')
        assert.equal(typeof request.readObject, 'function')

        const input = request.inputs[0]
        const output = request.outputs[0]
        assert.ok(input)
        assert.ok(output)
        const inputBytes = await request.readObject(input, 'object')
        assert.equal(textDecoder.decode(inputBytes.bytes), 'fixture input bytes\n')

        // Mutate the active workspace after submit. A verifier that re-read the
        // workspace would observe this value; CAS reads must not.
        await writeFile(join(workspace, OUTPUT_PATH), 'mutated-after-submit\n', 'utf8')
        const outputBytes = await request.readObject(output, 'object')
        assert.equal(textDecoder.decode(outputBytes.bytes), FROZEN_OUTPUT)

        verifierCalls.push({ inputs: [...request.inputs], outputs: [...request.outputs] })
        return sealPublicReceipt({
          v: 1,
          provider: activeScenario.provider,
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

    const sessionEvents: SessionEvent[] = []
    const disposeSessionListener = spike.ctx.on('session/event', (session, event) => {
      if (String(session.id) === sessionId) sessionEvents.push(event)
      return undefined
    })

    const result = await (async () => {
      try {
        return await executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId,
          admission: activeScenario.runAdmission,
          composition: activeScenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier,
          transientInvalidReasons: [],
        })
      } finally {
        disposeSessionListener()
      }
    })()

    if (live) {
      assert.equal(harness.fixture, undefined, 'live mode must not start the scripted fixture')
      assert.ok(liveApiKey)
      // Close DSH before scanning its home so every session/log write is
      // already durable. The harness dispose is idempotent.
      await spike.dispose()
      await assertSecretNotPersisted(home, liveApiKey)
      assertVerifiedToolSemantics(sessionEvents, {
        taskId,
        runId,
        contractDigest: activeScenario.contract.digest,
      })
    } else {
      const fixture = harness.fixture
      assert.ok(fixture)
      assert.equal(fixture.requests.length, 4, 'one wake must produce exactly four model requests')
      const declaredTools = toolSchemaNames(fixture.requests[0] ?? {})
      assert.ok(declaredTools.includes('singularity_read'), 'self-read tool must be visible before the first request')
      assert.ok(declaredTools.includes('singularity_plan'), 'plan tool must be visible before the first request')
      assert.ok(declaredTools.includes('singularity_submit'), 'submit tool must be visible before the first request')
      assert.ok(declaredTools.includes('bash'), 'native bash tool must remain visible for declared outputs')
      assert.ok(toolNames(fixture.requests[1] ?? {}).includes('singularity_read'))
      assert.ok(toolNames(fixture.requests[2] ?? {}).includes('singularity_plan'))
      assert.ok(toolNames(fixture.requests[3] ?? {}).includes('bash'))
      assertVerifiedToolSemantics(sessionEvents, {
        taskId,
        runId,
        contractDigest: activeScenario.contract.digest,
      })
    }

    const facts = await readRunFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), [
      'task/admitted',
      'run/opened',
      'run/submitted',
      'run/closed',
      'task/closed',
    ])
    const runClosed = runFactOf(facts)
    assert.equal(runClosed.data.classification, 'verified')
    const taskClosed = taskFactOf(facts)
    assert.equal(taskClosed.data.outcome, 'verified')
    assert.equal(taskClosed.data.decisiveRunId, runId)
    assert.equal(result.runFact.digest, runClosed.digest)
    assert.equal(result.taskFact?.digest, taskClosed.digest)
    assert.equal(verifierCalls.length, 1, 'the independent verifier runs once')

    const submitted = facts.find((fact): fact is Extract<Fact, { type: 'run/submitted' }> => fact.type === 'run/submitted')
    assert.ok(submitted)
    if (!('evidenceRef' in runClosed.data)) assert.fail('verified Run must reference Evidence')
    const evidenceRef = runClosed.data.evidenceRef
    const runOpened = runOpenedFactOf(facts)
    assert.equal(runOpened.data.sessionId, sessionId)
    assert.equal(runOpened.data.attempt, 1)
    assert.equal(runOpened.data.workspaceSeed.digest, activeScenario.contract.environment.seed.digest)
    const admitted = facts.find((fact): fact is Extract<Fact, { type: 'task/admitted' }> => fact.type === 'task/admitted')
    assert.ok(admitted)
    assert.equal(admitted.data.contract.digest, activeScenario.contract.digest)
    assert.equal(submitted.data.transcriptOffset.sessionId, sessionId)

    assert.equal(result.classification, 'verified')
    assert.equal(result.manifestRef?.digest, submitted.data.outputs.digest)
    assert.equal(result.evidenceRef?.digest, evidenceRef.digest)
    assert.deepEqual(result.facts.map(fact => fact.digest), facts.map(fact => fact.digest))
    assert.equal(result.retry.allowed, false)
    assert.equal(result.executionRecord, undefined)

    const store = await DomainStore.open({ root: storeRoot })
    try {
      const manifest = parseProtocolValue(
        submissionManifestSchema,
        await readJson(store, submitted.data.outputs, 'object'),
      )
      const manifestValidation = validateSubmissionManifest(manifest, {
        contract: activeScenario.contract,
        runId,
      })
      assert.equal(manifestValidation.valid, true)
      assert.equal(manifest.digest, submitted.data.outputs.digest)
      assert.equal(manifest.outputs.length, 1)
      assert.equal(manifest.outputs[0]?.id, OUTPUT_ID)
      assert.equal(manifest.outputs[0]?.required, true)
      assert.ok(manifest.outputs[0]?.object)
      assert.equal(manifest.learningDrafts.length, 0)
      assert.equal(manifest.checks.length, 1)
      assert.equal(manifest.checks[0]?.outputId, OUTPUT_ID)
      assert.equal(manifest.checks[0]?.symlinks, 'none')
      assert.equal(manifest.checks[0]?.bytes, textEncoder.encode(FROZEN_OUTPUT).byteLength)
      assert.equal(manifest.runId, runId)
      assert.equal(manifest.includeLearningDrafts, false)
      assert.ok(result.manifest)
      assert.equal(result.manifest.digest, manifest.digest)

      const sketch = parseProtocolValue(
        planningSketchSchema,
        await readJson(store, submitted.data.planningSketchRef, 'object'),
      )
      assert.equal(sketch.taskId, taskId)
      assert.equal(sketch.runId, runId)
      assert.equal(sketch.sourceContract, activeScenario.contract.digest)
      assert.ok(sketch.contextEpoch.length > 0)

      const evidenceJson = await readJson(store, evidenceRef, 'evidence')
      assert.equal(verifyDigest('evidence', evidenceJson), true)
      const evidence = parseProtocolValue(evidenceSchema, evidenceJson)
      assert.ok(result.evidence)
      assert.equal(result.evidence.digest, evidence.digest)
      const evidenceValidation = validateEvidence(evidence, {
        contract: activeScenario.contract,
        runId,
        composition: runOpened.data.composition,
      })
      assert.equal(evidenceValidation.valid, true)
      assert.equal(evidence.runId, runId)
      assert.equal(evidence.contractDigest, activeScenario.contract.digest)
      assert.equal(evidence.task.id, taskId)
      assert.equal(evidence.task.digest, activeScenario.contract.digest)
      assert.equal(evidence.method.digest, activeScenario.contract.method.digest)
      assert.equal(evidence.composition.digest, runOpened.data.composition.digest)
      assert.equal(evidence.environment.seed, activeScenario.contract.environment.seed.digest)
      assert.equal(evidence.environment.mode, 'workspace')
      assert.deepEqual(evidence.usage, runClosed.data.usage)
      assert.deepEqual(result.usage, runClosed.data.usage)
      assert.deepEqual(result.sessionCut, evidence.sessionCut)
      assert.equal(evidence.sessionCut.sessionId, sessionId)
      assert.ok(evidence.sessionCut.to >= evidence.sessionCut.from)
      assert.ok(evidence.usage.inputTokens > 0)
      assert.ok(evidence.usage.outputTokens > 0)
      assert.ok(evidence.usage.steps >= 1)
      assert.equal(evidence.usage.unknownRequests, 0)
      assert.equal(evidence.verification.provider.id, activeScenario.provider.id)
      assert.equal(evidence.verification.provider.digest, activeScenario.provider.digest)
      assert.equal(evidence.verification.operationId, `${runId}:verify`)
      assert.deepEqual(
        evidence.inputs.map(ref => ref.digest),
        activeScenario.contract.spec.inputs.map(input => input.object.digest),
      )

      const receipt = parseProtocolValue(
        publicReceiptSchema,
        await readJson(store, evidence.verification.publicReceipt, 'object'),
      )
      assert.equal(receipt.digest, evidence.verification.publicReceipt.digest)
      assert.ok(result.receipt)
      assert.equal(result.receipt.digest, receipt.digest)
      assert.equal(result.receiptRef?.digest, receipt.digest)
      const recorded = verifierCalls[0]
      assert.ok(recorded)
      const frozenOutputRefs = [
        ...manifest.outputs.flatMap(output => output.object === undefined ? [] : [output.object]),
        ...manifest.learningDrafts.map(draft => draft.object),
      ]
      assert.deepEqual(
        evidence.outputs.map(ref => ref.digest),
        frozenOutputRefs.map(ref => ref.digest),
      )
      assert.deepEqual(
        recorded.inputs.map(ref => ref.digest),
        activeScenario.contract.spec.inputs.map(input => input.object.digest),
      )
      assert.deepEqual(
        recorded.outputs.map(ref => ref.digest),
        frozenOutputRefs.map(ref => ref.digest),
      )
      const receiptValidation = validatePublicReceipt(receipt, {
        provider: activeScenario.provider,
        operationId: `${runId}:verify`,
        contractDigest: activeScenario.contract.digest,
        inputDigests: activeScenario.contract.spec.inputs.map(input => input.object.digest),
        outputDigests: frozenOutputRefs.map(ref => ref.digest),
        requiredCriteria: [CRITERION_ID],
      })
      assert.equal(receiptValidation.verdict, 'verified')
      if (live) {
        console.log(`S3-B2 live evidence: ${evidence.digest}`)
      }
    } finally {
      await store.close()
    }
  }

  if (LIVE) {
    const credentials = {
      baseURL: requireLiveEnv('SINGULARITY_SPIKE_BASE_URL'),
      apiKey: requireLiveEnv('SINGULARITY_SPIKE_API_KEY'),
    }
    await withLiveHarness(credentials, async harness => {
      await runVerified(harness, true, credentials.apiKey)
    })
  } else {
    await withHarness(fixtureScript, async harness => {
      await runVerified(harness, false)
    })
  }
})

void test('single Run stops purchasing at host budget boundaries', { timeout: 240_000 }, async t => {
  const boundaries = ['steps', 'tokens', 'cache', 'reservation', 'unknown', 'deadline', 'rollback'] as const
  let boundary: (typeof boundaries)[number] = 'steps'
  let now = Date.now()
  let deadline = now + 60_000
  let firstRequest = 0
  await withHarness((_request, index) => {
    if (index > firstRequest) return { content: 'This request should have been refused.', usage: fixtureUsage(index) }
    if (boundary === 'deadline') now = deadline
    if (boundary === 'rollback') now -= 1
    return {
      toolCalls: [{ id: `read-${String(index)}`, name: 'singularity_read', arguments: '{"kind":"self"}' }],
      ...(boundary === 'unknown' ? {} : { usage: boundary === 'cache'
        ? { promptTokens: 256_001, completionTokens: 8, totalTokens: 256_009, cachedTokens: 256_000 }
        : fixtureUsage(index) }),
    }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    for (const current of boundaries) {
      boundary = current
      now = Date.now()
      deadline = now + 60_000
      firstRequest = fixture.requests.length
      await t.test(boundary, async () => {
        const taskId = `budget-${boundary}-${String(now)}`
        const journalRoot = join(storeRoot, boundary)
        const scenario = await makeScenario(journalRoot, {
          taskId,
          limits: { deadlineAt: deadline },
          reservation: {
            ...(boundary === 'steps' ? { steps: 1 } : {}),
            ...(boundary === 'tokens' ? { tokens: 256_000 } : {}),
            ...(boundary === 'cache' ? { tokens: 512_000 } : {}),
            ...(boundary === 'reservation' ? { tokens: 255_999 } : {}),
          },
        })
        const result = await executeSingleRun({
          ctx: spike.ctx, journalRoot, workspace: join(workspace, boundary),
          sessionId: `${taskId}:session`, runId: `${taskId}:run`,
          admission: scenario.runAdmission, composition: scenario.composition,
          agentOptions: agentOptions(), maxOutputBytes: 1024,
          clock: () => now,
          verifier: { provider: scenario.provider, verify() { throw new Error('no submission') } },
        })
        assert.equal(fixture.requests.length - firstRequest, boundary === 'reservation' ? 0 : 1)
        assert.equal(result.evidence, undefined)
        assert.ok(result.executionRecord)
        if (boundary === 'unknown') assert.equal(result.usage.unknownRequests, 1)
      })
    }
  })
})

void test('single Run deadline cancels an in-flight DSH request', { timeout: 20_000 }, async () => {
  await withHarness(() => ({ hang: true }), async ({ spike, fixture, workspace, storeRoot }) => {
    const taskId = `budget-hang-${String(Date.now())}`
    const scenario = await makeScenario(storeRoot, { taskId, limits: { deadlineAt: Date.now() + 1500 } })
    const started = Date.now()
    const result = await executeSingleRun({
      ctx: spike.ctx, journalRoot: storeRoot, workspace,
      sessionId: `${taskId}:session`, runId: `${taskId}:run`,
      admission: scenario.runAdmission, composition: scenario.composition,
      agentOptions: agentOptions(), maxOutputBytes: 1024,
      verifier: { provider: scenario.provider, verify() { throw new Error('no submission') } },
    })
    assert.equal(fixture.requests.length, 1)
    assert.ok(Date.now() - started < 3000, 'deadline must abort the request before the fixture gives up')
    assert.equal(result.evidence, undefined)
    assert.ok(result.executionRecord)
    assert.equal(result.usage.unknownRequests, 1)
    assert.equal(spike.ctx.agents.get(result.sessionId as never), undefined)
  })
})

void test('unknown failed request cannot buy an internal DSH retry', { timeout: 20_000 }, async () => {
  await withHarness(() => ({ httpError: true }), async ({ spike, fixture, workspace, storeRoot }) => {
    const taskId = `budget-retry-${String(Date.now())}`
    const scenario = await makeScenario(storeRoot, { taskId })
    let retries = 0
    spike.ctx.on('agent/request-error', () => {
      retries += 1
      return Promise.resolve(retries < 2 ? { kind: 'retry' as const } : undefined)
    })
    const result = await executeSingleRun({
      ctx: spike.ctx, journalRoot: storeRoot, workspace,
      sessionId: `${taskId}:session`, runId: `${taskId}:run`,
      admission: scenario.runAdmission, composition: scenario.composition,
      agentOptions: agentOptions(), maxOutputBytes: 1024,
      verifier: { provider: scenario.provider, verify() { throw new Error('no submission') } },
    })
    assert.equal(fixture.requests.length, 1)
    assert.equal(retries, 0)
    assert.equal(result.usage.steps, 1)
    assert.equal(result.usage.unknownRequests, 1)
    assert.equal(result.classification, 'invalid')
  })
})

void test('single Run no-submission settles failed ExecutionRecord without a receipt', { timeout: 240_000 }, async () => {
  const taskId = `task-s3b2-nosubmit-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let verifierCalls = 0

  await withHarness((_request, index) => {
    return index === 0
      ? { content: 'The fixture intentionally ends without submitting.', usage: fixtureUsage(index) }
      : { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, { taskId })
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
        verify() {
          verifierCalls += 1
          throw new Error('verifier must not run without a submission')
        },
      },
      transientInvalidReasons: [],
    })

    assert.equal(fixture.requests.length, 1, 'a plain text turn must not be re-woken')
    assert.equal(verifierCalls, 0)
    assert.equal(result.classification, 'failed')
    assert.equal(result.manifest, undefined)
    assert.equal(result.manifestRef, undefined)
    assert.equal(result.receipt, undefined)
    assert.equal(result.receiptRef, undefined)
    assert.equal(result.evidence, undefined)
    assert.equal(result.evidenceRef, undefined)
    assert.ok(result.executionRecord)
    assert.ok(result.executionRecordRef)
    assert.match(result.executionRecord.reason, /no-submission/i)
    assert.equal(result.retry.allowed, false)

    const facts = await readRunFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), ['task/admitted', 'run/opened', 'run/closed', 'task/closed'])
    const runClosed = runFactOf(facts)
    assert.equal(runClosed.data.classification, 'failed')
    assert.match(runClosed.data.reason, /no-submission/i)
    assert.equal('evidenceRef' in runClosed.data, false)
    assert.equal('executionRecordRef' in runClosed.data, true)
    assert.equal(result.runFact.digest, runClosed.digest)
    const taskClosed = taskFactOf(facts)
    assert.equal(taskClosed.data.outcome, 'failed')
    assert.match(taskClosed.data.reason, /no-submission/i)
    assert.equal(result.taskFact?.digest, taskClosed.digest)
    assert.deepEqual(result.facts.map(fact => fact.digest), facts.map(fact => fact.digest))

    if ('executionRecordRef' in runClosed.data) {
      assert.equal(result.executionRecordRef.digest, runClosed.data.executionRecordRef.digest)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const record: ExecutionRecord = parseProtocolValue(
          executionRecordSchema,
          await readJson(store, runClosed.data.executionRecordRef, 'object'),
        )
        assert.equal(record.digest, result.executionRecord.digest)
        assert.equal(record.taskId, taskId)
        assert.equal(record.runId, runId)
        assert.match(record.reason, /no-submission/i)
      } finally {
        await store.close()
      }
    }
  })
})

async function runInvalidVerifierCase(mode: 'invalid-criterion' | 'timeout'): Promise<void> {
  const taskId = `task-s3b2-${mode}-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined
  let verifierCalls = 0

  await withHarness((request, index) => {
    const base = selfReadAndPlan(request, index, scenario, taskId, runId)
    if (base !== undefined) return base
    if (index === 2) return writeOutputReply()
    if (index === 3) return submitReply()
    return { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, { taskId })
    const activeScenario = scenario
    const result = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId,
      runId,
      admission: activeScenario.runAdmission,
      composition: activeScenario.composition,
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: activeScenario.provider,
        verify(request: VerifierRequest) {
          verifierCalls += 1
          if (mode === 'invalid-criterion') {
            return Promise.resolve(sealPublicReceipt({
              v: 1,
              provider: activeScenario.provider,
              operationId: request.operationId,
              contractDigest: request.task.digest,
              inputDigests: request.inputs.map(ref => ref.digest),
              outputDigests: request.outputs.map(ref => ref.digest),
              criteria: [{
                id: CRITERION_ID,
                verdict: 'invalid',
                reason: 'The fixture verifier could not evaluate the criterion.',
              }],
              exit: { code: 0, signal: null },
              timedOut: false,
            }))
          }
          return Promise.resolve(sealPublicReceipt({
            v: 1,
            provider: activeScenario.provider,
            operationId: request.operationId,
            contractDigest: request.task.digest,
            inputDigests: request.inputs.map(ref => ref.digest),
            outputDigests: request.outputs.map(ref => ref.digest),
            criteria: [{
              id: CRITERION_ID,
              verdict: 'pass',
              reason: 'The fixture criterion passed before the timeout.',
            }],
            exit: { code: null, signal: null },
            timedOut: true,
          }))
        },
      },
      transientInvalidReasons: [],
    })

    assert.equal(fixture.requests.length, 4)
    assert.equal(verifierCalls, 1)
    assert.equal(result.classification, 'invalid')
    assert.ok(result.manifest)
    assert.ok(result.manifestRef)
    assert.equal(result.receipt, undefined)
    assert.equal(result.receiptRef, undefined)
    assert.equal(result.evidence, undefined)
    assert.equal(result.evidenceRef, undefined)
    assert.ok(result.executionRecord)
    assert.ok(result.executionRecordRef)
    assert.equal(result.retry.allowed, false)

    const facts = await readRunFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), [
      'task/admitted',
      'run/opened',
      'run/submitted',
      'run/closed',
      'task/closed',
    ])
    const runClosed = runFactOf(facts)
    assert.equal(runClosed.data.classification, 'invalid')
    assert.equal(runClosed.data.reason, mode === 'timeout' ? 'verifier-timeout' : 'verifier-invalid')
    assert.equal('evidenceRef' in runClosed.data, false)
    assert.equal('executionRecordRef' in runClosed.data, true)
    assert.equal(result.runFact.digest, runClosed.digest)
    const taskClosed = taskFactOf(facts)
    assert.equal(taskClosed.data.outcome, 'invalid')
    assert.equal(taskClosed.data.evidenceRefs.length, 0)
    assert.equal(result.taskFact?.digest, taskClosed.digest)

    if ('executionRecordRef' in runClosed.data) {
      assert.equal(result.executionRecordRef.digest, runClosed.data.executionRecordRef.digest)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const record: ExecutionRecord = parseProtocolValue(
          executionRecordSchema,
          await readJson(store, runClosed.data.executionRecordRef, 'object'),
        )
        assert.equal(record.digest, result.executionRecord.digest)
        assert.equal(record.taskId, taskId)
        assert.equal(record.runId, runId)
        assert.match(record.reason, mode === 'timeout' ? /timeout/i : /invalid/i)
      } finally {
        await store.close()
      }
    }
  })
}

void test('invalid criterion closes invalid ExecutionRecord, not Evidence', { timeout: 240_000 }, async () => {
  await runInvalidVerifierCase('invalid-criterion')
})

void test('verifier timeout closes invalid ExecutionRecord, not Evidence', { timeout: 240_000 }, async () => {
  await runInvalidVerifierCase('timeout')
})

void test('symlinked declared output is rejected before manifest and settles failed', { timeout: 240_000 }, async () => {
  const taskId = `task-s3b2-symlink-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  let scenario: Scenario | undefined
  let verifierCalls = 0

  await withHarness((request, index) => {
    const base = selfReadAndPlan(request, index, scenario, taskId, runId)
    if (base !== undefined) return base
    if (index === 2) {
      return {
        reasoning: 'Create a symlink instead of a regular declared output.',
        toolCalls: [{
          id: 's3b2-symlink',
          name: 'bash',
          arguments: JSON.stringify({ command: `ln -s missing-target ${OUTPUT_PATH}` }),
        }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 3) return submitReply()
    return {
      content: 'The submission was rejected; end without another submission.',
      usage: fixtureUsage(index),
    }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, { taskId })
    const activeScenario = scenario
    const result = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId,
      runId,
      admission: activeScenario.runAdmission,
      composition: activeScenario.composition,
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: activeScenario.provider,
        verify() {
          verifierCalls += 1
          throw new Error('verifier must not run after a rejected submission')
        },
      },
      transientInvalidReasons: [],
    })

    assert.equal(fixture.requests.length, 5)
    assert.equal(verifierCalls, 0)
    assert.equal(result.classification, 'failed')
    assert.equal(result.manifest, undefined)
    assert.equal(result.manifestRef, undefined)
    assert.equal(result.receipt, undefined)
    assert.equal(result.receiptRef, undefined)
    assert.equal(result.evidence, undefined)
    assert.equal(result.evidenceRef, undefined)
    assert.ok(result.executionRecord)
    assert.ok(result.executionRecordRef)
    assert.match(result.executionRecord.reason, /no-submission/i)
    assert.equal(result.retry.allowed, false)
    assert.match(messageTexts(fixture.requests[4] ?? {}).join('\n'), /OUTPUT_SYMLINK/)

    const facts = await readRunFacts(storeRoot)
    assert.deepEqual(sequenceOf(facts), ['task/admitted', 'run/opened', 'run/closed', 'task/closed'])
    const runClosed = runFactOf(facts)
    assert.equal(runClosed.data.classification, 'failed')
    assert.equal('executionRecordRef' in runClosed.data, true)
    assert.equal('evidenceRef' in runClosed.data, false)
    const taskClosed = taskFactOf(facts)
    assert.equal(taskClosed.data.outcome, 'failed')
    assert.equal(result.runFact.digest, runClosed.digest)
    assert.equal(result.taskFact?.digest, taskClosed.digest)
  })
})
