import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import {
  admitRootTask,
  canonicalize,
  computeDigest,
  evaluationCaseSchema,
  parseProtocolValue,
  replayPointSchema,
  seal,
  sealEvidence,
  sealMethodRevision,
  sealPublicReceipt,
  taskContractSchema,
  verifyTaskContract,
} from '@singularity/protocol'
import type {
  Fact,
  GlobalResourceSnapshot,
  MethodRevision,
  PublicReceipt,
  Ref,
  ReplayClosure,
  ReplayPoint,
  RunState,
  SkillAsset,
  TaskContract,
  TaskCriterion,
  TaskRunState,
  TaskState,
  ToolAsset,
  UsageRecord,
} from '@singularity/protocol'

import {
  BaselineDriftError,
  ReplayContractError,
  ReplayScopeError,
  assertBaselineFidelity,
  assertScopedCandidate,
  bindingPathFromTask,
  captureReplayPoints,
  contractForLocalSlot,
  replayCaseFromContract,
  replayFanOut,
} from '../src/replay.ts'
import type { ReplayStore } from '../src/replay.ts'
import { CommandService } from '../src/service.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const usage = (inputTokens = 10, outputTokens = 2): UsageRecord => ({
  inputTokens, outputTokens, steps: 1, unknownRequests: 0,
})

const bestEffort: ReplayClosure = {
  level: 'best-effort', workspace: 'uncontrolled', network: 'uncontrolled',
  hostFilesystem: 'uncontrolled', reasons: ['fixture'],
}

const closedClosure: ReplayClosure = {
  level: 'closed', workspace: 'fresh-cas-inputs', network: 'disabled',
  hostFilesystem: 'denied', executionProof: ref('proof'), reasons: [],
}

function ref(id: string, value: unknown = id): Ref {
  return { id, digest: computeDigest('object', { id, value: value as never }) }
}

function skill(id: string, name = id): SkillAsset {
  return { id, name, description: `${id} skill`, bundle: ref(`skill-bundle:${id}`) }
}

function tool(id: string): ToolAsset {
  return {
    id, name: id, description: `${id} server`, kind: 'mcp-server',
    server: {
      bundle: ref(`tool-bundle:${id}`), manifest: ref(`manifest:${id}`),
      sourceFiles: ref(`source:${id}`), config: ref(`config:${id}`),
      transport: 'stdio', capabilities: [], exposedTools: [],
    },
  }
}

function template(
  id: string,
  options: {
    readonly skills?: readonly string[]
    readonly tools?: readonly string[]
    readonly children?: readonly { readonly bindingId: string; readonly templateId: string; readonly brief: string; readonly join: 'required' | 'probe' }[]
    readonly brief?: string
  } = {},
) {
  return {
    id,
    brief: options.brief ?? `${id} brief`,
    guidance: ref(`guidance:${id}`),
    example: ref(`example:${id}`),
    instanceSchema: {},
    acceptancePolicy: ref(`acceptance:${id}`),
    skills: [...(options.skills ?? [])],
    tools: [...(options.tools ?? [])],
    children: [...(options.children ?? [])],
  }
}

class FixtureCas implements ReplayStore {
  readonly factsList: Fact[] = []
  readonly service: CommandService

  constructor(service: CommandService) {
    this.service = service
  }

  facts(): readonly Fact[] {
    return this.factsList
  }

  readObject(ref: Ref, domain: Parameters<ReplayStore['readObject']>[1] = 'object') {
    return this.service.readObject(ref, domain)
  }

  putObject(id: string, bytes: Uint8Array, domain: Parameters<ReplayStore['putObject']>[2] = 'object') {
    return this.service.putObject(id, bytes, domain)
  }
}

async function putJson(cas: ReplayStore, id: string, value: unknown, domain: Parameters<ReplayStore['putObject']>[2] = 'object'): Promise<Ref> {
  return cas.putObject(id, encoder.encode(canonicalize(value as never)), domain)
}

async function readJson(cas: ReplayStore, refValue: Ref, domain: Parameters<ReplayStore['readObject']>[1] = 'object'): Promise<unknown> {
  const { bytes } = await cas.readObject(refValue, domain)
  return JSON.parse(decoder.decode(bytes)) as unknown
}

function taskCriterion(id: string, metric = false): TaskCriterion {
  return {
    id, statement: `${id} statement`, required: true, check: 'true',
    ...(metric ? { checkOutput: 'metric-json' as const } : {}),
  }
}

async function contractFixture(cas: ReplayStore, options: {
  readonly taskId: string
  readonly method: MethodRevision
  readonly templateId?: string
  readonly criteria?: readonly TaskCriterion[]
  readonly outputs?: TaskContract['spec']['outputs']
  readonly exploration?: Ref
  readonly deadlineAt?: number
}): Promise<{ readonly contract: TaskContract; readonly ref: Ref; readonly acceptance: Ref }> {
  const acceptance = await putJson(cas, `acceptance:${options.taskId}`, { id: 'verifier' })
  const profile = await putJson(cas, `profile:${options.taskId}`, { id: 'profile' })
  const seed = await putJson(cas, `seed:${options.taskId}`, { id: 'seed' })
  const contract = admitRootTask({
    taskId: options.taskId,
    spec: {
      goal: { summary: 'fixture', deliverable: 'fixture', scope: [], constraints: [] },
      criteria: [...(options.criteria ?? [])],
      inputs: [],
      outputs: [...(options.outputs ?? [])],
    },
    origin: { kind: 'root' as const, purpose: 'evaluation' as const, requestRef: ref(`request:${options.taskId}`) },
    method: { id: options.method.id, digest: options.method.digest },
    template: { id: options.templateId ?? options.method.templates[0].id, digest: options.method.digest },
    resources: {
      baseTools: [], skills: [], mcpServers: [],
      ...(options.exploration === undefined ? {} : { exploration: options.exploration }),
    },
    acceptance,
    environment: { seed, profile },
    limits: {
      maxRuns: 4, maxStepsPerRun: 10, maxTokens: 10_000,
      deadlineAt: options.deadlineAt ?? 5_000_000,
      maxDepth: 2, maxTasks: 8, maxBatchChildren: 2,
    },
  })
  return { contract, ref: await putJson(cas, `contract:${options.taskId}`, contract, 'contract'), acceptance }
}

