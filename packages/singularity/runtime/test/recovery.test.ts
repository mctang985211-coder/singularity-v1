import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

import {
  admitRootTask,
  canonicalize,
  computeDigest,
  executionRecordSchema,
  parseJsonText,
  parseProtocolValue,
  seal,
  sealMethodRevision,
  sealPublicReceipt,
  sealSubmissionManifest,
  validateEvidence,
} from '@singularity/protocol'
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

import { retrySingleRun, resumeSingleRun } from '../src/recovery.ts'
import { executeSingleRun } from '../src/run.ts'
import { DomainStore } from '../src/store.ts'
import { CommandService } from '../src/service.ts'
import { buildExecutionRecord } from '../src/verification.ts'
import type { RunVerifier, VerifierRequest } from '../src/verification.ts'
import { startWakeText } from '../src/wake.ts'
import { prepareWorkspace } from '../src/workspace.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const actor = { kind: 'runtime' as const, id: 's3c-recovery-test' }
const CRITERION_ID = 'declared-output'
const OUTPUT_ID = 'out'
const OUTPUT_PATH = 'out.txt'
const FIXED_NOW = 1_700_000_000_000

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
  const compositionTemplate = await putValue(service, { v: 1, templateId: 'template:s3c' }, 'composition-template:s3c')

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

  const composition: CompositionPayload = {
    v: 1,
    dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-alpha.2', config: dshConfig },
    platformPrompt: computeDigest('object', { platformPrompt: 's3c-recovery' }),
    contract: { id: contract.taskId, digest: contract.digest },
    template: compositionTemplate,
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

  const makeAgent = (sessionId: string): Agent => {
    const events: SessionEvent[] = [...(options.initialEvents ?? [])]
    const session = {
      id: sessionId as SessionId,
      snapshotEvents: () => events,
    } as unknown as Session
    return {
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
      whenIdle: () => Promise.resolve(),
    } as unknown as Agent
  }

  const agentCtx = {
    on() {},
    systemPrompt: {
      section() {},
      context() {},
    },
    tools: {
      register() {},
      guard() {},
      restrict() {},
      definitions: () => [],
    },
  }

  const runSetup = async (setup: AgentSetup | undefined, agent: Agent): Promise<void> => {
    if (setup !== undefined) await setup(agentCtx as never, agent)
  }

  const ctx = {
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
        const agent = makeAgent(String(createOptions.sessionId))
        await runSetup(createOptions.setup, agent)
        return {
          agent,
          dispose() {
            state.disposed += 1
            return Promise.resolve()
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
            return Promise.resolve()
          },
        }
      },
    },
    sessions: {
      get: (id: SessionId) => options.liveEvents === undefined
        ? undefined
        : {
            id,
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

function startWake(taskId: string, runId: string): string {
  return startWakeText(taskId, runId, {
    tokensPct: 100,
    stepsPct: 100,
    wallClockPct: 100,
    taskSlotsPct: 0,
  })
}

function admittedWakeEvent(sessionId: string, wakeId: string, text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    surfaceOp: 'append',
    data: {
      id: wakeId,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  } as unknown as SessionEvent
}

function usageEvents(
  inputTokens = 10,
  outputTokens = 2,
  steps = 1,
): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < steps; index += 1) {
    events.push({
      type: 'step/start',
      seq: events.length,
      data: {},
    } as unknown as SessionEvent)
    events.push({
      type: 'assistant/message',
      seq: events.length,
      data: {
        message: { id: `assistant-${String(index)}`, role: 'assistant', content: [] },
        usage: { inputTokens, outputTokens },
      },
    } as unknown as SessionEvent)
  }
  return events
}

function unchangedFacts(root: string): Promise<readonly Fact[]> {
  return readFacts(root)
}

