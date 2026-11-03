import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Session,SessionEvent } from '@deepseek-ai/dsh-session'

import type {
CompositionPayload,
Digest,
Fact,
JsonObject,
MethodRevision,
Ref,
TaskContract,
TaskProposal,
TaskTemplate,
} from '@singularity/protocol'
import {
admitRootTask,
canonicalize,
computeDigest,
seal,
sealMethodRevision,
} from '@singularity/protocol'

import type { CommitDecomposeInput } from '../src/decompose-commit.ts'
import { commitDecomposeBatch } from '../src/decompose-commit.ts'
import type { PrepareDecomposeOutput } from '../src/decompose.ts'
import { prepareDecompose } from '../src/decompose.ts'
import { initialContextEpoch } from '../src/epoch.ts'
import { DecomposeError } from '../src/errors.ts'
import type { FrozenMethodResources } from '../src/resources.ts'
import { CommandService } from '../src/service.ts'

const textEncoder = new TextEncoder()
const digestA: Digest = `sha256:${'a'.repeat(64)}`
const digestD: Digest = `sha256:${'d'.repeat(64)}`
const actor = { kind: 'runtime' as const, id: 's4b2-commit-test' }
const sessionId = 'session-s4b2'
const parentRunId = 'run-s4b2'
const FIXED_NOW = 1_800_000_000_000

interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: 'append' | 'replace'
  readonly sourceEventSeqs?: readonly number[]
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value as never))
}

function fakeSession(events: readonly FakeEvent[], nodes: readonly number[], firstLiveSeq = 0): Session {
  return {
    id: sessionId,
    get seq() { return events.length },
      snapshotEvents: () => events as unknown as readonly SessionEvent[],
    firstLiveSeq,
    surface: { nodes, replaceGeneration: 0 },
  } as unknown as Session
}

function prepareCall(seq: number, turn: number, step: number, callId: string, bindingId: string): FakeEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1,
    data: {
      turn,
      step,
      callId,
      name: 'singularity_decompose',
      arguments: JSON.stringify({ action: 'prepare', bindingId }),
    },
  }
}

function prepareResult(
  seq: number,
  turn: number,
  step: number,
  callId: string,
  output: unknown,
  options: { readonly isError?: boolean; readonly surfaceOp?: 'append' | 'replace' } = {},
): FakeEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1,
    data: {
      turn,
      step,
      message: {
        role: 'tool',
        id: `result-${String(seq)}`,
        toolCallId: callId,
        isError: options.isError,
        content: [{ type: 'text', text: JSON.stringify(output) }],
      },
    },
    surfaceOp: options.surfaceOp ?? 'append',
    sourceEventSeqs: [seq - 1],
  }
}

function commitCall(seq: number, turn: number, step: number, callId: string, args: unknown): FakeEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1,
    data: {
      turn,
      step,
      callId,
      name: 'singularity_decompose',
      arguments: JSON.stringify(args),
    },
  }
}



interface Scenario {
  readonly service: CommandService
  readonly contract: TaskContract
  readonly method: MethodRevision
  readonly resources: FrozenMethodResources
  readonly parentInput: Ref
  readonly skillBundle: Ref
  readonly baseTool: Ref
}

interface ScenarioOptions {
  readonly taskId?: string
  readonly instanceSchema?: JsonObject
  readonly maxTokens?: number
  readonly maxStepsPerRun?: number
  readonly maxDepth?: number
  readonly maxTasks?: number
  readonly maxBatchChildren?: number
}

async function putValue(
  service: CommandService,
  value: unknown,
  id: string,
  domain: 'object' | 'contract' | 'method' | 'composition' = 'object',
): Promise<Ref> {
  return service.putObject(id, jsonBytes(value), domain)
}