async function evidenceFixture(cas: ReplayStore, options: {
  readonly contract: TaskContract
  readonly contractRef: Ref
  readonly runId: string
  readonly outcome: 'verified' | 'failed'
  readonly metric?: number
  readonly composition?: Ref
}): Promise<{ readonly evidenceRef: Ref; readonly receiptRef: Ref; readonly receipt: PublicReceipt; readonly usage: UsageRecord }> {
  const criteria = options.contract.spec.criteria.filter(criterion => criterion.required).map(criterion => ({
    id: criterion.id,
    verdict: options.outcome === 'verified' ? 'pass' as const : 'fail' as const,
    reason: 'fixture',
    ...(options.metric === undefined ? {} : { metric: { name: 'score', unit: 'points', value: options.metric } }),
  }))
  const operationId = `${options.runId}:verify`
  const receipt = sealPublicReceipt({
    v: 1, provider: options.contract.acceptance, operationId,
    contractDigest: options.contract.digest, inputDigests: [], outputDigests: [],
    criteria, exit: { code: 0, signal: null }, timedOut: false,
  })
  const receiptRef = await putJson(cas, `${options.runId}:receipt`, receipt)
  const runUsage = usage()
  const evidence = sealEvidence({
    v: 1 as const,
    task: { id: options.contract.taskId, digest: options.contract.digest },
    runId: options.runId,
    contractDigest: options.contract.digest,
    method: options.contract.method,
    inputs: [],
    outputs: [],
    composition: options.composition ?? ref(`composition:${options.runId}`),
    verification: { provider: options.contract.acceptance, operationId, publicReceipt: receiptRef },
    usage: runUsage,
    sessionCut: { sessionId: options.runId, from: 0, to: 1 },
    environment: { seed: options.contract.environment.seed.digest, mode: 'workspace' },
  })
  return {
    evidenceRef: await putJson(cas, `${options.runId}:evidence`, evidence, 'evidence'),
    receiptRef, receipt, usage: runUsage,
  }
}

function runFixture(options: {
  readonly taskId: string
  readonly runId: string
  readonly attempt: number
  readonly outcome?: 'verified' | 'failed'
  readonly evidenceRef?: Ref
  readonly executionRecordRef?: Ref
  readonly usage?: UsageRecord
}): RunState {
  return {
    runId: options.runId,
    taskId: options.taskId,
    attempt: options.attempt,
    phase: 'closed',
    childIds: [],
    opened: {
      taskId: options.taskId, runId: options.runId, attempt: options.attempt,
      sessionId: `${options.runId}:session`, composition: ref(`composition:${options.runId}`),
      workspaceKey: `${options.runId}:workspace`, workspaceSeed: ref('seed'),
      budgetReservation: { tokens: 1000, steps: 10, deadlineAt: 5_000_000 },
    },
    closed: {
      classification: options.outcome ?? 'verified', reason: 'fixture', source: 'run/closed',
      factDigest: ref(`run-fact:${options.runId}`).digest, usage: options.usage ?? usage(),
      ...(options.evidenceRef === undefined ? {} : { evidenceRef: options.evidenceRef }),
      ...(options.executionRecordRef === undefined ? {} : { executionRecordRef: options.executionRecordRef }),
    },
  }
}

function taskFixture(options: {
  readonly taskId: string
  readonly contract: TaskContract
  readonly rootTaskId?: string
  readonly parentTaskId?: string
  readonly bindingId?: string
  readonly runIds: readonly string[]
  readonly childIds?: readonly string[]
  readonly outcome: 'verified' | 'failed' | 'invalid' | 'cancelled'
  readonly source?: 'task/closed' | 'subtree-cancellation'
}): TaskState {
  return {
    taskId: options.taskId,
    contract: options.contract,
    rootTaskId: options.rootTaskId ?? options.taskId,
    depth: options.parentTaskId === undefined ? 0 : 1,
    phase: 'closed',
    runIds: [...options.runIds],
    childIds: [...(options.childIds ?? [])],
    ...(options.parentTaskId === undefined ? {} : {
      parentTaskId: options.parentTaskId,
      parentRunId: `${options.parentTaskId}:run`,
      batchId: 'batch',
      bindingId: options.bindingId,
      join: 'probe' as const,
    }),
    closed: {
      outcome: options.outcome, reason: 'fixture',
      source: options.source ?? 'task/closed',
      factDigest: ref(`task-fact:${options.taskId}`).digest,
    },
  }
}

function stateFixture(tasks: readonly TaskState[], runs: readonly RunState[]): TaskRunState {
  return {
    tasks: new Map(tasks.map(task => [task.taskId, task])),
    runs: new Map(runs.map(run => [run.runId, run])),
    batches: new Map(),
  }
}