for (const mode of ['closed', 'active', 'exhausted', 'reservation', 'corrupt-resume', 'same-run'] as const) {
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
            tokens: mode === 'corrupt-resume' ? scenario.contract.limits.maxTokens + 1 : 10_000,
          })
          if (mode !== 'active' && mode !== 'corrupt-resume') {
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
        runId: mode === 'same-run' || mode === 'corrupt-resume' ? 'old-run' : 'new-run',
        sessionId: mode === 'same-run' || mode === 'corrupt-resume' ? 'old-session' : 'new-session',
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
      await assert.rejects(mode === 'corrupt-resume' ? resumeSingleRun(request) : executeSingleRun(request),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === (
          mode === 'reservation' || mode === 'corrupt-resume' ? 'BUDGET_EXCEEDED'
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
  const nextWorkspace = await mkdtemp(join(tmpdir(), 's3c-retry-work-next-'))
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

    const { ctx, state } = makeFakeContext({ resume: 'ok' })
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
  const nextWorkspace = await mkdtemp(join(tmpdir(), 's3c-retry-evidence-next-'))
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

    const { ctx, state } = makeFakeContext({ resume: 'ok' })
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

void test('resumeSingleRun composition mismatch writes invalid closure with zero Agent and verifier calls', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-mismatch-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-mismatch-work-'))
  const taskId = 'task-s3c-mismatch'
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    let before: readonly Fact[]
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 1 })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId, sessionId, attempt: 1 })
      before = await readFacts(root)
    } finally {
      await service.close()
    }

    const { ctx, state } = makeFakeContext({ resume: 'ok' })
    let verifierCalls = 0
    const result = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: {
        ...scenario.composition,
        platformPrompt: computeDigest('object', { platformPrompt: 'different-composition' }),
      },
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() {
          verifierCalls += 1
          throw new Error('verifier must not run on composition mismatch')
        },
      },
      clock: () => FIXED_NOW + 1000,
    })

    assert.equal(state.createCalls.length, 0)
    assert.equal(state.resumeCalls.length, 0)
    assert.equal(state.followupCalls, 0)
    assert.equal(verifierCalls, 0)
    assert.equal(result.compositionMatched, false)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.classification, 'invalid')
    assert.ok(result.executionRecord)
    assert.match(result.executionRecord.reason, /composition-mismatch/)
    assert.equal(result.evidence, undefined)
    assert.equal(result.receipt, undefined)
    assert.deepEqual(result.facts.slice(0, before.length).map(fact => fact.digest), before.map(fact => fact.digest))

    const facts = await readFacts(root)
    const closed = factsOfType(facts, 'run/closed')
    assert.equal(closed.length, 1)
    assert.equal(closed[0].data.classification, 'invalid')
    assert.equal(closed[0].data.reason, 'composition-mismatch')
    assert.equal('executionRecordRef' in closed[0].data, true)
    assert.equal('evidenceRef' in closed[0].data, false)
    const taskClosed = factsOfType(facts, 'task/closed')[0]
    assert.equal(taskClosed.data.outcome, 'invalid')
    assert.equal(taskClosed.data.decisiveRunId, runId)
    assert.equal(factsOfType(facts, 'run/submitted').length, 0)

    const closedDigest = closed[0].digest
    const recordRef = (closed[0].data as { readonly executionRecordRef?: Ref }).executionRecordRef
    assert.ok(recordRef)
    const store = await DomainStore.open({ root })
    try {
      const record = parseProtocolValue(
        executionRecordSchema,
        parseJsonText(textDecoder.decode((await store.readObject(recordRef, 'object')).bytes)),
      )
      assert.equal(record.runId, runId)
      assert.match(record.reason, /composition-mismatch/)
      assert.equal(record.usage.unknownRequests, 1)
      assert.equal(record.usage.inputTokens, 0)
      assert.equal(record.sessionCut.sessionId, sessionId)
    } finally {
      await store.close()
    }

    const second = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() {
          verifierCalls += 1
          throw new Error('verifier must not run on idempotent resume')
        },
      },
      clock: () => FIXED_NOW + 2000,
    })
    assert.equal(second.classification, 'invalid')
    assert.equal(second.retry.allowed, false)
    assert.equal(verifierCalls, 0)
    const afterSecond = await readFacts(root)
    assert.equal(factsOfType(afterSecond, 'run/closed').length, 1)
    assert.equal(findFact(afterSecond, 'run/closed')?.digest, closedDigest)
    assert.equal(state.createCalls.length + state.resumeCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('resumeSingleRun submitted recovery reuses the frozen manifest and operationId, then becomes idempotent', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-submitted-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-submitted-work-'))
  const taskId = 'task-s3c-submitted'
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    let manifestRef: Ref
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 1 })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId, sessionId, attempt: 1 })
      const submitted = await submitRun(service, scenario, { runId, sessionId })
      manifestRef = submitted.manifestRef
    } finally {
      await service.close()
    }

    const { ctx, state } = makeFakeContext({ resume: 'ok', liveEvents: usageEvents() })
    const requests: VerifierRequest[] = []
    const verifier: RunVerifier = {
      provider: scenario.provider,
      verify(request) {
        requests.push(request)
        return Promise.resolve(sealPublicReceipt({
          v: 1,
          provider: scenario.provider,
          operationId: request.operationId,
          contractDigest: request.task.digest,
          inputDigests: request.inputs.map(ref => ref.digest),
          outputDigests: request.outputs.map(ref => ref.digest),
          criteria: [{ id: CRITERION_ID, verdict: 'pass', reason: 'frozen pass' }],
          exit: { code: 0, signal: null },
          timedOut: false,
        }))
      },
    }

    const result = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier,
      clock: () => FIXED_NOW + 1000,
    })

    assert.equal(result.compositionMatched, true)
    assert.equal(result.recoveredSubmission, true)
    assert.equal(result.sessionAction, 'none')
    assert.equal(result.classification, 'verified')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.operationId, `${runId}:verify`)
    assert.equal(requests[0]?.task.digest, scenario.contract.digest)
    assert.deepEqual(requests[0]?.inputs, scenario.contract.spec.inputs.map(input => input.object))
    assert.deepEqual(requests[0]?.outputs, [scenario.output])
    assert.equal(state.createCalls.length + state.resumeCalls.length, 0)
    assert.equal(state.followupCalls, 0)

    const facts = await readFacts(root)
    assert.equal(factsOfType(facts, 'run/submitted').length, 1)
    assert.equal(factsOfType(facts, 'run/closed').length, 1)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.equal(closed.data.classification, 'verified')
    assert.equal('evidenceRef' in closed.data, true)
    assert.equal(factsOfType(facts, 'task/closed')[0].data.outcome, 'verified')
    assert.equal(result.evidenceRef?.digest, (closed.data as { readonly evidenceRef?: Ref }).evidenceRef?.digest)
    assert.equal(result.manifestRef?.digest, manifestRef.digest)
    assert.ok(result.evidence)
    assert.equal(validateEvidence(result.evidence, {
      contract: scenario.contract,
      runId,
      composition: (findFact(facts, 'run/opened')?.data as { readonly composition: Ref }).composition,
    }).valid, true)
    assert.equal(result.evidence.usage.unknownRequests, 0)
    assert.equal(result.evidence.usage.inputTokens, 10)
    assert.equal(result.evidence.usage.outputTokens, 2)
    assert.equal(result.evidence.sessionCut.sessionId, sessionId)
    assert.equal(result.usage.unknownRequests, 0)
    assert.ok(result.receipt)
    assert.equal(result.receiptRef?.digest, result.receipt.digest)

    const second = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier,
      clock: () => FIXED_NOW + 2000,
    })
    assert.equal(second.classification, 'verified')
    assert.equal(second.recoveredSubmission, false)
    assert.equal(requests.length, 1, 'idempotent resume must not verify again')
    const afterSecond = await readFacts(root)
    assert.equal(afterSecond.length, facts.length)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('resumeSingleRun submitted timeout closes invalid ExecutionRecord without Evidence', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-timeout-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-timeout-work-'))
  const taskId = 'task-s3c-timeout'
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 2 })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId, sessionId, attempt: 1 })
      await submitRun(service, scenario, { runId, sessionId })
    } finally {
      await service.close()
    }

    const { ctx } = makeFakeContext({ resume: 'ok', liveEvents: usageEvents() })
    let calls = 0
    const result = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify(request) {
          calls += 1
          return Promise.resolve(sealPublicReceipt({
            v: 1,
            provider: scenario.provider,
            operationId: request.operationId,
            contractDigest: request.task.digest,
            inputDigests: request.inputs.map(ref => ref.digest),
            outputDigests: request.outputs.map(ref => ref.digest),
            criteria: [{ id: CRITERION_ID, verdict: 'pass', reason: 'passed before timeout' }],
            exit: { code: null, signal: null },
            timedOut: true,
          }))
        },
      },
      transientInvalidReasons: ['verifier-timeout'],
      clock: () => FIXED_NOW + 1000,
    })

    assert.equal(calls, 1)
    assert.equal(result.classification, 'invalid')
    assert.equal(result.evidence, undefined)
    assert.ok(result.executionRecord)
    assert.match(result.executionRecord.reason, /timeout/i)
    const facts = await readFacts(root)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.equal(closed.data.classification, 'invalid')
    assert.equal(closed.data.reason, 'verifier-timeout')
    assert.equal('executionRecordRef' in closed.data, true)
    assert.equal(factsOfType(facts, 'task/closed').length, 0, 'transient invalid retry remains allowed')
    assert.equal(result.retry.allowed, true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('resumeSingleRun rejects an unverifiable frozen submission without calling the verifier', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-badsub-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-badsub-work-'))
  const taskId = 'task-s3c-badsub'
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 1 })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId, sessionId, attempt: 1 })
      const brokenRef = await putValue(service, { v: 1, not: 'a manifest' }, `${runId}:submission`, 'object')
      await commitFact(service, 'run/submitted', {
        runId,
        outputs: brokenRef,
        transcriptOffset: { sessionId, seq: 1 },
        previewReceipts: [],
        readReceipts: [],
        planningSketchRef: brokenRef,
        feedbackRefs: [],
      }, `run:${runId}:submitted`)
    } finally {
      await service.close()
    }

    const { ctx } = makeFakeContext({ resume: 'ok' })
    let verifierCalls = 0
    const result = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() {
          verifierCalls += 1
          throw new Error('verifier must not run when the frozen submission is unreadable')
        },
      },
      clock: () => FIXED_NOW + 1000,
    })

    assert.equal(verifierCalls, 0)
    assert.equal(result.classification, 'invalid')
    assert.ok(result.executionRecord)
    assert.match(result.executionRecord.reason, /submission-invalid/i)
    const facts = await readFacts(root)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.equal(closed.data.classification, 'invalid')
    assert.equal('evidenceRef' in closed.data, false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('resumeSingleRun resumes the same session and does not resend an admitted stable wake', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-open-root-'))
  const workspace = await mkdtemp(join(tmpdir(), 's3c-open-work-'))
  const taskId = 'task-s3c-open'
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    let factsBefore: readonly Fact[]
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 1, inputAccess: 'copy-to-work' })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId, sessionId, attempt: 1 })
      await prepareWorkspace(workspace, scenario.contract.spec.inputs, service)
      await writeFile(join(workspace, 'input.txt'), 'work in progress')
      factsBefore = await readFacts(root)
    } finally {
      await service.close()
    }

    const wakeText = startWake(taskId, runId)
    const { ctx, state } = makeFakeContext({
      resume: 'ok',
      initialEvents: [admittedWakeEvent(sessionId, `${runId}:start`, wakeText, 0)],
    })
    const result = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() { throw new Error('verifier must not run without a submission') },
      },
      clock: () => FIXED_NOW + 1000,
    })

    assert.equal(result.compositionMatched, true)
    assert.equal(await readFile(join(workspace, 'input.txt'), 'utf8'), 'work in progress')
    assert.equal(result.sessionAction, 'resumed')
    assert.equal(result.wakeOutcome, 'already-admitted')
    assert.equal(state.resumeCalls.length, 1)
    assert.equal(state.resumeCalls[0]?.sessionId, sessionId)
    assert.equal(state.createCalls.length, 0)
    assert.equal(state.followupCalls, 0, 'an admitted stable wake must not be resend or re-purchased')
    assert.equal(result.classification, 'failed')
    assert.ok(result.executionRecord)
    assert.match(result.executionRecord.reason, /no-submission/i)

    const facts = await readFacts(root)
    assert.equal(factsOfType(facts, 'run/opened').length, 1)
    const closed = factsOfType(facts, 'run/closed')[0]
    assert.equal(closed.data.classification, 'failed')
    assert.equal('executionRecordRef' in closed.data, true)
    assert.equal(factsOfType(facts, 'task/closed')[0].data.outcome, 'failed')
    assert.deepEqual(facts.slice(0, factsBefore.length).map(fact => fact.digest), factsBefore.map(fact => fact.digest))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('resumeSingleRun refuses a persisted session with a missing workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-lost-workspace-'))
  const workspace = join(root, 'missing-workspace')
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId: 'lost-workspace', maxRuns: 1 })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId: 'lost-run', sessionId: 'lost-session', attempt: 1 })
    } finally {
      await service.close()
    }
    const { ctx, state } = makeFakeContext({ resume: 'ok' })
    const result = await resumeSingleRun({
      ctx, journalRoot: root, workspace, runId: 'lost-run',
      composition: scenario.composition, agentOptions, maxOutputBytes: 1024,
      verifier: { provider: scenario.provider, verify() { throw new Error('must not verify') } },
      clock: () => FIXED_NOW + 1000,
    })
    assert.equal(result.classification, 'invalid')
    assert.equal(state.createCalls.length, 0)
    assert.equal(state.followupCalls, 0)
    await assert.rejects(access(workspace), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('resumeSingleRun creates the same session intent when persistence is absent', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's3c-create-root-'))
  const workspace = join(root, 'workspace')
  const taskId = 'task-s3c-create'
  const runId = `${taskId}-run-1`
  const sessionId = `${taskId}-session-1`
  try {
    const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
    let scenario: Scenario
    try {
      scenario = await buildScenario(service, { taskId, maxRuns: 1, inputAccess: 'copy-to-work' })
      await admitTask(service, scenario)
      await openRun(service, scenario, { runId, sessionId, attempt: 1 })
    } finally {
      await service.close()
    }

    const { ctx, state } = makeFakeContext({ resume: 'missing' })
    const result = await resumeSingleRun({
      ctx,
      journalRoot: root,
      workspace,
      runId,
      composition: scenario.composition,
      agentOptions,
      maxOutputBytes: 1024,
      verifier: {
        provider: scenario.provider,
        verify() { throw new Error('verifier must not run without a submission') },
      },
      clock: () => FIXED_NOW + 1000,
    })

    assert.equal(result.sessionAction, 'created')
    assert.equal(result.wakeOutcome, 'sent')
    assert.equal(state.resumeCalls.length, 1)
    assert.equal(state.createCalls.length, 1)
    assert.equal(state.createCalls[0]?.sessionId, sessionId)
    assert.equal(state.createCalls[0]?.cwd, workspace)
    assert.equal(await readFile(join(workspace, 'input.txt'), 'utf8'), 'fixture input bytes\n')
    assert.equal(state.followupCalls, 1)
    assert.equal(result.classification, 'failed')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