async function putTreeBundle(
  service: CommandService,
  id: string,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<Ref> {
  const entries = []
  for (const file of files) {
    const bytes = textEncoder.encode(file.content)
    const object = await service.putObject(`${id}:file:${file.path}`, bytes, 'object')
    entries.push({ path: file.path, bytes: bytes.byteLength, object })
  }
  const manifest = seal('object', { v: 1, kind: 'tree', files: entries })
  return putValue(service, manifest, id)
}

async function makeScenario(root: string, options: ScenarioOptions = {}): Promise<Scenario> {
  const service = await CommandService.open({ root, actor, clock: () => FIXED_NOW })
  try {
    const taskId = options.taskId ?? 'task-s4b2'
    const guidance = await putValue(service, { v: 1, text: 'Follow the frozen guidance.' }, 'guidance')
    const example = await putValue(service, {
      goal: {
        summary: 'Inspect the supplied sample and produce one result.',
        deliverable: 'One result and a local note.',
        scope: ['single child sample'],
        constraints: ['Use only authorized inputs.'],
      },
      acceptanceCriteria: [{ check: 'test -s notes.txt', id: 'local', statement: 'Record the observed sample.' }],
      inputs: [{ id: 'sample', exampleText: 'sample input' }],
      localOutputs: [{ id: 'notes', path: 'notes.txt', kind: 'file', description: 'Local note.' }],
    }, 'child-example')
    const acceptancePolicy = await putValue(service, { v: 1, kind: 'fixture-policy' }, 'acceptance-policy')
    const skillBundle = await putTreeBundle(service, 'skill-bundle', [
      { path: 'SKILL.md', content: '# S4-B2 fixture skill\n\nUse the authorized sample.\n' },
    ])
    const baseTool = await putValue(service, { v: 1, name: 'bash' }, 'base-tool')

    const childTemplate: TaskTemplate = {
      id: 'template:child',
      brief: 'Inspect the sample.',
      guidance,
      example,
      instanceSchema: options.instanceSchema ?? {
        type: 'object',
        required: ['goal', 'acceptanceCriteria', 'inputs', 'localOutputs'],
        additionalProperties: false,
        properties: {
          goal: { type: 'object', required: ['summary', 'deliverable', 'scope', 'constraints'] },
          acceptanceCriteria: { type: 'array' },
          inputs: { type: 'array' },
          localOutputs: { type: 'array' },
        },
      },
      requiredCriteria: [{ id: 'template-criterion', statement: 'Use the authorized input.', required: true }],
      requiredOutputs: [],
      acceptancePolicy,
      skills: ['skill:fixture'],
      tools: [],
      children: [],
    }
    const rootTemplate: TaskTemplate = {
      ...childTemplate,
      id: 'template:root',
      brief: 'Run the root task.',
      requiredCriteria: [],
      requiredOutputs: [],
      skills: [],
      tools: [],
      children: [
        { bindingId: 'b1', templateId: childTemplate.id, brief: 'Inspect the sample.', join: 'probe' },
        { bindingId: 'b2', templateId: childTemplate.id, brief: 'Inspect the sample again.', join: 'required' },
      ],
    }
    const method = sealMethodRevision({
      v: 1,
      id: 'method:s4b2',
      entryTemplateId: rootTemplate.id,
      templates: [rootTemplate, childTemplate],
      skills: [{ id: 'skill:fixture', name: 'fixture-skill', description: 'Fixture skill.', bundle: skillBundle }],
      tools: [],
    })
    await putValue(service, method, method.id, 'method')
    const methodRef = { id: method.id, digest: method.digest }

    const parentInput = await service.putObject(
      'input:source',
      textEncoder.encode('fixture input bytes\n'),
      'object',
    )
    const seed = await putValue(service, { v: 1, seed: 's4b2-seed' }, 'seed')
    const profile = await putValue(service, { v: 1, profile: 's4b2-profile' }, 'profile')
    const request = await putValue(service, { v: 1, request: 's4b2' }, 'request')
    const acceptance = acceptancePolicy
    const contract = admitRootTask({
      taskId,
      spec: {
        goal: {
          summary: 'Coordinate the child batch.',
          deliverable: 'One root result.',
          scope: ['s4b2'],
          constraints: [],
        },
        criteria: [],
        inputs: [{ id: 'source', object: parentInput, path: 'input.txt', access: 'read' }],
        outputs: [{ id: 'out', path: 'out.txt', kind: 'file', role: 'deliverable', required: true }],
      },
      origin: { kind: 'root', purpose: 'work', requestRef: request },
      method: methodRef,
      template: { id: rootTemplate.id, digest: method.digest },
      resources: { baseTools: [baseTool], skills: [skillBundle], mcpServers: [] },
      acceptance,
      environment: { seed, profile },
      limits: {
        maxRuns: 2,
        maxStepsPerRun: options.maxStepsPerRun ?? 20,
        maxTokens: options.maxTokens ?? 100_000,
        deadlineAt: FIXED_NOW + 3_600_000,
        maxDepth: options.maxDepth ?? 2,
        maxTasks: options.maxTasks ?? 4,
        maxBatchChildren: options.maxBatchChildren ?? 2,
      },
    })
    await putValue(service, contract, contract.taskId, 'contract')

    const compositionTemplate = await putValue(service, rootTemplate, 'composition-template')
    const dshConfig = await putValue(service, { v: 1, config: 'fixture' }, 'dsh-config')
    const modelRoute = await putValue(service, { v: 1, route: 'fixture' }, 'model-route')
    const compositionResources = await putValue(service, { v: 1, resources: [] }, 'resources')
    const composition: CompositionPayload = {
      v: 1,
      dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-alpha.2', config: dshConfig },
      platformPrompt: computeDigest('object', { v: 1, text: 's4b2-platform-prompt' }),
      contract: { id: contract.taskId, digest: contract.digest },
      template: compositionTemplate,
      guidance,
      skills: [skillBundle],
      mcpServers: [],
      modelRoute,
      resources: compositionResources,
      seed,
    }
    const compositionRef = await putValue(
      service,
      seal('composition', composition as unknown as JsonObject),
      `${parentRunId}:composition`,
      'composition',
    )
    await service.commit({
      command: {
        v: 1,
        commandId: `task:${taskId}:admitted`,
        tool: 's4b2-test',
        toolVersion: 1,
        actor,
        scope: {},
        input: {},
      },
      type: 'task/admitted',
      data: { taskId, contract: { id: contract.taskId, digest: contract.digest } },
    })
    await service.commit({
      command: {
        v: 1,
        commandId: `run:${parentRunId}:opened`,
        tool: 's4b2-test',
        toolVersion: 1,
        actor,
        scope: {},
        input: {},
      },
      type: 'run/opened',
      data: {
        taskId,
        runId: parentRunId,
        attempt: 1,
        sessionId,
        composition: compositionRef,
        workspaceKey: parentRunId,
        workspaceSeed: seed,
        budgetReservation: {
          tokens: contract.limits.maxTokens,
          steps: contract.limits.maxStepsPerRun,
          deadlineAt: contract.limits.deadlineAt,
        },
      },
    })
    const resources: FrozenMethodResources = {
      method,
      template: rootTemplate,
      guidance,
      guidanceText: 'Follow the frozen guidance.',
      skills: [],
      mcpServers: [],
    }
    return { service, contract, method, resources, parentInput, skillBundle, baseTool }
  } catch (error) {
    await service.close()
    throw error
  }
}

async function withScenario<T>(
  options: ScenarioOptions,
  run: (scenario: Scenario, root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 's4b2-commit-'))
  const scenario = await makeScenario(root, options)
  try {
    return await run(scenario, root)
  } finally {
    await scenario.service.close()
    await rm(root, { recursive: true, force: true })
  }
}