async function traceFixture(cas: FixtureCas, options: {
  readonly rootTaskId: string
  readonly method: MethodRevision
  readonly rootContract: TaskContract
  readonly children: readonly unknown[]
}): Promise<Ref> {
  const contractRef = await putJson(cas, `trace:${options.rootTaskId}:contract`, options.rootContract)
  const childrenRef = await putJson(cas, `trace:${options.rootTaskId}:children`, options.children)
  const total = usage()
  const body = seal('object', {
    v: 1, kind: 'public-task-trace', traceId: `trace:${options.rootTaskId}`,
    rootTask: { id: options.rootTaskId, outcome: 'verified', method: { id: options.method.id, digest: options.method.digest } },
    sourceResourceSnapshot: ref('source-resources'),
    chapters: [
      { id: 'contract', object: contractRef, sizeClass: 'small', pages: 1 },
      { id: 'children', object: childrenRef, sizeClass: 'small', pages: 1 },
    ],
    authorizedObjects: [],
    usage: total,
    sessionCuts: [],
  })
  const traceRef = await putJson(cas, `trace:${options.rootTaskId}`, body)
  cas.factsList.push({
    type: 'rsi/trace-sealed',
    data: { rootTaskId: options.rootTaskId, trace: traceRef, usage: total, sessionCuts: [] },
    digest: ref(`trace-fact:${options.rootTaskId}`).digest,
  } as unknown as Fact)
  return traceRef
}

function traceChild(options: {
  readonly taskId: string
  readonly runId: string
  readonly outcome: 'verified' | 'failed'
  readonly contract: TaskContract
  readonly evidenceRef: Ref
}): unknown {
  return {
    taskId: options.taskId,
    runId: options.runId,
    attempt: 1,
    outcome: options.outcome,
    contract: options.contract,
    transcript: ref(`transcript:${options.runId}`),
    receipts: [],
    result: { evidenceRef: options.evidenceRef, evidence: {}, publicReceipt: ref('receipt') },
  }
}

function pointFixture(overrides: Partial<ReplayPoint> & { readonly sourceCase: Ref; readonly baseMethod: Ref; readonly sourceContract: Ref; readonly sourceEvidence: Ref }): ReplayPoint {
  return parseProtocolValue(replayPointSchema, {
    v: 1,
    id: 'point:fixture',
    sourceTrace: ref('trace'),
    sourceTaskId: 'task',
    templateId: 'template',
    bindingPath: [],
    outcome: 'verified',
    localCases: [overrides.sourceCase],
    closure: bestEffort,
    fanOut: { bindingReferences: 0, shared: false },
    hostFingerprint: 'host-a',
    ...overrides,
  })
}

async function explorationFixture(cas: ReplayStore, options: {
  readonly acceptance: Ref
  readonly skills?: readonly SkillAsset[]
  readonly tools?: readonly ToolAsset[]
}): Promise<Ref> {
  const snapshot: GlobalResourceSnapshot = {
    v: 1,
    documents: [],
    skills: [...(options.skills ?? [])],
    tools: [...(options.tools ?? [])],
    baseTools: [],
    fallbackAcceptance: options.acceptance,
    fallbackJoin: 'probe',
  }
  return putJson(cas, 'exploration', snapshot)
}

async function setup(t: TestContext): Promise<{ readonly root: string; readonly service: CommandService; readonly cas: FixtureCas }> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-replay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root, actor: { kind: 'runtime', id: 'replay-test' }, clock: () => 1000 })
  t.after(() => service.close())
  return { root, service, cas: new FixtureCas(service) }
}

void test('capture derives verified/failed anchors, binding paths, retries and token features from one sealed trace', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({
    v: 1, id: 'base', entryTemplateId: 'template',
    templates: [template('template', { children: [{ bindingId: 'child', templateId: 'template', brief: 'child', join: 'probe' }] })],
    skills: [], tools: [],
  })
  await putJson(cas, 'base', base, 'method')
  const rootContract = await contractFixture(cas, { taskId: 'root', method: base })
  const childContract = await contractFixture(cas, {
    taskId: 'child', method: base, templateId: 'template', criteria: [taskCriterion('quality', true)],
  })
  const rootEvidence = await evidenceFixture(cas, {
    contract: rootContract.contract, contractRef: rootContract.ref, runId: 'root:run', outcome: 'verified',
  })
  const childEvidence = await evidenceFixture(cas, {
    contract: childContract.contract, contractRef: childContract.ref, runId: 'child:run:2', outcome: 'failed', metric: 0,
  })
  const trace = await traceFixture(cas, {
    rootTaskId: 'root', method: base, rootContract: rootContract.contract,
    children: [
      traceChild({ taskId: 'root', runId: 'root:run', outcome: 'verified', contract: rootContract.contract, evidenceRef: rootEvidence.evidenceRef }),
      traceChild({ taskId: 'child', runId: 'child:run:1', outcome: 'failed', contract: childContract.contract, evidenceRef: childEvidence.evidenceRef }),
      traceChild({ taskId: 'child', runId: 'child:run:2', outcome: 'failed', contract: childContract.contract, evidenceRef: childEvidence.evidenceRef }),
    ],
  })
  const state = stateFixture([
    taskFixture({ taskId: 'root', contract: rootContract.contract, runIds: ['root:run'], childIds: ['child'], outcome: 'verified' }),
    taskFixture({ taskId: 'child', contract: childContract.contract, rootTaskId: 'root', parentTaskId: 'root', bindingId: 'child', runIds: ['child:run:1', 'child:run:2'], outcome: 'failed' }),
  ], [
    runFixture({ taskId: 'root', runId: 'root:run', attempt: 1, evidenceRef: rootEvidence.evidenceRef }),
    runFixture({ taskId: 'child', runId: 'child:run:1', attempt: 1, outcome: 'failed', executionRecordRef: ref('record:1'), usage: usage(3, 1) }),
    runFixture({ taskId: 'child', runId: 'child:run:2', attempt: 2, outcome: 'failed', evidenceRef: childEvidence.evidenceRef }),
  ])
  const points = await captureReplayPoints({
    store: cas, trace, state, base,
    hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000,
  })
  assert.equal(points.length, 2)
  const child = points.find(value => value.point.sourceTaskId === 'child')
  const root = points.find(value => value.point.sourceTaskId === 'root')
  assert.ok(child !== undefined && root !== undefined)
  assert.deepEqual(child.point.bindingPath, ['child'])
  assert.deepEqual(root.point.bindingPath, [])
  assert.equal(child.point.outcome, 'failed')
  assert.equal(child.failed, true)
  assert.equal(child.leaf, true)
  assert.equal(child.retries, 1)
  assert.equal(root.leaf, false)
  assert.equal(root.retries, 0)
  assert.equal(child.qualityHeadroom, true)
  assert.equal(root.qualityHeadroom, false)
  assert.equal(child.point.closure.level, 'best-effort')
  assert.deepEqual(child.point.fanOut, { bindingReferences: 1, shared: true })
  assert.equal(child.point.sourceCase.id, child.point.localCases[0]?.id)
  assert.equal(child.point.localCases.length, 1)
  assert.equal(child.rootTokens, 28)
  assert.equal(child.subtreeTokens, 16)
  const frozen = parseProtocolValue(evaluationCaseSchema, await readJson(cas, child.point.sourceCase))
  assert.equal(frozen.limits.deadlineAt, 9_000_000)
  assert.ok(child.pointRef.digest.startsWith('sha256:'))
})

