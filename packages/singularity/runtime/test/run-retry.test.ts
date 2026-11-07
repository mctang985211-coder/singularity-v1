import assert from 'node:assert/strict'
import { mkdtemp,realpath,rm,symlink,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent,AgentOptions,AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session,SessionEvent,SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import type {
CompositionPayload,
ExecutionRecord,
Fact,
FactPayloadMap,
FactType,
JsonValue,
MethodRevision,
Ref,
TaskContract,
UsageRecord,
} from '@singularity/protocol'
import {
admitRootTask,
canonicalize,
computeDigest,
parseJsonText,
seal,
sealMethodRevision,
sealPublicReceipt,
sealSubmissionManifest,
sealTaskContract
} from '@singularity/protocol'

import { PLATFORM_PROMPT_SERVICE } from '../src/resources.ts'
import { retrySingleRun } from '../src/retry.ts'
import { executeSingleRun } from '../src/run.ts'
import { CommandService } from '../src/service.ts'
import { DomainStore,OBJECTS_DIRNAME } from '../src/store.ts'
import type { RunVerifier } from '../src/verification.ts'
import { buildExecutionRecord } from '../src/verification.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const actor = { kind: 'runtime' as const, id: 's3c-recovery-test' }
const CRITERION_ID = 'declared-output'
const OUTPUT_ID = 'out'
const OUTPUT_PATH = 'out.txt'
const FIXED_NOW = 1_700_000_000_000
const FAKE_PLATFORM_PROMPT = 's3c-recovery-platform-prompt'

const agentOptions = {
  provider: 'fixture-provider',
  model: 'fixture-model',
} as AgentOptions

interface Scenario {
  readonly taskId: string
  readonly contract: TaskContract
  readonly method: MethodRevision
  readonly composition: CompositionPayload
  readonly provider: Ref
  readonly input: Ref
  readonly seed: Ref
  readonly output: Ref
}

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${String(idCounter)}`
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value as JsonValue))
}

async function putValue(
  service: CommandService,
  value: unknown,
  id: string,
  domain: 'object' | 'contract' | 'method' | 'composition' | 'evidence' = 'object',
): Promise<Ref> {
  return service.putObject(id, jsonBytes(value), domain)
}

async function putBytes(
  service: CommandService,
  value: Uint8Array,
  id: string,
): Promise<Ref> {
  return service.putObject(id, value, 'object')
}

async function commitFact<Type extends FactType>(
  service: CommandService,
  type: Type,
  data: FactPayloadMap[Type],
  commandId: string,
): Promise<Fact> {
  return service.commit({
    command: {
      v: 1,
      commandId,
      tool: 's3c-test',
      toolVersion: 1,
      actor,
      scope: {},
      input: {},
    },
    type,
    data,
  })
}

interface BuildScenarioOptions {
  readonly taskId: string
  readonly maxRuns: number
  readonly maxTokens?: number
  readonly inputAccess?: 'read' | 'copy-to-work'
}

async function buildScenario(
  service: CommandService,
  options: BuildScenarioOptions,
): Promise<Scenario> {
  const guidance = await putValue(service, { v: 1, text: 'Write the declared output.' }, nextId('guidance'))
  const example = await putValue(service, { v: 1, goal: 'fixture example' }, nextId('example'))
  const acceptancePolicy = await putValue(service, { v: 1, kind: 'fixture-policy' }, nextId('acceptance-policy'))
  const verifierObject = seal('object', { v: 1, kind: 'verifier-identity', name: 's3c-fixture' })
  const provider = await putValue(service, verifierObject, 'provider:s3c', 'object')

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
  const methodRef = await putValue(service, method, method.id, 'method')

  const input = await putBytes(service, textEncoder.encode('fixture input bytes\n'), 'input:source')
  const seed = await putValue(service, { v: 1, seed: 's3c-seed' }, 'seed:s3c')
  const profile = await putValue(service, { v: 1, profile: 's3c-profile' }, 'profile:s3c')
  const request = await putValue(service, { v: 1, request: 's3c-recovery' }, 'request:s3c')
  const dshConfig = await putValue(service, { v: 1, config: 'profile' }, 'dsh-config:s3c')
  const modelRoute = await putValue(service, { v: 1, route: 'fixture' }, 'model-route:s3c')
  const resources = await putValue(service, { v: 1, resources: [] }, 'resources:s3c')
  const compositionTemplate = await putValue(service, method.templates[0], 'composition-template:s3c', 'object')

  const contract = admitRootTask({
    taskId: options.taskId,
    spec: {
      goal: {
        summary: `Write exactly the fixture bytes to ${OUTPUT_PATH}.`,
        deliverable: OUTPUT_PATH,
        scope: ['s3c'],
        constraints: [],
      },
      criteria: [{
        id: CRITERION_ID,
        statement: 'The declared output exists with the frozen bytes.',
        required: true,
      }],
      inputs: [{
        id: 'source',
        object: input,
        path: 'input.txt',
        access: options.inputAccess ?? 'read',
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
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: provider,
    environment: { seed, profile },
    limits: {
      maxRuns: options.maxRuns,
      maxStepsPerRun: 4,
      maxTokens: options.maxTokens ?? 100_000,
      deadlineAt: FIXED_NOW + 3_600_000,
      maxDepth: 1,
      maxTasks: 1,
      maxBatchChildren: 1,
    },
  })

  const currentTemplate = method.templates.at(0)
  if (currentTemplate === undefined) throw new Error('scenario Method has no template')
  const composition: CompositionPayload = {
    v: 1,
    dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-alpha.2', config: dshConfig },
    platformPrompt: computeDigest('object', { v: 1, text: FAKE_PLATFORM_PROMPT }),
    contract: { id: contract.taskId, digest: contract.digest },
    template: compositionTemplate,
    guidance: currentTemplate.guidance,
    skills: [],
    mcpServers: [],
    modelRoute,
    resources,
    seed,
  }
  await putValue(service, contract, contract.taskId, 'contract')

  const output = await putBytes(service, textEncoder.encode('frozen-output'), 'output:s3c')
  return { taskId: options.taskId, contract, method, composition, provider, input, seed, output }
}

async function admitTask(service: CommandService, scenario: Scenario): Promise<void> {
  await commitFact(service, 'task/admitted', {
    taskId: scenario.taskId,
    contract: { id: scenario.contract.taskId, digest: scenario.contract.digest },
  }, `task:${scenario.taskId}:admitted`)
}

async function openRun(
  service: CommandService,
  scenario: Scenario,
  options: {
    readonly runId: string
    readonly sessionId: string
    readonly attempt: number
    readonly composition?: CompositionPayload
    readonly tokens?: number
  },
): Promise<Ref> {
  const compositionRef = await putValue(
    service,
    seal('composition', options.composition ?? scenario.composition),
    `${options.runId}:composition`,
    'composition',
  )
  await commitFact(service, 'run/opened', {
    taskId: scenario.taskId,
    runId: options.runId,
    attempt: options.attempt,
    sessionId: options.sessionId,
    composition: compositionRef,
    workspaceKey: options.runId,
    workspaceSeed: scenario.contract.environment.seed,
    budgetReservation: {
      tokens: options.tokens ?? 10_000,
      steps: scenario.contract.limits.maxStepsPerRun,
      deadlineAt: scenario.contract.limits.deadlineAt,
    },
  }, `run:${options.runId}:opened`)
  return compositionRef
}

function usage(inputTokens: number, outputTokens: number, steps: number): UsageRecord {
  return { inputTokens, outputTokens, steps, unknownRequests: 0 }
}

async function closeRunFailed(
  service: CommandService,
  scenario: Scenario,
  options: {
    readonly runId: string
    readonly sessionId: string
    readonly compositionRef: Ref
    readonly reason: string
    readonly usage: UsageRecord
  },
): Promise<{ readonly record: ExecutionRecord; readonly recordRef: Ref }> {
  const record = buildExecutionRecord({
    contract: scenario.contract,
    runId: options.runId,
    composition: options.compositionRef,
    usage: options.usage,
    sessionCut: { sessionId: options.sessionId, from: 0, to: 2 },
    reason: options.reason,
  })
  const recordRef = await putValue(service, record, `${options.runId}:execution-record`, 'object')
  await commitFact(service, 'run/closed', {
    runId: options.runId,
    classification: 'failed',
    reason: options.reason,
    executionRecordRef: recordRef,
    usage: options.usage,
    feedbackRefs: [],
  }, `run:${options.runId}:closed`)
  return { record, recordRef }
}

async function closeRunVerified(
  service: CommandService,
  scenario: Scenario,
  options: {
    readonly runId: string
    readonly sessionId: string
    readonly compositionRef: Ref
    readonly usage: UsageRecord
    readonly classification?: 'verified' | 'failed'
    readonly reason?: string
  },
): Promise<Ref> {
  const receipt = sealPublicReceipt({
    v: 1,
    provider: scenario.provider,
    operationId: `${options.runId}:verify`,
    contractDigest: scenario.contract.digest,
    inputDigests: scenario.contract.spec.inputs.map(input => input.object.digest),
    outputDigests: [scenario.output.digest],
    criteria: [{ id: CRITERION_ID, verdict: 'pass', reason: 'fixture pass' }],
    exit: { code: 0, signal: null },
    timedOut: false,
  })
  const receiptRef = await putValue(service, receipt, `${options.runId}:receipt`, 'object')
  const evidence = seal('evidence', {
    v: 1,
    task: { id: scenario.contract.taskId, digest: scenario.contract.digest },
    runId: options.runId,
    contractDigest: scenario.contract.digest,
    method: scenario.contract.method,
    inputs: scenario.contract.spec.inputs.map(input => input.object),
    outputs: [scenario.output],
    composition: options.compositionRef,
    verification: {
      provider: scenario.provider,
      operationId: `${options.runId}:verify`,
      publicReceipt: receiptRef,
    },
    usage: options.usage,
    sessionCut: { sessionId: options.sessionId, from: 0, to: 2 },
    environment: { seed: scenario.contract.environment.seed.digest, mode: 'workspace' },
  })
  const evidenceRef = await putValue(service, evidence, `${options.runId}:evidence`, 'evidence')
  await submitRun(service, scenario, options)
  await commitFact(service, 'run/closed', {
    runId: options.runId,
    classification: options.classification ?? 'verified',
    reason: options.reason ?? 'all required criteria passed',
    evidenceRef,
    usage: options.usage,
    feedbackRefs: [],
  }, `run:${options.runId}:closed`)
  return evidenceRef
}

async function submitRun(
  service: CommandService,
  scenario: Scenario,
  options: {
    readonly runId: string
    readonly sessionId: string
  },
): Promise<{ readonly manifestRef: Ref; readonly sketchRef: Ref }> {
  const manifest = sealSubmissionManifest({
    v: 1,
    taskId: scenario.taskId,
    runId: options.runId,
    contractDigest: scenario.contract.digest,
    includeLearningDrafts: false,
    outputs: [{
      id: OUTPUT_ID,
      path: OUTPUT_PATH,
      kind: 'file',
      role: 'deliverable',
      required: true,
      object: scenario.output,
    }],
    learningDrafts: [],
    checks: [{ outputId: OUTPUT_ID, bytes: 13, symlinks: 'none' }],
  })
  const manifestRef = await putValue(service, manifest, `${options.runId}:submission`, 'object')
  const sketchRef = await putValue(service, {
    v: 1,
    taskId: scenario.taskId,
    runId: options.runId,
    contextEpoch: 'epoch',
    objective: 'submit',
    levels: [
      { level: 0, purpose: 'work', likelyChildren: [], expectedInputs: [], expectedOutputs: [] },
      { level: 1, purpose: 'none', likelyChildren: [], expectedInputs: [], expectedOutputs: [] },
    ],
    directPlan: [],
    assumptions: [],
    sourceContract: scenario.contract.digest,
  }, `${options.runId}:planning-sketch`, 'object')
  await commitFact(service, 'run/submitted', {
    runId: options.runId,
    outputs: manifestRef,
    transcriptOffset: { sessionId: options.sessionId, seq: 4 },
    previewReceipts: [],
    readReceipts: [],
    planningSketchRef: sketchRef,
    feedbackRefs: [],
  }, `run:${options.runId}:submitted`)
  return { manifestRef, sketchRef }
}

async function readFacts(root: string): Promise<readonly Fact[]> {
  const store = await DomainStore.open({ root })
  try {
    return store.facts()
  } finally {
    await store.close()
  }
}

function findFact<Type extends FactType>(
  facts: readonly Fact[],
  type: Type,
): Extract<Fact, { readonly type: Type }> | undefined {
  for (const fact of facts) {
    if (fact.type === type) return fact as Extract<Fact, { readonly type: Type }>
  }
  return undefined
}

function factsOfType<Type extends FactType>(
  facts: readonly Fact[],
  type: Type,
): Extract<Fact, { readonly type: Type }>[] {
  return facts.filter((fact): fact is Extract<Fact, { readonly type: Type }> => fact.type === type)
}

interface FakeAgentState {
  readonly createCalls: { sessionId: string; cwd: string | undefined }[]
  readonly resumeCalls: { sessionId: string }[]
  followupCalls: number
  disposed: number
}

interface FakeContextOptions {
  readonly resume: 'ok' | 'missing'
  readonly initialEvents?: readonly SessionEvent[]
  /** Live session events exposed through `ctx.sessions.get` for recovery snapshots. */
  readonly liveEvents?: readonly SessionEvent[]
  readonly dispose?: () => Promise<void>
  readonly create?: () => Promise<void>
  readonly work?: (agent: Agent, tools: ReadonlyMap<string, {
    execute(args: unknown, execution: ToolExecution): unknown
  }>) => Promise<void>
  /** Scoped system prompt sections registered by Agent setup. */
  readonly sections?: {
    name: string
    order: number
    text: string
    interpolate?: boolean
  }[]
  /** Text returned by the fake host platform-prompt renderer. */
  readonly platformPromptText?: string
}

function makeFakeContext(options: FakeContextOptions): {
  readonly ctx: Context
  readonly state: FakeAgentState
} {
  const state: FakeAgentState = {
    createCalls: [],
    resumeCalls: [],
    followupCalls: 0,
    disposed: 0,
  }
  const tools = new Map<string, { execute(args: unknown, execution: ToolExecution): unknown }>()

  const makeAgent = (sessionId: string): Agent => {
    const events: SessionEvent[] = [...(options.initialEvents ?? [])]
    const session = {
      id: sessionId as SessionId,
      get seq() { return events.length },
      firstLiveSeq: 0,
      surface: { nodes: [], replaceGeneration: 0 },
      snapshotEvents: () => events,
      deriveMessages: () => [],
    } as unknown as Session
    const agent = {
      session,
      status: 'idle',
      followup(message: unknown) {
        state.followupCalls += 1
        events.push({
          type: 'user/message',
          seq: events.length,
          surfaceOp: 'append',
          data: message,
        } as unknown as SessionEvent)
      },
      whenIdle: () => options.work?.(agent, tools) ?? Promise.resolve(),
      cancel() {},
    } as unknown as Agent
    return agent
  }

  const agentCtx = {
    get: () => undefined,
    on() {},
    systemPrompt: {
      getSectionOrder: () => 0,
      section(section: { name: string; order: number; text: string; interpolate?: boolean }) {
        options.sections?.push(section)
      },
      context() {},
    },
    tools: {
      register(tool: { name: string; execute(args: unknown, execution: ToolExecution): unknown }) {
        tools.set(tool.name, tool)
      },
      guard() {},
      restrict() {},
      definitions: () => [],
      schemas: () => [],
    },
  }

  const runSetup = async (setup: AgentSetup | undefined, agent: Agent): Promise<void> => {
    if (setup !== undefined) await setup(agentCtx as never, agent)
  }

  const ctx = {
    get: (name: string) => name === PLATFORM_PROMPT_SERVICE
      ? { render: () => Promise.resolve(options.platformPromptText ?? FAKE_PLATFORM_PROMPT) }
      : undefined,
    agents: {
      get: () => undefined,
      async create(createOptions: {
        readonly sessionId: SessionId
        readonly meta?: { readonly cwd?: string }
        readonly setup?: AgentSetup
      }) {
        state.createCalls.push({
          sessionId: String(createOptions.sessionId),
          cwd: createOptions.meta?.cwd,
        })
        await options.create?.()
        const agent = makeAgent(String(createOptions.sessionId))
        await runSetup(createOptions.setup, agent)
        return {
          agent,
          dispose() {
            state.disposed += 1
            return options.dispose?.() ?? Promise.resolve()
          },
        }
      },
      async resume(resumeOptions: {
        readonly resumeSessionId: SessionId
        readonly setup?: AgentSetup
      }) {
        state.resumeCalls.push({ sessionId: String(resumeOptions.resumeSessionId) })
        if (options.resume === 'missing') {
          const error = new Error('persisted session is missing')
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        }
        const agent = makeAgent(String(resumeOptions.resumeSessionId))
        await runSetup(resumeOptions.setup, agent)
        return {
          agent,
          dispose() {
            state.disposed += 1
            return options.dispose?.() ?? Promise.resolve()
          },
        }
      },
    },
    sessions: {
      get: (id: SessionId) => options.liveEvents === undefined
        ? undefined
        : {
            id,
            seq: options.liveEvents.length,
            firstLiveSeq: 0,
      surface: { nodes: [], replaceGeneration: 0 },
            snapshotEvents: () => options.liveEvents,
          } as unknown as Session,
      flush: () => Promise.resolve(true),
    },
    tools: {
      definitions: () => [],
    },
  } as unknown as Context

  return { ctx, state }
}

function unchangedFacts(root: string): Promise<readonly Fact[]> {
  return readFacts(root)
}

void test('an upstream Agent TimeoutError propagates without a budget closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 's3-agent-upstream-timeout-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3-agent-upstream-timeout-work-'))
  const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
  try {
    const scenario = await buildScenario(service, { taskId: 'agent-upstream-timeout', maxRuns: 1 })
    const failure = new DOMException('upstream request timed out', 'TimeoutError')
    const { ctx, state } = makeFakeContext({ resume: 'ok', work: () => Promise.reject(failure) })
    await assert.rejects(executeSingleRun({
      ctx, journalRoot: root, workspace, actor, runId: 'upstream-run', sessionId: 'upstream-session',
      admission: { contract: scenario.contract, attempt: 1, budgetReservation: {
        tokens: 100_000, steps: 4, deadlineAt: scenario.contract.limits.deadlineAt,
      } },
      composition: scenario.composition, agentOptions, maxOutputBytes: 1024,
      verifier: { provider: scenario.provider, verify() { throw new Error('must not verify') } },
      clock: () => FIXED_NOW + 1000,
    }, service), error => error === failure)
    assert.equal(state.disposed, 1)
    assert.equal(state.followupCalls, 1)
    assert.equal(factsOfType(service.facts(), 'run/closed').length, 0)
    assert.equal(factsOfType(service.facts(), 'task/closed').length, 0)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('Agent cleanup failure after submission cannot produce Evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 's3-drain-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3-drain-work-'))
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId: 'task-drain-failed', maxRuns: 1 })
    } finally {
      await service.close()
    }
    await writeFile(join(workspace, OUTPUT_PATH), 'frozen output\n')
    const sessionId = 'session-drain-failed'
    const runId = 'run-drain-failed'
    const { ctx, state } = makeFakeContext({
      resume: 'ok',
      dispose: () => Promise.reject(new Error('owned process remains active')),
      async work(agent, tools) {
        const execution = { agent, concludeTurn() {} } as unknown as ToolExecution
        await tools.get('singularity_read')?.execute({ kind: 'self' }, execution)
        await tools.get('singularity_plan')?.execute({ sketch: {
          v: 1, objective: 'Write the declared output.',
          levels: [0, 1].map(level => ({ level, purpose: 'Write output.', likelyChildren: [], expectedInputs: [], expectedOutputs: [] })),
          directPlan: [], assumptions: [],
        } }, execution)
        await tools.get('singularity_submit')?.execute({ outputIds: [OUTPUT_ID], includeLearningDrafts: false }, execution)
      },
    })
    let verifierCalls = 0
    await assert.rejects(executeSingleRun({
      ctx, journalRoot: root, workspace, runId, sessionId,
      admission: { contract: scenario.contract, attempt: 1, budgetReservation: {
        tokens: 100_000, steps: 4, deadlineAt: scenario.contract.limits.deadlineAt,
      } },
      composition: scenario.composition, agentOptions, maxOutputBytes: 1024,
      verifier: { provider: scenario.provider, verify(request) {
        verifierCalls += 1
        return Promise.resolve(sealPublicReceipt({
          v: 1, provider: scenario.provider, operationId: request.operationId,
          contractDigest: scenario.contract.digest,
          inputDigests: request.inputs.map(ref => ref.digest),
          outputDigests: request.outputs.map(ref => ref.digest),
          criteria: [{ id: CRITERION_ID, verdict: 'pass', reason: 'pass' }],
          exit: { code: 0, signal: null }, timedOut: false,
        }))
      } },
      clock: () => FIXED_NOW + 1000,
    }), /owned process remains active/)

    assert.equal(factsOfType(await readFacts(root), 'run/submitted').length, 1)
    assert.equal(factsOfType(await readFacts(root), 'run/closed').length, 0)
    assert.equal(verifierCalls, 0)

    assert.equal(state.disposed, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

for (const mode of ['closed', 'active', 'exhausted', 'reservation', 'same-run'] as const) {
  void test(`Task/Run execution rejects ${mode} before driving DSH`, async () => {
    const root = await mkdtemp(join(tmpdir(), 's3-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 's3-state-work-'))
    try {
      const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
      let scenario: Scenario
      try {
        scenario = await buildScenario(service, { taskId: `state-${mode}`, maxRuns: 1 })
        await admitTask(service, scenario)
        if (mode !== 'reservation') {
          const compositionRef = await openRun(service, scenario, {
            runId: 'old-run', sessionId: 'old-session', attempt: 1,
            tokens: 10_000,
          })
          if (mode !== 'active') {
            await closeRunFailed(service, scenario, {
              runId: 'old-run', sessionId: 'old-session', compositionRef,
              reason: 'no-submission', usage: usage(10, 2, 1),
            })
            if (mode === 'closed') {
              await commitFact(service, 'task/closed', {
                taskId: scenario.taskId, outcome: 'failed', reason: 'maxRuns exhausted',
                decisiveRunId: 'old-run',
                evidenceRefs: [],
              }, 'task:closed')
            }
          }
        }
      } finally {
        await service.close()
      }
      const before = await readFacts(root)
      const { ctx, state } = makeFakeContext({ resume: 'ok' })
      const request = {
        ctx, journalRoot: root, workspace,
        runId: mode === 'same-run' ? 'old-run' : 'new-run',
        sessionId: mode === 'same-run' ? 'old-session' : 'new-session',
        admission: {
          contract: scenario.contract,
          attempt: mode === 'reservation' ? 1 : 2,
          budgetReservation: {
            tokens: mode === 'reservation' ? scenario.contract.limits.maxTokens + 1 : 1000,
            steps: 4, deadlineAt: scenario.contract.limits.deadlineAt,
          },
        },
        composition: scenario.composition, agentOptions, maxOutputBytes: 1024,
        verifier: { provider: scenario.provider, verify() { throw new Error('must not verify') } },
        clock: () => FIXED_NOW + 1000,
      }
      await assert.rejects(executeSingleRun(request),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === (
          mode === 'reservation' ? 'BUDGET_EXCEEDED'
            : mode === 'same-run' ? 'RUN_ALREADY_CLOSED'
              : mode === 'exhausted' ? 'RETRY_NOT_ALLOWED' : 'TASK_NOT_OPEN'
        ))
      assert.deepEqual(await readFacts(root), before)
      assert.equal(state.createCalls.length + state.resumeCalls.length, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
}

void test('retrySingleRun allows a failed latest Run and starts a fresh attempt/session/workspace', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-retry-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-retry-work-'))
  const nextWorkspace = join(root, 'retry-workspace')
  const taskId = 'task-s3c-retry'
  const previousRunId = `${taskId}-run-1`
  const previousSessionId = `${taskId}-session-1`
  let scenario: Scenario
  let previousRecordRef: Ref
  let previousClosedDigest: string
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 2 })
      await admitTask(service, scenario)
      const compositionRef = await openRun(service, scenario, {
        runId: previousRunId,
        sessionId: previousSessionId,
        attempt: 1,
      })
      const closed = await closeRunFailed(service, scenario, {
        runId: previousRunId,
        sessionId: previousSessionId,
        compositionRef,
        reason: 'no-submission',
        usage: usage(10, 6, 1),
      })
      previousRecordRef = closed.recordRef
      const facts = await readFacts(root)
      previousClosedDigest = findFact(facts, 'run/closed')?.digest ?? ''
    } finally {
      await service.close()
    }

    const { ctx, state } = makeFakeContext({
      resume: 'ok',
    })
    const verifier: RunVerifier = {
      provider: scenario.provider,
      verify() {
        throw new Error('verifier must not run for a no-submission fresh retry')
      },
    }
    const result = await retrySingleRun({
      ctx,
      journalRoot: root,
      workspace: nextWorkspace,
      previousRunId,
      runId: `${taskId}-run-2`,
      sessionId: `${taskId}-session-2`,
      agentOptions,
      maxOutputBytes: 1024,
      verifier,
      transientInvalidReasons: [],
      clock: () => FIXED_NOW + 1000,
    })
    assert.ok(result.kind === 'settled')

    assert.equal(result.previousRunId, previousRunId)
    assert.equal(result.attempt, 2)
    assert.equal(result.retryPolicy.allowed, true)
    assert.equal(result.classification, 'failed')
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.createCalls[0]?.sessionId, `${taskId}-session-2`)
    assert.equal(state.createCalls[0]?.cwd, nextWorkspace)
    assert.equal(state.followupCalls, 1)
    assert.equal(state.disposed, 1)

    const facts = await readFacts(root)
    const opened = factsOfType(facts, 'run/opened')
    assert.equal(opened.length, 2)
    assert.equal(opened[1]?.data.runId, `${taskId}-run-2`)
    assert.equal(opened[1]?.data.attempt, 2)
    assert.equal(opened[1]?.data.sessionId, `${taskId}-session-2`)
    assert.equal(opened[1]?.data.workspaceKey, `${taskId}-run-2`)
    assert.equal(opened[1]?.data.composition.digest, opened[0]?.data.composition.digest)
    assert.equal(opened[1]?.data.workspaceSeed.digest, scenario.contract.environment.seed.digest)

    const closedFacts = factsOfType(facts, 'run/closed')
    assert.equal(closedFacts.length, 2)
    assert.equal(closedFacts[0]?.digest, previousClosedDigest)
    assert.equal(closedFacts[1]?.data.runId, `${taskId}-run-2`)
    assert.equal(closedFacts[1]?.data.classification, 'failed')
    assert.equal('executionRecordRef' in (closedFacts[1]?.data ?? {}), true)
    assert.equal('evidenceRef' in (closedFacts[1]?.data ?? {}), false)

    const recordRef = (closedFacts[1]?.data as { readonly executionRecordRef?: Ref }).executionRecordRef
    assert.ok(recordRef)
    assert.notEqual(recordRef.digest, previousRecordRef.digest)
    const store = await DomainStore.open({ root })
    try {
      const previousBytes = await store.readObject(previousRecordRef, 'object')
      assert.match(textDecoder.decode(previousBytes.bytes), /no-submission/)
    } finally {
      await store.close()
    }
    const taskClosed = factsOfType(facts, 'task/closed')[0]
    assert.equal(taskClosed.data.outcome, 'failed')
    assert.equal(taskClosed.data.decisiveRunId, `${taskId}-run-2`)
    assert.equal(result.taskFact?.digest, taskClosed.digest)
    assert.equal(result.manifest, undefined)
    assert.equal(result.receipt, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(nextWorkspace, { recursive: true, force: true })
  }
})

void test('retrySingleRun exclusively creates a new workspace without reading historical cwd', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-retry-workspace-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-retry-workspace-old-'))
  const nextWorkspace = join(root, 'fresh-workspace')
  const alias = join(root, 'workspace-alias')
  const taskId = 'task-s3c-retry-workspace'
  const previousRunId = `${taskId}-run-1`
  const previousSessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 2 })
      await admitTask(service, scenario)
      const compositionRef = await openRun(service, scenario, {
        runId: previousRunId,
        sessionId: previousSessionId,
        attempt: 1,
      })
      await closeRunFailed(service, scenario, {
        runId: previousRunId,
        sessionId: previousSessionId,
        compositionRef,
        reason: 'no-submission',
        usage: usage(10, 6, 1),
      })
    } finally {
      await service.close()
    }
    await symlink(workspace, alias)
    const before = await readFacts(root)
    const { ctx, state } = makeFakeContext({
      resume: 'ok',

    })
    const verifier: RunVerifier = {
      provider: scenario.provider,
      verify() { throw new Error('verifier must not run for a no-submission fresh retry') },
    }

    await assert.rejects(
      retrySingleRun({
        ctx,
        journalRoot: root,
        workspace: alias,
        previousRunId,
        runId: `${taskId}-run-2`,
        sessionId: `${taskId}-session-2`,
        agentOptions,
        maxOutputBytes: 1024,
        verifier,
        clock: () => FIXED_NOW + 1000,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'EEXIST',
    )
    assert.deepEqual(await readFacts(root), before)
    assert.equal(state.createCalls.length + state.resumeCalls.length, 0)

    const result = await retrySingleRun({
      ctx,
      journalRoot: root,
      workspace: nextWorkspace,
      previousRunId,
      runId: `${taskId}-run-2`,
      sessionId: `${taskId}-session-2`,
      agentOptions,
      maxOutputBytes: 1024,
      verifier,
      clock: () => FIXED_NOW + 1000,
    })
    assert.equal(result.attempt, 2)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.createCalls[0]?.cwd, await realpath(nextWorkspace))
    assert.equal(factsOfType(await readFacts(root), 'run/opened').length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(nextWorkspace, { recursive: true, force: true })
  }
})

void test('retrySingleRun rejects closed policies and non-fresh identities without new facts', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-retry-reject-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-retry-reject-work-'))
  const rootFresh = await mkdtemp(join(tmpdir(), 's3c-retry-fresh-'))
  const workspaceFresh = await mkdtemp(join(tmpdir(), 's3c-retry-fresh-work-'))
  try {
    let scenario: Scenario | undefined
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    try {
      scenario = await buildScenario(service, { taskId: 'task-s3c-retry-reject', maxRuns: 1 })
      await admitTask(service, scenario)
      const compositionRef = await openRun(service, scenario, {
        runId: 'task-s3c-retry-reject-run-1',
        sessionId: 'task-s3c-retry-reject-session-1',
        attempt: 1,
      })
      await closeRunFailed(service, scenario, {
        runId: 'task-s3c-retry-reject-run-1',
        sessionId: 'task-s3c-retry-reject-session-1',
        compositionRef,
        reason: 'no-submission',
        usage: usage(10, 6, 1),
      })
    } finally {
      await service.close()
    }

    const before = await unchangedFacts(root)
    const { ctx, state } = makeFakeContext({ resume: 'ok' })
    const verifier: RunVerifier = {
      provider: scenario.provider,
      verify() { throw new Error('verifier must not run') },
    }

    await assert.rejects(
      retrySingleRun({
        ctx,
        journalRoot: root,
        workspace,
        previousRunId: 'task-s3c-retry-reject-run-1',
        runId: 'task-s3c-retry-reject-run-2',
        sessionId: 'task-s3c-retry-reject-session-2',
        agentOptions,
        maxOutputBytes: 1024,
        verifier,
        clock: () => FIXED_NOW + 1000,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'RETRY_NOT_ALLOWED',
    )
    assert.deepEqual(await readFacts(root), before)
    assert.equal(state.createCalls.length, 0)

    // A second Task with budget for one retry reaches the freshness check.
    const serviceFresh = await CommandService.open({ root: rootFresh, actor, clock: () => FIXED_NOW })
    let freshScenario: Scenario | undefined
    try {
      freshScenario = await buildScenario(serviceFresh, { taskId: 'task-s3c-retry-fresh', maxRuns: 2 })
      await admitTask(serviceFresh, freshScenario)
      const compositionRef = await openRun(serviceFresh, freshScenario, {
        runId: 'task-s3c-retry-fresh-run-1',
        sessionId: 'task-s3c-retry-fresh-session-1',
        attempt: 1,
      })
      await closeRunFailed(serviceFresh, freshScenario, {
        runId: 'task-s3c-retry-fresh-run-1',
        sessionId: 'task-s3c-retry-fresh-session-1',
        compositionRef,
        reason: 'no-submission',
        usage: usage(10, 6, 1),
      })
    } finally {
      await serviceFresh.close()
    }
    const freshBefore = await readFacts(rootFresh)
    await assert.rejects(
      retrySingleRun({
        ctx,
        journalRoot: rootFresh,
        workspace: workspaceFresh,
        previousRunId: 'task-s3c-retry-fresh-run-1',
        runId: 'task-s3c-retry-fresh-run-2',
        sessionId: 'task-s3c-retry-fresh-session-1',
        agentOptions,
        maxOutputBytes: 1024,
        verifier: {
          provider: freshScenario.provider,
          verify() { throw new Error('verifier must not run') },
        },
        clock: () => FIXED_NOW + 1000,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'INVALID_ARGUMENT',
    )
    assert.deepEqual(await readFacts(rootFresh), freshBefore)
    assert.equal(state.createCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(rootFresh, { recursive: true, force: true })
    await rm(workspaceFresh, { recursive: true, force: true })
  }
})

void test('retrySingleRun rejects a verified previous Run without opening another attempt', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-retry-verified-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-retry-verified-work-'))
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId: 'task-s3c-retry-verified', maxRuns: 2 })
      await admitTask(service, scenario)
      const compositionRef = await openRun(service, scenario, {
        runId: 'task-s3c-retry-verified-run-1',
        sessionId: 'task-s3c-retry-verified-session-1',
        attempt: 1,
      })
      await closeRunVerified(service, scenario, {
        runId: 'task-s3c-retry-verified-run-1',
        sessionId: 'task-s3c-retry-verified-session-1',
        compositionRef,
        usage: usage(10, 2, 1),
      })
    } finally {
      await service.close()
    }
    const before = await readFacts(root)
    const { ctx, state } = makeFakeContext({ resume: 'ok' })
    await assert.rejects(
      retrySingleRun({
        ctx,
        journalRoot: root,
        workspace,
        previousRunId: 'task-s3c-retry-verified-run-1',
        runId: 'task-s3c-retry-verified-run-2',
        sessionId: 'task-s3c-retry-verified-session-2',
        agentOptions,
        maxOutputBytes: 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('verified Run must not be retried') },
        },
        clock: () => FIXED_NOW + 1000,
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'RETRY_NOT_ALLOWED',
    )
    assert.deepEqual(await readFacts(root), before)
    assert.equal(state.createCalls.length + state.resumeCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('retrySingleRun retains previous failed Evidence without reusing it', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-retry-evidence-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-retry-evidence-work-'))
  const nextWorkspace = join(root, 'retry-workspace')
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    let previousEvidenceRef: Ref
    let previousClosedDigest: string
    try {
      scenario = await buildScenario(service, { taskId: 'task-s3c-retry-evidence', maxRuns: 2 })
      await admitTask(service, scenario)
      const compositionRef = await openRun(service, scenario, {
        runId: 'task-s3c-retry-evidence-run-1',
        sessionId: 'task-s3c-retry-evidence-session-1',
        attempt: 1,
      })
      previousEvidenceRef = await closeRunVerified(service, scenario, {
        runId: 'task-s3c-retry-evidence-run-1',
        sessionId: 'task-s3c-retry-evidence-session-1',
        compositionRef,
        usage: usage(10, 2, 1),
        classification: 'failed',
        reason: 'required criteria failed: fixture',
      })
      previousClosedDigest = (await readFacts(root)).find(fact => fact.type === 'run/closed')?.digest ?? ''
    } finally {
      await service.close()
    }

    const { ctx, state } = makeFakeContext({
      resume: 'ok',
    })
    const result = await retrySingleRun({
      ctx,
      journalRoot: root,
      workspace: nextWorkspace,
      previousRunId: 'task-s3c-retry-evidence-run-1',
      runId: 'task-s3c-retry-evidence-run-2',
      sessionId: 'task-s3c-retry-evidence-session-2',
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() { throw new Error('verifier must not run for a no-submission retry') },
      },
      clock: () => FIXED_NOW + 1000,
    })
    assert.ok(result.kind === 'settled')
    assert.equal(result.retryPolicy.allowed, true)
    assert.equal(result.classification, 'failed')
    assert.equal(state.createCalls.length, 1)

    const facts = await readFacts(root)
    const closed = factsOfType(facts, 'run/closed')
    assert.equal(closed.length, 2)
    assert.equal(closed[0].digest, previousClosedDigest)
    assert.equal(closed[0].data.classification, 'failed')
    assert.equal('evidenceRef' in closed[0].data, true)
    assert.equal((closed[0].data as { readonly evidenceRef: Ref }).evidenceRef.digest, previousEvidenceRef.digest)
    assert.equal('evidenceRef' in closed[1].data, false)
    assert.equal('executionRecordRef' in closed[1].data, true)
    const store = await DomainStore.open({ root })
    try {
      const bytes = await store.readObject(previousEvidenceRef, 'evidence')
      assert.ok(parseJsonText(textDecoder.decode(bytes.bytes)) !== null)
    } finally {
      await store.close()
    }
    assert.equal(result.evidence, undefined)
    assert.equal(result.receipt, undefined)
    assert.equal(factsOfType(facts, 'task/closed')[0].data.decisiveRunId, 'task-s3c-retry-evidence-run-2')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(nextWorkspace, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// S4-A1 — Method revision pin and current-layer guidance
// ---------------------------------------------------------------------------

const S4A1_CURRENT_GUIDANCE = 'S4-A1 current template guidance marker.'
const S4A1_OTHER_GUIDANCE = 'S4-A1 other template guidance marker must stay hidden.'
const S4A1_GUIDANCE_BYTES = 8 * 1024
const s4a1Encoder = new TextEncoder()

interface MethodVariant {
  readonly method: MethodRevision
  readonly ref: Ref
}

async function s4a1PutMethod(
  service: CommandService,
  method: MethodRevision,
): Promise<MethodVariant> {
  const ref = await putValue(service, method, method.id, 'method')
  return { method, ref }
}

function s4a1FirstTemplate(scenario: Scenario): MethodRevision['templates'][number] {
  const template = scenario.method.templates.at(0)
  if (template === undefined) throw new Error('S4-A1 scenario has no current template')
  return template
}

function s4a1ResealMethod(
  scenario: Scenario,
  templates: MethodRevision['templates'],
  id = scenario.method.id,
): MethodRevision {
  return sealMethodRevision({
    v: 1,
    id,
    ...(scenario.method.parent === undefined ? {} : { parent: scenario.method.parent }),
    ...(scenario.method.entryTemplateId === undefined
      ? {}
      : { entryTemplateId: scenario.method.entryTemplateId }),
    templates,
    skills: scenario.method.skills,
    tools: scenario.method.tools,
  })
}

function s4a1ContractPayload(scenario: Scenario): {
  readonly v: 1
  readonly taskId: string
  readonly spec: TaskContract['spec']
  readonly origin: TaskContract['origin']
  readonly method: TaskContract['method']
  readonly template: TaskContract['template']
  readonly resources: TaskContract['resources']
  readonly acceptance: TaskContract['acceptance']
  readonly environment: TaskContract['environment']
  readonly limits: TaskContract['limits']
} {
  return {
    v: 1,
    taskId: scenario.contract.taskId,
    spec: scenario.contract.spec,
    origin: scenario.contract.origin,
    method: scenario.contract.method,
    template: scenario.contract.template,
    resources: scenario.contract.resources,
    acceptance: scenario.contract.acceptance,
    environment: scenario.contract.environment,
    limits: scenario.contract.limits,
  }
}

function s4a1Guidance(text: string): { readonly v: 1; readonly text: string } {
  return { v: 1, text }
}

function s4a1NonCanonical(value: unknown): Uint8Array {
  return s4a1Encoder.encode(JSON.stringify(value))
}

async function s4a1TamperObject(
  root: string,
  ref: Ref,
  replacement: Uint8Array,
): Promise<void> {
  await writeFile(join(root, OBJECTS_DIRNAME, ref.digest.slice('sha256:'.length)), replacement)
}

async function s4a1Variant(
  service: CommandService,
  scenario: Scenario,
  options: {
    readonly method?: MethodVariant
    readonly contractMethod?: Ref
    readonly contractTemplate?: { readonly id: string; readonly digest: string }
    readonly contractResources?: TaskContract['resources']
    readonly compositionTemplate?: Ref
    readonly compositionGuidance?: Ref
    readonly compositionSkills?: readonly Ref[]
    readonly compositionMcpServers?: CompositionPayload['mcpServers']
    readonly omitCompositionGuidance?: boolean
  } = {},
): Promise<{
  readonly scenario: Scenario
  readonly method: MethodRevision
  readonly contract: TaskContract
  readonly composition: CompositionPayload
}> {
  const selected = options.method ?? { method: scenario.method, ref: scenario.contract.method }
  const pinnedId = options.contractTemplate?.id ?? scenario.contract.template.id
  const template = selected.method.templates.find(candidate => candidate.id === pinnedId)
  const templateRef = options.compositionTemplate ?? await putValue(
    service,
    template ?? { v: 1, templateId: pinnedId },
    nextId('s4a1-composition-template'),
    'object',
  )
  const guidanceRef = options.omitCompositionGuidance
    ? undefined
    : options.compositionGuidance ?? template?.guidance
  const contract = sealTaskContract({
    ...s4a1ContractPayload(scenario),
    ...(options.contractResources === undefined ? {} : { resources: options.contractResources }),
    method: options.contractMethod ?? selected.ref,
    template: options.contractTemplate ?? { id: pinnedId, digest: selected.method.digest },
  })
  const composition: CompositionPayload = {
    v: 1,
    dsh: scenario.composition.dsh,
    platformPrompt: scenario.composition.platformPrompt,
    contract: { id: contract.taskId, digest: contract.digest },
    template: templateRef,
    skills: [...(options.compositionSkills ?? scenario.composition.skills)],
    mcpServers: [...(options.compositionMcpServers ?? scenario.composition.mcpServers)],
    modelRoute: scenario.composition.modelRoute,
    resources: scenario.composition.resources,
    seed: scenario.composition.seed,
    ...(guidanceRef === undefined ? {} : { guidance: guidanceRef }),
  }
  await putValue(service, contract, contract.taskId, 'contract')
  return {
    scenario: {
      ...scenario,
      contract,
      method: selected.method,
      composition,
    },
    method: selected.method,
    contract,
    composition,
  }
}

interface S4A1InvalidCase {
  readonly key: string
  readonly name: string
  readonly code: string
  prepare(
    service: CommandService,
    scenario: Scenario,
    root: string,
  ): Promise<{
    readonly scenario: Scenario
    readonly method: MethodRevision
    readonly contract: TaskContract
    readonly composition: CompositionPayload
  }>
}

const s4a1InvalidCases: readonly S4A1InvalidCase[] = [
  {
    key: 'method-missing',
    name: 'a missing Method revision',
    code: 'OBJECT_MISSING',
    async prepare(service, scenario) {
      return s4a1Variant(service, scenario, {
        contractMethod: {
          id: 'method:missing-s4a1',
          digest: computeDigest('method', { v: 1, id: 'method:missing-s4a1' }),
        },
      })
    },
  },
  {
    key: 'template-pin',
    name: 'a TemplateRef digest that is not the pinned Method',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const other = await s4a1PutMethod(service, s4a1ResealMethod(
        scenario,
        scenario.method.templates,
        'method:s4a1-other-pin',
      ))
      return s4a1Variant(service, scenario, {
        contractTemplate: {
          id: scenario.contract.template.id,
          digest: other.ref.digest,
        },
      })
    },
  },
  {
    key: 'template-dangling',
    name: 'a dangling current template id',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const otherGuidance = await putValue(
        service,
        s4a1Guidance(S4A1_OTHER_GUIDANCE),
        nextId('s4a1-other-guidance'),
      )
      const otherMethod = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        id: 'template:s4a1-other',
        guidance: otherGuidance,
      }]))
      return s4a1Variant(service, scenario, {
        method: otherMethod,
        contractTemplate: {
          id: scenario.contract.template.id,
          digest: otherMethod.method.digest,
        },
      })
    },
  },
  {
    key: 'composition-template',
    name: 'a Composition template ref for another object',
    code: 'COMPOSITION_MISMATCH',
    async prepare(service, scenario) {
      const other = await putValue(
        service,
        { v: 1, not: 'the pinned template' },
        nextId('s4a1-other-template'),
      )
      return s4a1Variant(service, scenario, { compositionTemplate: other })
    },
  },
  {
    key: 'composition-guidance',
    name: 'a Composition guidance ref for another object',
    code: 'COMPOSITION_MISMATCH',
    async prepare(service, scenario) {
      const other = await putValue(
        service,
        s4a1Guidance(S4A1_OTHER_GUIDANCE),
        nextId('s4a1-other-guidance'),
      )
      return s4a1Variant(service, scenario, { compositionGuidance: other })
    },
  },
  {
    key: 'guidance-missing',
    name: 'a missing guidance CAS object',
    code: 'OBJECT_MISSING',
    async prepare(service, scenario) {
      const missing: Ref = {
        id: 'guidance:s4a1-missing',
        digest: computeDigest('object', s4a1Guidance(S4A1_CURRENT_GUIDANCE)),
      }
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: missing,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: missing,
      })
    },
  },
  {
    key: 'guidance-digest',
    name: 'a guidance ref whose digest does not match its object',
    code: 'OBJECT_MISSING',
    async prepare(service, scenario) {
      const stored = await putValue(
        service,
        s4a1Guidance(S4A1_CURRENT_GUIDANCE),
        nextId('s4a1-guidance'),
      )
      const wrong: Ref = {
        id: stored.id,
        digest: computeDigest('object', s4a1Guidance(`${S4A1_CURRENT_GUIDANCE} changed`)),
      }
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: wrong,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: wrong,
      })
    },
  },
  {
    key: 'guidance-utf8',
    name: 'guidance bytes that are not strict UTF-8',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const invalid = await putBytes(service, new Uint8Array([0xff, 0xfe, 0xfd]), nextId('s4a1-guidance'))
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: invalid,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: invalid,
      })
    },
  },
  {
    key: 'guidance-object',
    name: 'guidance JSON that is not the frozen text object',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const invalid = await putValue(
        service,
        { v: 1, text: 42 },
        nextId('s4a1-guidance'),
      )
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: invalid,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: invalid,
      })
    },
  },
  {
    key: 'guidance-oversized',
    name: 'guidance above 8192 bytes',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const oversized = await putValue(
        service,
        s4a1Guidance('x'.repeat(S4A1_GUIDANCE_BYTES + 1)),
        nextId('s4a1-guidance'),
      )
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: oversized,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: oversized,
      })
    },
  },
  {
    key: 'guidance-oversized-multibyte',
    name: 'multi-byte guidance above 8192 bytes',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const oversized = await putValue(
        service,
        s4a1Guidance(`${'界'.repeat(2730)}abc`),
        nextId('s4a1-guidance'),
      )
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: oversized,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: oversized,
      })
    },
  },
  {
    key: 'method-id',
    name: 'a MethodRef id that differs from the frozen revision id',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const stored = await s4a1PutMethod(service, scenario.method)
      return s4a1Variant(service, scenario, {
        contractMethod: { id: 'method:s4a1-wrong-id', digest: stored.ref.digest },
      })
    },
  },
  {
    key: 'method-digest',
    name: 'a MethodRef digest that differs from the structured revision digest',
    code: 'OBJECT_DOMAIN_MISMATCH',
    async prepare(service, scenario) {
      const method = s4a1ResealMethod(scenario, scenario.method.templates)
      const reversed = Object.fromEntries(Object.entries(method).reverse())
      const ref = await putBytes(
        service,
        s4a1NonCanonical(reversed),
        nextId('s4a1-method'),
      )
      return s4a1Variant(service, scenario, {
        contractMethod: { id: method.id, digest: ref.digest },
        contractTemplate: {
          id: scenario.contract.template.id,
          digest: ref.digest,
        },
      })
    },
  },
  {
    key: 'template-valid-different',
    name: 'another valid TaskTemplate body',
    code: 'COMPOSITION_MISMATCH',
    async prepare(service, scenario) {
      const different = await putValue(
        service,
        { ...s4a1FirstTemplate(scenario), brief: 'A different but valid template body.' },
        nextId('s4a1-valid-template'),
        'object',
      )
      return s4a1Variant(service, scenario, { compositionTemplate: different })
    },
  },
  {
    key: 'guidance-noncanonical',
    name: 'non-canonical guidance bytes with a raw-byte ref',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const nonCanonical = await putBytes(
        service,
        s4a1NonCanonical({ v: 1, text: S4A1_CURRENT_GUIDANCE }),
        nextId('s4a1-guidance'),
      )
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance: nonCanonical,
      }]))
      return s4a1Variant(service, scenario, {
        method,
        compositionGuidance: nonCanonical,
      })
    },
  },
  {
    key: 'template-noncanonical',
    name: 'non-canonical template bytes with a raw-byte ref',
    code: 'COMPOSITION_MISMATCH',
    async prepare(service, scenario) {
      const reversed = Object.fromEntries(
        Object.entries(s4a1FirstTemplate(scenario)).reverse(),
      )
      const nonCanonical = await putBytes(
        service,
        s4a1NonCanonical(reversed),
        nextId('s4a1-template'),
      )
      return s4a1Variant(service, scenario, { compositionTemplate: nonCanonical })
    },
  },
  {
    key: 'guidance-tamper',
    name: 'tampered guidance CAS bytes',
    code: 'OBJECT_CORRUPT',
    async prepare(service, scenario, root) {
      const guidance = await putValue(
        service,
        s4a1Guidance(S4A1_CURRENT_GUIDANCE),
        nextId('s4a1-guidance'),
      )
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance,
      }]))
      const variant = await s4a1Variant(service, scenario, {
        method,
        compositionGuidance: guidance,
      })
      await s4a1TamperObject(
        root,
        guidance,
        s4a1Encoder.encode(canonicalize(s4a1Guidance('tampered guidance bytes'))),
      )
      return variant
    },
  },
  {
    key: 'template-tamper',
    name: 'tampered Composition template CAS bytes',
    code: 'OBJECT_CORRUPT',
    async prepare(service, scenario, root) {
      const template = s4a1FirstTemplate(scenario)
      const ref = await putValue(
        service,
        template,
        nextId('s4a1-template'),
        'object',
      )
      const variant = await s4a1Variant(service, scenario, { compositionTemplate: ref })
      await s4a1TamperObject(
        root,
        ref,
        s4a1Encoder.encode(canonicalize({ ...template, brief: 'tampered template bytes' })),
      )
      return variant
    },
  },
  {
    key: 'template-skills',
    name: 'a dangling template skill id',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        skills: ['skill:s4a1'],
      }]))
      return s4a1Variant(service, scenario, { method })
    },
  },
  {
    key: 'template-tools',
    name: 'a dangling template MCP tool id',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        tools: ['tool:s4a1'],
      }]))
      return s4a1Variant(service, scenario, { method })
    },
  },
  {
    key: 'contract-skill',
    name: 'contract skill resources that do not match the pinned Method',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const resource = await putValue(service, { v: 1, skill: 's4a1' }, nextId('s4a1-resource'))
      return s4a1Variant(service, scenario, {
        contractResources: {
          baseTools: [...scenario.contract.resources.baseTools],
          skills: [resource],
          mcpServers: [...scenario.contract.resources.mcpServers],
        },
      })
    },
  },
  {
    key: 'contract-mcp',
    name: 'contract MCP refs that do not match the pinned Method',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const resource = await putValue(service, { v: 1, mcp: 's4a1' }, nextId('s4a1-resource'))
      return s4a1Variant(service, scenario, {
        contractResources: {
          baseTools: [...scenario.contract.resources.baseTools],
          skills: [...scenario.contract.resources.skills],
          mcpServers: [resource],
        },
      })
    },
  },
  {
    key: 'contract-exploration',
    name: 'malformed frozen exploration snapshot',
    code: 'CONTRACT_INVALID',
    async prepare(service, scenario) {
      const resource = await putValue(service, { v: 1, exploration: 's4a1' }, nextId('s4a1-resource'))
      return s4a1Variant(service, scenario, {
        contractResources: {
          baseTools: [...scenario.contract.resources.baseTools],
          skills: [...scenario.contract.resources.skills],
          mcpServers: [...scenario.contract.resources.mcpServers],
          exploration: resource,
        },
      })
    },
  },
  {
    key: 'composition-skill',
    name: 'Composition skill refs that do not match the pinned Method',
    code: 'COMPOSITION_MISMATCH',
    async prepare(service, scenario) {
      const resource = await putValue(service, { v: 1, skill: 's4a1' }, nextId('s4a1-resource'))
      return s4a1Variant(service, scenario, { compositionSkills: [resource] })
    },
  },
  {
    key: 'composition-mcp',
    name: 'Composition MCP server refs that do not match the pinned Method',
    code: 'COMPOSITION_MISMATCH',
    async prepare(service, scenario) {
      const resource = await putValue(service, { v: 1, mcp: 's4a1' }, nextId('s4a1-resource'))
      return s4a1Variant(service, scenario, {
        compositionMcpServers: [{
          manifest: resource,
          bundle: resource,
          schema: resource,
          config: resource,
          transport: 'stdio',
          capabilities: [],
        }],
      })
    },
  },
]

for (const invalid of s4a1InvalidCases) {
  void test(`S4-A1 create rejects ${invalid.name} before Agent`, async () => {
    const root = await mkdtemp(join(tmpdir(), `s4a1-${invalid.key}-root-`))
    const workspace = await mkdtemp(join(tmpdir(), `s4a1-${invalid.key}-work-`))
    try {
      const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
      let variant: Awaited<ReturnType<typeof s4a1Variant>>
      try {
        const scenario = await buildScenario(service, {
          taskId: `task-s4a1-${invalid.key}`,
          maxRuns: 1,
        })
        variant = await invalid.prepare(service, scenario, root)
      } finally {
        await service.close()
      }
      const { ctx, state } = makeFakeContext({ resume: 'ok' })
      const before = await readFacts(root)
      await assert.rejects(
        executeSingleRun({
          ctx,
          journalRoot: root,
          workspace,
          runId: `run-s4a1-${invalid.key}`,
          sessionId: `session-s4a1-${invalid.key}`,
          admission: {
            contract: variant.contract,
            attempt: 1,
            budgetReservation: {
              tokens: 100_000,
              steps: 4,
              deadlineAt: variant.contract.limits.deadlineAt,
            },
          },
          composition: variant.composition,
          agentOptions,
          maxOutputBytes: 1024,
          verifier: {
            provider: variant.scenario.provider,
            verify() { throw new Error('invalid Method resources must not verify') },
          },
          clock: () => FIXED_NOW + 1000,
        }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === invalid.code,
      )
      assert.equal(state.createCalls.length + state.resumeCalls.length, 0)
      assert.deepEqual(await readFacts(root), before, 'invalid resources must not append facts')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
}

void test('S4-A1 8192-byte guidance is mounted at the fixed section name and order', async () => {
  const root = await mkdtemp(join(tmpdir(), 's4a1-boundary-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's4a1-boundary-work-'))
  const boundaryText = `${'界'.repeat(2730)}ab`
  assert.equal(s4a1Encoder.encode(boundaryText).byteLength, S4A1_GUIDANCE_BYTES)
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let variant: Awaited<ReturnType<typeof s4a1Variant>>
    try {
      const scenario = await buildScenario(service, { taskId: 'task-s4a1-boundary', maxRuns: 1 })
      const guidance = await putValue(
        service,
        s4a1Guidance(boundaryText),
        nextId('s4a1-guidance'),
      )
      const method = await s4a1PutMethod(service, s4a1ResealMethod(scenario, [{
        ...s4a1FirstTemplate(scenario),
        guidance,
      }]))
      variant = await s4a1Variant(service, scenario, {
        method,
        compositionGuidance: guidance,
      })
    } finally {
      await service.close()
    }
    const sections: { name: string; order: number; text: string; interpolate?: boolean }[] = []
    const { ctx, state } = makeFakeContext({ resume: 'ok', sections })
    const result = await executeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId: 'run-s4a1-boundary',
      sessionId: 'session-s4a1-boundary',
      admission: {
        contract: variant.contract,
        attempt: 1,
        budgetReservation: {
          tokens: 100_000,
          steps: 4,
          deadlineAt: variant.contract.limits.deadlineAt,
        },
      },
      composition: variant.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: variant.scenario.provider,
        verify() { throw new Error('no submission') },
      },
      clock: () => FIXED_NOW + 1000,
    })
    assert.ok(result.kind === 'settled')
    assert.equal(state.createCalls.length, 1)
    assert.equal(result.classification, 'failed')
    const guidanceSection = sections.find(section => section.name === 'singularity:method-guidance')
    assert.ok(guidanceSection, 'Agent setup must register the method guidance section')
    assert.equal(guidanceSection.order, 200)
    assert.equal(guidanceSection.interpolate, false)
    assert.equal(s4a1Encoder.encode(guidanceSection.text).byteLength, S4A1_GUIDANCE_BYTES)
    assert.equal(guidanceSection.text, boundaryText)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('S4-A1 create aborts when the actual scoped platformPrompt differs', async () => {
  const root = await mkdtemp(join(tmpdir(), 's4a1-platform-create-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's4a1-platform-create-work-'))
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId: 'task-s4a1-platform-create', maxRuns: 1 })
    } finally {
      await service.close()
    }
    const { ctx, state } = makeFakeContext({
      resume: 'ok',
      platformPromptText: 'wrong platform prompt',
    })
    await assert.rejects(executeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId: 'run-s4a1-platform-create',
      sessionId: 'session-s4a1-platform-create',
      admission: {
        contract: scenario.contract,
        attempt: 1,
        budgetReservation: {
          tokens: 100_000,
          steps: 4,
          deadlineAt: scenario.contract.limits.deadlineAt,
        },
      },
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() { throw new Error('platform prompt mismatch must not verify') },
      },
      clock: () => FIXED_NOW + 1000,
    }), /platform prompt/)

    assert.equal(state.followupCalls, 0, 'platform prompt mismatch must not send a wake')
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.disposed, 0, 'setup failure must not publish a disposable Agent')

    const facts = await readFacts(root)
    assert.equal(factsOfType(facts, 'run/submitted').length, 0)
    assert.equal(factsOfType(facts, 'run/closed').length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