function proposal(scenario: Scenario, overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    goal: {
      summary: 'Inspect the authorized sample and report one result.',
      deliverable: 'One result.',
      scope: ['child sample'],
      constraints: ['Use only the authorized input.'],
    },
    acceptanceCriteria: [{ check: 'test -s notes.txt', id: 'local-1', statement: 'The note records the sample.' }],
    inputs: [{
      id: 'source',
      object: scenario.parentInput,
      path: 'input.txt',
      access: 'read',
    }],
    localOutputs: [{ id: 'notes', path: 'notes.txt', kind: 'file', description: 'Local note.' }],
    ...overrides,
  }
}

async function prepareBoth(scenario: Scenario): Promise<{
  readonly prepared: PrepareDecomposeOutput
  readonly preparedSecond: PrepareDecomposeOutput
}> {
  const epoch = initialContextEpoch(sessionId)
  const base = {
    contract: scenario.contract,
    runId: parentRunId,
    sessionId,
    resources: scenario.resources,
    reader: scenario.service,
    writer: scenario.service,
    epoch,
    planningSketchRef: { id: `${parentRunId}:planning-sketch`, digest: digestA },
    remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
    asOf: FIXED_NOW,
  }
  const prepared = await prepareDecompose({
    ...base,
    session: fakeSession([prepareCall(0, 1, 1, 'prepare-1', 'b1')], []),
    callId: 'prepare-1',
  }, 'b1')
  const preparedSecond = await prepareDecompose({
    ...base,
    session: fakeSession([prepareCall(0, 2, 1, 'prepare-2', 'b2')], []),
    callId: 'prepare-2',
  }, 'b2')
  return { prepared, preparedSecond }
}