void test('capture excludes invalid, cancelled and no-submission Tasks instead of manufacturing anchors', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({ v: 1, id: 'base', entryTemplateId: 'template', templates: [template('template')], skills: [], tools: [] })
  await putJson(cas, 'base', base, 'method')
  const invalid = await contractFixture(cas, { taskId: 'invalid', method: base })
  const cancelled = await contractFixture(cas, { taskId: 'cancelled', method: base })
  const noSubmission = await contractFixture(cas, { taskId: 'no-submission', method: base })
  const trace = await traceFixture(cas, {
    rootTaskId: 'invalid', method: base, rootContract: invalid.contract, children: [],
  })
  const state = stateFixture([
    taskFixture({ taskId: 'invalid', contract: invalid.contract, runIds: ['invalid:run'], outcome: 'invalid' }),
    taskFixture({ taskId: 'cancelled', contract: cancelled.contract, runIds: ['cancelled:run'], outcome: 'cancelled', source: 'subtree-cancellation' }),
    taskFixture({ taskId: 'no-submission', contract: noSubmission.contract, runIds: ['no-submission:run'], outcome: 'failed' }),
  ], [
    runFixture({ taskId: 'invalid', runId: 'invalid:run', attempt: 1, outcome: 'failed', executionRecordRef: ref('invalid:record') }),
    runFixture({ taskId: 'cancelled', runId: 'cancelled:run', attempt: 1, outcome: 'failed', executionRecordRef: ref('cancelled:record') }),
    runFixture({ taskId: 'no-submission', runId: 'no-submission:run', attempt: 1, outcome: 'failed', executionRecordRef: ref('no-submission:record') }),
  ])
  const points = await captureReplayPoints({
    store: cas, trace, state, base, hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000,
  })
  assert.deepEqual(points, [])
})

void test('capture refuses contradictory Evidence and receipt data from a sealed source', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({ v: 1, id: 'base', entryTemplateId: 'template', templates: [template('template')], skills: [], tools: [] })
  await putJson(cas, 'base', base, 'method')
  const contract = await contractFixture(cas, { taskId: 'root', method: base, criteria: [taskCriterion('quality')] })
  const evidence = await evidenceFixture(cas, {
    contract: contract.contract, contractRef: contract.ref, runId: 'root:run', outcome: 'verified',
  })
  const badReceipt = sealPublicReceipt({
    v: 1, provider: ref('wrong-provider'), operationId: 'root:run:verify',
    contractDigest: contract.contract.digest, inputDigests: [], outputDigests: [],
    criteria: [{ id: 'quality', verdict: 'pass', reason: 'fixture' }],
    exit: { code: 0, signal: null }, timedOut: false,
  })
  const badReceiptRef = await putJson(cas, 'bad-receipt', badReceipt)
  const badEvidence = sealEvidence({
    v: 1 as const, task: contract.ref, runId: 'root:run', contractDigest: contract.contract.digest,
    method: contract.contract.method, inputs: [], outputs: [], composition: ref('composition:root:run'),
    verification: { provider: contract.contract.acceptance, operationId: 'root:run:verify', publicReceipt: badReceiptRef },
    usage: evidence.usage, sessionCut: { sessionId: 'root:run', from: 0, to: 1 },
    environment: { seed: contract.contract.environment.seed.digest, mode: 'workspace' },
  })
  const badEvidenceRef = await putJson(cas, 'bad-evidence', badEvidence, 'evidence')
  const trace = await traceFixture(cas, {
    rootTaskId: 'root', method: base, rootContract: contract.contract,
    children: [traceChild({ taskId: 'root', runId: 'root:run', outcome: 'verified', contract: contract.contract, evidenceRef: badEvidenceRef })],
  })
  const state = stateFixture([
    taskFixture({ taskId: 'root', contract: contract.contract, runIds: ['root:run'], outcome: 'verified' }),
  ], [runFixture({ taskId: 'root', runId: 'root:run', attempt: 1, evidenceRef: badEvidenceRef })])
  await assert.rejects(captureReplayPoints({
    store: cas, trace, state, base, hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000,
  }), ReplayContractError)
})

void test('closure is best-effort by default and requireClosed filters it without inventing proof', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({ v: 1, id: 'base', entryTemplateId: 'template', templates: [template('template')], skills: [], tools: [] })
  await putJson(cas, 'base', base, 'method')
  const contract = await contractFixture(cas, { taskId: 'root', method: base })
  const evidence = await evidenceFixture(cas, {
    contract: contract.contract, contractRef: contract.ref, runId: 'root:run', outcome: 'verified',
  })
  const trace = await traceFixture(cas, {
    rootTaskId: 'root', method: base, rootContract: contract.contract,
    children: [traceChild({ taskId: 'root', runId: 'root:run', outcome: 'verified', contract: contract.contract, evidenceRef: evidence.evidenceRef })],
  })
  const state = stateFixture([
    taskFixture({ taskId: 'root', contract: contract.contract, runIds: ['root:run'], outcome: 'verified' }),
  ], [runFixture({ taskId: 'root', runId: 'root:run', attempt: 1, evidenceRef: evidence.evidenceRef })])
  const ordinary = await captureReplayPoints({
    store: cas, trace, state, base, hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000,
  })
  assert.equal(ordinary[0]?.point.closure.level, 'best-effort')
  assert.deepEqual(await captureReplayPoints({
    store: cas, trace, state, base, hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000, requireClosed: true,
  }), [])
  const attested = await captureReplayPoints({
    store: cas, trace, state, base, hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000, closure: closedClosure,
  })
  assert.equal(attested[0]?.point.closure.level, 'closed')
})

void test('replayCaseFromContract re-freezes the deadline without changing the source case', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({ v: 1, id: 'base', entryTemplateId: 'template', templates: [template('template')], skills: [], tools: [] })
  const { contract } = await contractFixture(cas, {
    taskId: 'root', method: base, deadlineAt: 4_000_000,
    outputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
  })
  const local = replayCaseFromContract(contract, 9_000_000)
  assert.equal(local.v, 1)
  assert.equal(local.limits.deadlineAt, 9_000_000)
  assert.equal(local.spec.goal.summary, contract.spec.goal.summary)
  assert.deepEqual(local.spec.outputs.map(output => output.id), ['result'])
  assert.equal(local.environment.seed.digest, contract.environment.seed.digest)
})

void test('bootstrap baseline resolves explore while its candidate resolves the new entry with frozen case resources', async t => {
  const { cas } = await setup(t)
  const emptyBase = sealMethodRevision({ v: 1, id: 'base-empty', templates: [], skills: [], tools: [] })
  const emptyBaseRef = await putJson(cas, 'base-empty', emptyBase, 'method')
  const acceptance = ref('fallback-acceptance')
  const pubSkill = skill('pub-skill', 'public-skill')
  const pubTool = tool('pub-tool')
  const exploration = await explorationFixture(cas, { acceptance, skills: [pubSkill], tools: [pubTool] })
  const source = await contractFixture(cas, {
    taskId: 'root', method: emptyBase, templateId: 'platform:explore-child', exploration,
  })
  const evidence = await evidenceFixture(cas, {
    contract: source.contract, contractRef: source.ref, runId: 'root:run', outcome: 'verified',
  })
  const trace = await traceFixture(cas, {
    rootTaskId: 'root', method: emptyBase, rootContract: source.contract,
    children: [traceChild({ taskId: 'root', runId: 'root:run', outcome: 'verified', contract: source.contract, evidenceRef: evidence.evidenceRef })],
  })
  const state = stateFixture([
    taskFixture({ taskId: 'root', contract: source.contract, runIds: ['root:run'], outcome: 'verified' }),
  ], [runFixture({ taskId: 'root', runId: 'root:run', attempt: 1, evidenceRef: evidence.evidenceRef })])
  const [captured] = await captureReplayPoints({
    store: cas, trace, state, base: emptyBase, hostFingerprint: 'host-a', campaignDeadlineAt: 9_000_000,
  })
  assert.equal(captured.point.templateId, 'platform:explore-child')
  assert.equal(captured.point.bindingPath.length, 0)

  const candidate = sealMethodRevision({
    v: 1, id: 'candidate', parent: emptyBaseRef, entryTemplateId: 'implementation',
    templates: [template('implementation', { skills: ['own-skill'], tools: ['own-tool'] })],
    skills: [skill('own-skill')], tools: [tool('own-tool')],
  })
  const baseline = await contractForLocalSlot({
    store: cas, point: captured.point, base: emptyBase, arm: 'baseline', taskId: 'baseline-task', requestRef: ref('baseline-request'),
  })
  assert.equal(baseline.template.id, 'platform:explore-child')
  assert.deepEqual(baseline.resources.skills, [pubSkill.bundle])
  assert.deepEqual(baseline.resources.mcpServers, [pubTool.server.bundle])
  assert.deepEqual(baseline.spec.outputs.map(output => output.id), ['__skill-drafts', '__mcp-drafts'])
  assert.equal(baseline.limits.deadlineAt, 9_000_000)

  const candidateContract = await contractForLocalSlot({
    store: cas, point: captured.point, base: emptyBase, candidate, arm: 'candidate', taskId: 'candidate-task', requestRef: ref('candidate-request'),
  })
  assert.equal(candidateContract.template.id, 'implementation')
  assert.equal(candidateContract.method.digest, candidate.digest)
  assert.deepEqual(candidateContract.resources.skills, [skill('own-skill').bundle, pubSkill.bundle])
  assert.deepEqual(candidateContract.resources.mcpServers, [tool('own-tool').server.bundle, pubTool.server.bundle])
  assert.deepEqual(candidateContract.spec.outputs.map(output => output.id), ['__skill-drafts', '__mcp-drafts'])
})