function commitInput(
  scenario: Scenario,
  session: Session,
  args: { action: 'commit'; children: unknown[] },
  options: {
    readonly callId?: string
    readonly liveTokens?: number
    readonly planningSketchRef?: Ref
  } = {},
): CommitDecomposeInput {
  return {
    contract: scenario.contract,
    parentRunId,
    sessionId,
    resources: scenario.resources,
    service: scenario.service,
    session,
    callId: options.callId ?? 'commit-1',
    planningSketchRef: options.planningSketchRef ?? { id: `${parentRunId}:planning-sketch`, digest: digestA },
    actor,
    transientInvalidReasons: [],
    liveTokens: options.liveTokens ?? 10_000,
    args: args as CommitDecomposeInput['args'],
  }
}

function errorCode(code: string) {
  return (error: unknown): true => {
    assert.ok(error instanceof DecomposeError, `expected DecomposeError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  }
}

function childBatchFacts(facts: readonly Fact[]): Fact[] {
  return facts.filter(fact => fact.type === 'task/children-admitted')
}

void test('S4-B2 commit admits one host-derived child and appends exactly one fact without dispatch', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    // Use one prepared child and a proposal whose object ref matches the parent input.
    const task = proposal(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    const before = scenario.service.facts().length
    const result = await commitDecomposeBatch(commitInput(scenario, session, args))

    assert.equal(result.status, 'admitted')
    assert.equal(result.parentRunId, parentRunId)
    assert.equal(result.batchId, `batch:${sessionId}:commit-1`)
    assert.equal(result.children.length, 1)
    assert.deepEqual(result.children[0], {
      taskId: `child:${computeDigest('object', { parentTaskId: 'task-s4b2', batchId: `batch:${sessionId}:commit-1`, bindingId: 'b1', index: 0 }).slice(7)}`,
      bindingId: 'b1',
      join: 'probe',
    })
    assert.equal(result.deliveryReceiptRefs.length, 1)
    assert.equal(result.deliveryReceiptRefs[0]?.id, prepared.deliveryReceiptRef.id)
    assert.equal(result.deliveryReceiptRefs[0]?.digest, prepared.deliveryReceiptRef.digest)
    assert.equal(result.fact.type, 'task/children-admitted')
    assert.equal(scenario.service.facts().length, before + 1)
    const facts = childBatchFacts(scenario.service.facts())
    assert.equal(facts.length, 1)
    const admitted = facts[0]
    assert.ok(admitted)
    if (admitted.type !== 'task/children-admitted') assert.fail('expected a children-admitted fact')
    assert.equal(admitted.data.parentRunId, parentRunId)
    assert.equal(admitted.data.batchId, result.batchId)
    assert.equal(admitted.data.children.length, 1)
    const child = admitted.data.children[0]
    assert.ok(child)
    assert.equal(child.join, 'probe')
    assert.equal(child.budgetReservation.tokens, 90_000)
    assert.equal(child.budgetReservation.steps, 20)
    assert.equal(child.budgetReservation.deadlineAt, scenario.contract.limits.deadlineAt)
    assert.deepEqual(child.contract.origin, {
      kind: 'child',
      parentId: scenario.contract.taskId,
      parentRunId,
      batchId: result.batchId,
      bindingId: 'b1',
    })
    assert.deepEqual(child.contract.spec.criteria.slice(-task.acceptanceCriteria.length), task.acceptanceCriteria.map(criterion => ({ ...criterion, required: true })))
    assert.deepEqual(child.contract.spec.criteria.map(item => item.id), ['template-criterion', 'local-1'])
    assert.deepEqual(child.contract.spec.inputs, task.inputs)
    assert.deepEqual(child.contract.resources.baseTools, scenario.contract.resources.baseTools)
    assert.deepEqual(child.contract.resources.skills, [scenario.skillBundle])
    assert.deepEqual(child.contract.environment, scenario.contract.environment)
    assert.deepEqual(child.contract.limits, {
      maxRuns: scenario.contract.limits.maxRuns,
      maxStepsPerRun: 20,
      maxTokens: 90_000,
      deadlineAt: scenario.contract.limits.deadlineAt,
      maxDepth: 1,
      maxTasks: 3,
      maxBatchChildren: 2,
    })
    assert.deepEqual(child.contract.spec.outputs.map(output => ({
      id: output.id,
      role: output.role,
      required: output.required,
    })), [
      { id: 'notes', role: 'supporting', required: false },
      { id: '__skill-drafts', role: 'skill-draft', required: false },
      { id: '__mcp-drafts', role: 'mcp-draft', required: false },
    ])

    const state = await scenario.service.taskRunState([])
    assert.equal(state.runs.size, 1, 'commit must not open a child Run')
    assert.equal(state.runs.get(parentRunId)?.phase, 'open')
    const childState = state.tasks.get(child.contract.taskId)
    assert.ok(childState)
    assert.equal(childState.phase, 'open')
    assert.equal(childState.activeRunId, undefined)
    assert.equal(childState.runIds.length, 0)
    assert.equal(state.batches.size, 1)
  })
})

void test('S4-B2 idempotent replay returns the original batch and receipts without appending', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    const first = await commitDecomposeBatch(commitInput(scenario, session, args))
    const factsAfterFirst = scenario.service.facts().length
    const second = await commitDecomposeBatch(commitInput(scenario, session, args))
    assert.equal(scenario.service.facts().length, factsAfterFirst)
    assert.equal(second.fact.digest, first.fact.digest)
    assert.equal(second.batchId, first.batchId)
    assert.equal(
      canonicalize(second.children as unknown as never),
      canonicalize(first.children as unknown as never),
    )
    assert.equal(
      canonicalize(second.deliveryReceiptRefs as unknown as never),
      canonicalize(first.deliveryReceiptRefs as unknown as never),
    )

    const conflicting = {
      action: 'commit' as const,
      children: [{
        bindingId: 'b1',
        ackPreview: prepared.previewRef.digest,
        task: proposal(scenario, { goal: { ...proposal(scenario).goal, summary: 'different payload' } }),
      }],
    }
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, conflicting)),
      errorCode('IDEMPOTENCY_CONFLICT'),
    )
    assert.equal(scenario.service.facts().length, factsAfterFirst)
    assert.equal(childBatchFacts(scenario.service.facts()).length, 1)
  })
})

void test('S4-B2 commit rejects missing, same-step, stale, wrong-binding, and tampered previews', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const task = proposal(scenario)
    const ack = prepared.previewRef.digest
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: ack, task }],
    }

    const noPrepare = fakeSession([commitCall(0, 1, 2, 'commit-1', args)], [])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, noPrepare, args)),
      errorCode('PREVIEW_REQUIRED'),
    )

    const sameStep = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 1, 'commit-1', args),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, sameStep, args)),
      errorCode('NEXT_STEP_REQUIRED'),
    )

    const staleSurface = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, staleSurface, args)),
      errorCode('PREVIEW_STALE'),
    )

    const epochChange = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1], 2)
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, epochChange, args)),
      errorCode('PREVIEW_STALE'),
    )

    const wrongBinding = {
      action: 'commit' as const,
      children: [{ bindingId: 'b2', ackPreview: ack, task }],
    }
    const wrongBindingSession = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', wrongBinding),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, wrongBindingSession, wrongBinding)),
      errorCode('PREVIEW_REQUIRED'),
    )

    const tampered = {
      ...prepared.response,
      example: {
        ...prepared.response.example,
        goal: { ...prepared.response.example.goal, summary: 'tampered example' },
      },
    }
    const tamperedSession = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', tampered),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, tamperedSession, args)),
      errorCode('PREVIEW_STALE'),
    )

    const wrongAck = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: digestD, task }],
    }
    const wrongAckSession = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', wrongAck),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, wrongAckSession, wrongAck)),
      errorCode('PREVIEW_REQUIRED'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })
})

void test('S4-B2 commit derives per-child budget, join, and rejects exhausted or oversized budgets', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared, preparedSecond } = await prepareBoth(scenario)
    const firstTask = proposal(scenario)
    const secondTask = proposal(scenario, {
      acceptanceCriteria: [{ check: 'test -s notes.txt', id: 'local-second', statement: 'Second child note.' }],
    })
    const args = {
      action: 'commit' as const,
      children: [
        { bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: firstTask },
        { bindingId: 'b2', ackPreview: preparedSecond.previewRef.digest, task: secondTask },
      ],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      prepareCall(2, 2, 1, 'prepare-2', 'b2'),
      prepareResult(3, 2, 1, 'prepare-2', preparedSecond.response),
      commitCall(4, 2, 2, 'commit-1', args),
    ], [1, 3])

    const exhaustedSession = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      prepareCall(2, 2, 1, 'prepare-2', 'b2'),
      prepareResult(3, 2, 1, 'prepare-2', preparedSecond.response),
      commitCall(4, 2, 2, 'commit-2', args),
    ], [1, 3])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, exhaustedSession, args, {
        callId: 'commit-2',
        liveTokens: scenario.contract.limits.maxTokens - 1,
      })),
      errorCode('LIMIT_EXCEEDED'),
    )
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, args, {
        liveTokens: scenario.contract.limits.maxTokens + 1,
      })),
      errorCode('LIMIT_EXCEEDED'),
    )
    assert.equal(scenario.service.facts().length, 2)

    const result = await commitDecomposeBatch(commitInput(scenario, session, args, {
      liveTokens: scenario.contract.limits.maxTokens - 20_001,
    }))
    assert.deepEqual(result.children.map(child => child.join), ['probe', 'required'])
    const fact = result.fact
    assert.ok(fact.type === 'task/children-admitted')
    const reservations = fact.data.children.map(child => child.budgetReservation)
    assert.deepEqual(reservations.map(reservation => reservation.tokens), [10_001, 10_000])
    assert.deepEqual(reservations.map(reservation => reservation.steps), [10, 10])
    assert.deepEqual(fact.data.children.map(child => child.contract.limits.maxDepth), [1, 1])
    assert.deepEqual(fact.data.children.map(child => child.contract.limits.maxTasks), [3, 3])
  })
})

void test('S4-B2 commit rejects an active batch, unauthorized inputs, and invalid instance schemas', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const task = proposal(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    await commitDecomposeBatch(commitInput(scenario, session, args))
    const factCount = scenario.service.facts().length

    const secondArgs = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario, {
        acceptanceCriteria: [{ check: 'test -s notes.txt', id: 'second', statement: 'A second batch cannot start.' }],
      }) }],
    }
    const secondSession = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 2, 2, 'commit-2', secondArgs),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, secondSession, secondArgs, { callId: 'commit-2' })),
      errorCode('CHILD_BATCH_ACTIVE'),
    )
    assert.equal(scenario.service.facts().length, factCount)
  })

  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const badInput = {
      ...proposal(scenario),
      inputs: [{
        id: 'source',
        object: scenario.parentInput,
        path: 'other.txt',
        access: 'read' as const,
      }],
    }
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: badInput }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, args)),
      errorCode('INPUT_NOT_AUTHORIZED'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })

  await withScenario({
    instanceSchema: {
      type: 'object',
      properties: { goal: { type: 'object', properties: { summary: { minLength: 10_000 } } } },
    },
  }, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, args)),
      errorCode('INVALID_ARGUMENT'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })

  await withScenario({
    instanceSchema: { $ref: '#/$defs/goal' },
  }, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, args)),
      errorCode('INVALID_ARGUMENT'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })
})

void test('S4-B2 commit enforces maxTasks and maxDepth before the fact', async () => {
  await withScenario({ maxTasks: 2 }, async (scenario) => {
    const { prepared, preparedSecond } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [
        { bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) },
        { bindingId: 'b2', ackPreview: preparedSecond.previewRef.digest, task: proposal(scenario) },
      ],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      prepareCall(2, 2, 1, 'prepare-2', 'b2'),
      prepareResult(3, 2, 1, 'prepare-2', preparedSecond.response),
      commitCall(4, 2, 2, 'commit-1', args),
    ], [1, 3])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, args)),
      errorCode('LIMIT_EXCEEDED'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })

  await withScenario({ maxDepth: 0 }, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    await assert.rejects(
      commitDecomposeBatch(commitInput(scenario, session, args)),
      errorCode('LIMIT_EXCEEDED'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })

})

void test('S4-B2 one preview admits distinct same-probe instances and replays the original batch', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [
        { bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) },
        {
          bindingId: 'b1',
          ackPreview: prepared.previewRef.digest,
          task: proposal(scenario, {
            acceptanceCriteria: [{ check: 'test -s notes.txt', id: 'duplicate-binding', statement: 'Duplicate binding.' }],
          }),
        },
      ],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    const result = await commitDecomposeBatch(commitInput(scenario, session, args))
    assert.equal(result.children.length, 2)
    assert.notEqual(result.children[0]?.taskId, result.children[1]?.taskId)
    assert.deepEqual(result.children.map(child => [child.bindingId, child.join]), [['b1', 'probe'], ['b1', 'probe']])
    assert.deepEqual(result.deliveryReceiptRefs, [prepared.deliveryReceiptRef, prepared.deliveryReceiptRef])
    assert.equal(scenario.service.facts().length, 3)
    const replay = await commitDecomposeBatch(commitInput(scenario, session, args))
    assert.deepEqual(replay.children, result.children)
    assert.equal(replay.fact.digest, result.fact.digest)
    assert.equal(scenario.service.facts().length, 3)
    const state = await scenario.service.taskRunState([])
    assert.equal(state.tasks.size, 3)
    assert.equal(state.runs.size, 1)
    if (result.fact.type !== 'task/children-admitted') assert.fail('expected child admission')
    assert.equal(result.fact.data.children.reduce((sum, child) => sum + child.budgetReservation.tokens, 0), 90_000)
  })
})

void test('S4-B2 commit rejects a non-active parent Run before reading any child proposal', async () => {
  await withScenario({}, async (scenario) => {
    const { prepared } = await prepareBoth(scenario)
    const args = {
      action: 'commit' as const,
      children: [{ bindingId: 'b1', ackPreview: prepared.previewRef.digest, task: proposal(scenario) }],
    }
    const session = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1', 'b1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response),
      commitCall(2, 1, 2, 'commit-1', args),
    ], [1])
    const input = commitInput(scenario, session, args)
    await assert.rejects(
      commitDecomposeBatch({ ...input, parentRunId: 'run-missing' }),
      errorCode('INVALID_ARGUMENT'),
    )
    assert.equal(scenario.service.facts().length, 2)
  })
})