void test('non-bootstrap root and child slots keep the source template and strip host learning outputs exactly once', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({
    v: 1, id: 'base', entryTemplateId: 'template',
    templates: [template('template', { skills: ['s1'] })], skills: [skill('s1')], tools: [],
  })
  const source = await contractFixture(cas, {
    taskId: 'root', method: base,
    outputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
  })
  const caseValue = replayCaseFromContract(source.contract, 9_000_000)
  const sourceCase = await putJson(cas, 'source-case', caseValue)
  const point = pointFixture({
    sourceCase, sourceContract: source.ref, sourceEvidence: ref('evidence'), baseMethod: { id: base.id, digest: base.digest },
    templateId: 'template', bindingPath: ['child-binding'], fanOut: { bindingReferences: 1, shared: false },
  })
  const contract = await contractForLocalSlot({
    store: cas, point, base, arm: 'baseline', taskId: 'child-task', requestRef: ref('request'),
  })
  assert.equal(contract.template.id, 'template')
  assert.deepEqual(contract.spec.outputs.map(output => output.id), ['result', '__skill-drafts', '__mcp-drafts'])
  assert.deepEqual(contract.resources.skills, [skill('s1').bundle])
  assert.equal(contract.limits.deadlineAt, 9_000_000)
  assert.ok(verifyTaskContract(contract))
  assert.equal(parseProtocolValue(taskContractSchema, contract).digest, contract.digest)
})

void test('fan-out counts base child binding references and marks shared templates', async () => {
  const base = sealMethodRevision({
    v: 1, id: 'base', entryTemplateId: 'shared',
    templates: [
      template('shared'),
      template('left', { children: [{ bindingId: 'a', templateId: 'shared', brief: 'a', join: 'required' }] }),
      template('right', {
        children: [
          { bindingId: 'b', templateId: 'shared', brief: 'b', join: 'required' },
          { bindingId: 'c', templateId: 'shared', brief: 'c', join: 'probe' },
        ],
      }),
    ],
    skills: [], tools: [],
  })
  assert.deepEqual(replayFanOut(base, 'shared'), { bindingReferences: 3, shared: true })
  assert.deepEqual(replayFanOut(base, 'left'), { bindingReferences: 0, shared: false })
  const state = stateFixture([
    taskFixture({ taskId: 'root', contract: (await Promise.resolve({} as TaskContract)), runIds: [], outcome: 'verified' }),
  ], [])
  assert.deepEqual(bindingPathFromTask(state, state.tasks.get('root') as TaskState), [])
})

void test('scoped candidate accepts only the selected template replacement and bound new assets', () => {
  const base = sealMethodRevision({
    v: 1, id: 'base', entryTemplateId: 'template',
    templates: [template('template', { skills: ['existing'], children: [{ bindingId: 'self', templateId: 'template', brief: 'self', join: 'probe' }] })],
    skills: [skill('existing')], tools: [],
  })
  const candidate = sealMethodRevision({
    v: 1, id: 'candidate', parent: { id: base.id, digest: base.digest }, entryTemplateId: 'template',
    templates: [template('template', { brief: 'changed', skills: ['existing', 'new-skill'], children: [{ bindingId: 'self', templateId: 'template', brief: 'self', join: 'probe' }] })],
    skills: [skill('existing'), skill('new-skill')], tools: [],
  })
  const point = pointFixture({
    sourceCase: ref('case'), sourceContract: ref('contract'), sourceEvidence: ref('evidence'),
    baseMethod: { id: base.id, digest: base.digest }, templateId: 'template',
    fanOut: { bindingReferences: 1, shared: true },
  })
  const result = assertScopedCandidate({
    point, base, candidate,
    patch: {
      changes: [
        { op: 'put-template', template: { id: 'template', brief: 'changed', guidance: 'g', example: { goal: { summary: 's', deliverable: 'd', scope: [], constraints: [] }, acceptanceCriteria: [{ id: 'a', statement: 's', check: 'true' }], inputs: [] }, skills: ['existing', 'new-skill'], tools: [], children: [{ bindingId: 'self', templateId: 'template', brief: 'self', join: 'probe' }] } },
        { op: 'put-skill', skill: { id: 'new-skill', name: 'new-skill', description: 'd', files: { 'SKILL.md': '# new' } } },
      ],
    },
  })
  assert.equal(result.kind, 'existing-template')
  assert.deepEqual(result.fanOut, { bindingReferences: 1, shared: true })
})

void test('scoped candidate expands exactly one new child template and one binding', () => {
  const draft = (id: string, children: readonly { readonly bindingId: string; readonly templateId: string; readonly brief: string; readonly join: 'required' | 'probe' }[] = []) => ({
    id, brief: `${id} brief`, guidance: 'g',
    example: { goal: { summary: 's', deliverable: 'd', scope: [], constraints: [] },
      acceptanceCriteria: [{ id: 'a', statement: 's', check: 'true' }], inputs: [] },
    skills: [], tools: [], children: [...children],
  })
  const binding = { bindingId: 'delegate', templateId: 'child', brief: 'delegate', join: 'probe' as const }
  const base = sealMethodRevision({ v: 1, id: 'base', entryTemplateId: 'parent',
    templates: [template('parent'), template('other')], skills: [], tools: [] })
  const candidate = sealMethodRevision({ v: 1, id: 'candidate', parent: { id: base.id, digest: base.digest },
    entryTemplateId: 'parent', templates: [template('parent', { children: [binding] }), template('child'), template('other')],
    skills: [], tools: [] })
  const point = pointFixture({ sourceCase: ref('case'), sourceContract: ref('contract'), sourceEvidence: ref('evidence'),
    baseMethod: { id: base.id, digest: base.digest }, templateId: 'parent', fanOut: { bindingReferences: 0, shared: false } })
  const result = assertScopedCandidate({ point, base, candidate, patch: { changes: [
    { op: 'put-template', template: draft('parent', [binding]) },
    { op: 'put-template', template: draft('child') },
  ] } })
  assert.equal(result.kind, 'expand-template')
  assert.deepEqual(result.affectedTemplateIds, ['parent', 'child'])
  assert.deepEqual(result.fanOut, { bindingReferences: 0, shared: false })

  const wrongBinding = sealMethodRevision({ v: 1, id: 'wrong-binding', parent: { id: base.id, digest: base.digest },
    entryTemplateId: 'parent', templates: [template('parent', { children: [{ ...binding, templateId: 'ghost' }] }), template('child'), template('other')],
    skills: [], tools: [] })
  assert.throws(() => assertScopedCandidate({ point, base, candidate: wrongBinding, patch: { changes: [
    { op: 'put-template', template: draft('parent', [{ ...binding, templateId: 'ghost' }]) },
    { op: 'put-template', template: draft('child') },
  ] } }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'EXPAND_CHILDREN')

  const twoNew = sealMethodRevision({ v: 1, id: 'two-new', parent: { id: base.id, digest: base.digest },
    entryTemplateId: 'parent', templates: [template('parent', { children: [binding] }), template('child'), template('child2'), template('other')],
    skills: [], tools: [] })
  assert.throws(() => assertScopedCandidate({ point, base, candidate: twoNew, patch: { changes: [
    { op: 'put-template', template: draft('parent', [binding]) },
    { op: 'put-template', template: draft('child') },
    { op: 'put-template', template: draft('child2') },
  ] } }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'SINGLE_TEMPLATE')
})

void test('scoped candidate rejects removals, entry changes, overwrites, unbound assets, edit budget and fan-out loss', () => {
  const base = sealMethodRevision({
    v: 1, id: 'base', entryTemplateId: 'template',
    templates: [template('template', { skills: ['existing'], children: [{ bindingId: 'self', templateId: 'template', brief: 'self', join: 'probe' }] })],
    skills: [skill('existing')], tools: [],
  })
  const point = pointFixture({
    sourceCase: ref('case'), sourceContract: ref('contract'), sourceEvidence: ref('evidence'),
    baseMethod: { id: base.id, digest: base.digest }, templateId: 'template',
    fanOut: { bindingReferences: 1, shared: true },
  })
  const candidate = sealMethodRevision({
    v: 1, id: 'candidate', parent: { id: base.id, digest: base.digest }, entryTemplateId: 'template',
    templates: [template('template', { brief: 'changed', skills: ['existing'], children: [{ bindingId: 'self', templateId: 'template', brief: 'self', join: 'probe' }] })],
    skills: [skill('existing'), skill('unbound')], tools: [],
  })
  const putTemplate = {
    op: 'put-template' as const,
    template: { id: 'template', brief: 'changed', guidance: 'g', example: { goal: { summary: 's', deliverable: 'd', scope: [], constraints: [] }, acceptanceCriteria: [{ id: 'a', statement: 's', check: 'true' }], inputs: [] }, skills: ['existing', 'unbound'], tools: [], children: [{ bindingId: 'self', templateId: 'template', brief: 'self', join: 'probe' as const }] },
  }
  assert.throws(() => assertScopedCandidate({
    point, base, candidate,
    patch: { changes: [{ op: 'remove-template', id: 'template' }] },
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'REMOVE_FORBIDDEN')
  assert.throws(() => assertScopedCandidate({
    point, base, candidate,
    patch: { changes: [putTemplate] },
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'ASSET_UNBOUND')
  assert.throws(() => assertScopedCandidate({
    point, base, candidate,
    patch: { changes: [putTemplate, { op: 'set-entry', templateId: 'template' }] },
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'SET_ENTRY_FORBIDDEN')
  assert.throws(() => assertScopedCandidate({
    point, base, candidate,
    patch: { changes: [putTemplate, { op: 'put-skill', skill: { id: 'existing', name: 'existing', description: 'd', files: { 'SKILL.md': '# x' } } }] },
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'ASSET_OVERWRITE')
  assert.throws(() => assertScopedCandidate({
    point, base, candidate,
    patch: { changes: [putTemplate, { op: 'put-skill', skill: { id: 'unbound', name: 'unbound', description: 'd', files: { 'SKILL.md': '# x' } } }] },
    editBudget: 1,
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'EDIT_BUDGET')

  const shrunk = sealMethodRevision({
    v: 1, id: 'shrunk', parent: { id: base.id, digest: base.digest }, entryTemplateId: 'template',
    templates: [template('template', { brief: 'changed', skills: ['existing'], children: [] })],
    skills: [skill('existing')], tools: [],
  })
  assert.throws(() => assertScopedCandidate({
    point, base, candidate: shrunk,
    patch: { changes: [putTemplate] },
  }), (error: unknown) => error instanceof ReplayScopeError && (error.code === 'FANOUT_CHANGED' || error.code === 'ASSET_UNBOUND'))
})

void test('bootstrap scope requires a root explore point, empty entry, one new template and one matching set-entry', () => {
  const base = sealMethodRevision({ v: 1, id: 'base-empty', templates: [], skills: [], tools: [] })
  const candidate = sealMethodRevision({
    v: 1, id: 'candidate', parent: { id: base.id, digest: base.digest }, entryTemplateId: 'new-template',
    templates: [template('new-template', { skills: ['new-skill'] })], skills: [skill('new-skill')], tools: [],
  })
  const point = pointFixture({
    sourceCase: ref('case'), sourceContract: ref('contract'), sourceEvidence: ref('evidence'),
    baseMethod: { id: base.id, digest: base.digest }, templateId: 'platform:explore-child', bindingPath: [],
  })
  const patch = {
    changes: [
      { op: 'put-template' as const, template: { id: 'new-template', brief: 'new', guidance: 'g', example: { goal: { summary: 's', deliverable: 'd', scope: [], constraints: [] }, acceptanceCriteria: [{ id: 'a', statement: 's', check: 'true' }], inputs: [] }, skills: ['new-skill'], tools: [], children: [] } },
      { op: 'put-skill' as const, skill: { id: 'new-skill', name: 'new-skill', description: 'd', files: { 'SKILL.md': '# new' } } },
      { op: 'set-entry' as const, templateId: 'new-template' },
    ],
  }
  assert.equal(assertScopedCandidate({ point, base, candidate, patch }).kind, 'bootstrap-entry')
  assert.throws(() => assertScopedCandidate({
    point: { ...point, bindingPath: ['child'] }, base, candidate, patch,
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'BOOTSTRAP_PATH')
  assert.throws(() => assertScopedCandidate({
    point: { ...point, templateId: 'template' }, base, candidate, patch,
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'BOOTSTRAP_TEMPLATE')
  const danglingBase = sealMethodRevision({
    v: 1, id: 'dangling-base', templates: [], skills: [], tools: [], entryTemplateId: 'dangling',
  })
  const danglingCandidate = sealMethodRevision({
    v: 1, id: 'dangling-candidate', parent: { id: danglingBase.id, digest: danglingBase.digest },
    entryTemplateId: 'new-template', templates: [template('new-template', { skills: ['new-skill'] })],
    skills: [skill('new-skill')], tools: [],
  })
  assert.throws(() => assertScopedCandidate({
    point: { ...point, baseMethod: { id: danglingBase.id, digest: danglingBase.digest } },
    base: danglingBase, candidate: danglingCandidate, patch,
  }), (error: unknown) => error instanceof ReplayScopeError && error.code === 'BOOTSTRAP_ENTRY')
})

void test('baseline fidelity compares source verdict, unique metric tolerance and host fingerprint', async t => {
  const { cas } = await setup(t)
  const base = sealMethodRevision({ v: 1, id: 'base', entryTemplateId: 'template', templates: [template('template')], skills: [], tools: [] })
  const contract = await contractFixture(cas, { taskId: 'root', method: base, criteria: [taskCriterion('quality', true)] })
  const source = await evidenceFixture(cas, {
    contract: contract.contract, contractRef: contract.ref, runId: 'root:run', outcome: 'verified', metric: 10,
  })
  const sourceCase = await putJson(cas, 'source-case', replayCaseFromContract(contract.contract, 9_000_000))
  const point = pointFixture({
    sourceCase, sourceContract: contract.ref, sourceEvidence: source.evidenceRef,
    baseMethod: { id: base.id, digest: base.digest }, outcome: 'verified',
    localMetric: { criterion: 'quality', name: 'score', unit: 'points' },
    replayTolerance: { relative: 0.1 },
    hostFingerprint: 'host-a',
  })
  const baseline = (value: number, verdict: 'verified' | 'failed' = 'verified'): PublicReceipt => sealPublicReceipt({
    v: 1, provider: contract.contract.acceptance, operationId: 'baseline:run:verify',
    contractDigest: contract.contract.digest, inputDigests: [], outputDigests: [],
    criteria: [{ id: 'quality', verdict: verdict === 'verified' ? 'pass' : 'fail', reason: 'baseline', metric: { name: 'score', unit: 'points', value } }],
    exit: { code: 0, signal: null }, timedOut: false,
  })
  assert.deepEqual(await assertBaselineFidelity({
    store: cas, point, hostFingerprint: 'host-a',
    observation: { caseRef: sourceCase, verdict: 'verified', receipt: baseline(10.5) },
  }), { fidelity: 'exact', sourceVerdict: 'verified', baselineVerdict: 'verified' })
  await assert.rejects(assertBaselineFidelity({
    store: cas, point, hostFingerprint: 'host-a',
    observation: { caseRef: sourceCase, verdict: 'verified', receipt: baseline(12) },
  }), (error: unknown) => error instanceof BaselineDriftError && error.reason === 'baseline-metric')
  await assert.rejects(assertBaselineFidelity({
    store: cas, point, hostFingerprint: 'host-a',
    observation: { caseRef: sourceCase, verdict: 'failed', receipt: baseline(10) },
  }), (error: unknown) => error instanceof BaselineDriftError && error.reason === 'baseline-verdict')
  assert.deepEqual(await assertBaselineFidelity({
    store: cas, point: { ...point, baselinePolicy: 'fresh-paired' }, hostFingerprint: 'host-a',
    observation: { caseRef: sourceCase, verdict: 'failed', receipt: baseline(10) },
  }), { fidelity: 'verdict-drift', sourceVerdict: 'verified', baselineVerdict: 'failed' })
  await assert.rejects(assertBaselineFidelity({
    store: cas, point, hostFingerprint: 'host-b',
    observation: { caseRef: sourceCase, verdict: 'verified', receipt: baseline(10) },
  }), (error: unknown) => error instanceof BaselineDriftError && error.reason === 'host-fingerprint')
  await assert.rejects(assertBaselineFidelity({
    store: cas, point, hostFingerprint: 'host-a',
    observation: { caseRef: ref('other-case'), verdict: 'verified', receipt: baseline(10) },
  }), (error: unknown) => error instanceof BaselineDriftError && error.reason === 'source-case')

  const missingPoint = {
    ...point,
    sourceContract: ref('missing-contract'),
  }
  await assert.rejects(assertBaselineFidelity({
    store: cas, point: missingPoint, hostFingerprint: 'host-a',
    observation: { caseRef: sourceCase, verdict: 'verified', receipt: baseline(10) },
  }), (error: unknown) => !(error instanceof BaselineDriftError))
})
