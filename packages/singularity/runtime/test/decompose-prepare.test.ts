import assert from 'node:assert/strict'
import { mkdtemp,readdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Session,SessionEvent } from '@deepseek-ai/dsh-session'
import type {
Digest,
Ref,
TaskContract,
TaskTemplate,
} from '@singularity/protocol'
import { canonicalize,sealMethodRevision } from '@singularity/protocol'

import { readPrepareDeliveries } from '../src/decompose-deliveries.ts'
import { prepareDecompose } from '../src/decompose.ts'
import { initialContextEpoch } from '../src/epoch.ts'
import { DecomposeError } from '../src/errors.ts'
import type { FrozenMethodResources } from '../src/resources.ts'
import { DomainStore,DomainStoreError } from '../src/store.ts'

const textEncoder = new TextEncoder()
const digestA: Digest = `sha256:${'a'.repeat(64)}`

interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: 'append' | 'replace'
  readonly sourceEventSeqs?: readonly number[]
}

function bytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value))
}

function fakeSession(events: readonly FakeEvent[], nodes: readonly number[], firstLiveSeq = 0): Session {
  return {
    id: 'session-s4b1',
    get seq() { return events.length },
      snapshotEvents: () => events as unknown as readonly SessionEvent[],
    firstLiveSeq,
    surface: { nodes, replaceGeneration: 0 },
  } as unknown as Session
}

function prepareCall(seq: number, turn: number, step: number, callId: string): FakeEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1,
    data: {
      turn,
      step,
      callId,
      name: 'singularity_decompose',
      arguments: JSON.stringify({ action: 'prepare', bindingId: 'b1' }),
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

function statusCall(seq: number, turn: number, step: number, callId: string): FakeEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1,
    data: {
      turn,
      step,
      callId,
      name: 'singularity_read',
      arguments: JSON.stringify({ kind: 'status' }),
    },
  }
}

function exampleBody(marker = 'complete example'): Record<string, unknown> {
  return {
    goal: {
      summary: `Use the ${marker} and return one result.`,
      deliverable: 'One result.',
      scope: ['sample'],
      constraints: ['Read-only sample.'],
    },
    acceptanceCriteria: [{ id: 'local', statement: 'Record the sample.' }],
    inputs: [{ id: 'sample', exampleText: 'sample text' }],
    localOutputs: [{ id: 'notes', path: 'notes.txt', kind: 'file', description: 'Local note.' }],
  }
}

interface Fixture {
  readonly store: DomainStore
  readonly contract: TaskContract
  readonly resources: FrozenMethodResources
  readonly exampleRef: Ref
}

async function makeFixture(
  root: string,
  options: { readonly example?: Record<string, unknown> } = {},
): Promise<Fixture> {
  const store = await DomainStore.open({ root })
  const guidance = await store.putObject('guidance', bytes({ v: 1, text: 'Follow the frozen guidance.' }), 'object')
  const example = await store.putObject(
    'child-example',
    bytes(options.example ?? exampleBody()),
    'object',
  )
  const acceptance = await store.putObject('acceptance', bytes({ v: 1, kind: 'fixture-policy' }), 'object')
  const childTemplate: TaskTemplate = {
    id: 'template-child',
    brief: 'Inspect the sample.',
    guidance,
    example,
    instanceSchema: {},
    requiredCriteria: [],
    requiredOutputs: [],
    acceptancePolicy: acceptance,
    skills: [],
    tools: [],
    children: [],
  }
  const rootTemplate: TaskTemplate = {
    ...childTemplate,
    id: 'template-root',
    brief: 'Run the root task.',
    children: [{ bindingId: 'b1', templateId: childTemplate.id, brief: 'Inspect the sample.', join: 'probe' }],
  }
  const method = sealMethodRevision({
    v: 1,
    id: 'method-s4b1',
    entryTemplateId: rootTemplate.id,
    templates: [rootTemplate, childTemplate],
    skills: [],
    tools: [],
  })
  await store.putObject(method.id, bytes(method), 'method')
  const resources: FrozenMethodResources = {
    method,
    template: rootTemplate,
    guidance,
    guidanceText: 'Follow the frozen guidance.',
    skills: [],
    mcpServers: [],
  }
  const contract = {
    taskId: 'task-root',
    digest: digestA,
    method: { id: method.id, digest: method.digest },
    template: { id: rootTemplate.id, digest: method.digest },
  } as unknown as TaskContract
  return { store, contract, resources, exampleRef: example }
}

async function withFixture<T>(run: (fixture: Fixture, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 's4b1-decompose-'))
  const fixture = await makeFixture(root)
  try {
    return await run(fixture, root)
  } finally {
    await fixture.store.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function objectCount(directory: string): Promise<number> {
  return (await readdir(directory)).length
}

void test('S4-B1 prepare returns the frozen example and writes preview plus object receipt only', async () => {
  await withFixture(async ({ store, contract, resources }, root) => {
    const session = fakeSession([prepareCall(0, 1, 1, 'prepare-1')], [])
    const budget = { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 }
    const before = await objectCount(join(root, 'objects'))
    const result = await prepareDecompose({
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: store,
      writer: store,
      session,
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: budget,
      asOf: 10,
    }, 'b1')
    assert.equal(result.response.status, 'preview')
    assert.equal(result.response.join, 'probe')
    assert.equal(result.response.example.goal.summary.includes('complete example'), true)
    assert.equal(result.response.interface.requiredCriteria.length, 0)
    assert.equal(result.response.resolved.skills.length, 0)
    assert.equal(result.response.resolved.mcpServers.length, 0)
    assert.equal(await objectCount(join(root, 'objects')), before + 2)
    await store.readObject(result.previewRef, 'preview')
    await store.readObject(result.deliveryReceiptRef, 'object')
    await assert.rejects(store.readObject(result.previewRef, 'object'), /digest|domain|corrupt/i)
    await assert.rejects(store.readObject(result.deliveryReceiptRef, 'preview'), /digest|domain|corrupt/i)
    assert.equal(store.facts().length, 0)
  })
})

void test('S4-B1 repeated prepare keeps the preview content ref and creates a new delivery receipt', async () => {
  await withFixture(async ({ store, contract, resources }) => {
    const base = {
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: store,
      writer: store,
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }
    const first = await prepareDecompose({
      ...base,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
    }, 'b1')
    const second = await prepareDecompose({
      ...base,
      session: fakeSession([prepareCall(0, 1, 2, 'prepare-2')], []),
      callId: 'prepare-2',
    }, 'b1')
    assert.deepEqual(second.previewRef, first.previewRef)
    assert.notDeepEqual(second.deliveryReceiptRef, first.deliveryReceiptRef)
    assert.equal(store.facts().length, 0)
  })
})

void test('S4-B1 rejects unknown binding, oversized example, and malformed example without CAS writes', async () => {
  await withFixture(async ({ store, contract, resources }, root) => {
    const base = {
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: store,
      writer: store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }
    const before = await objectCount(join(root, 'objects'))
    await assert.rejects(prepareDecompose(base, 'missing'), (error: unknown) =>
      error instanceof DecomposeError && error.code === 'BINDING_FIXED')
    assert.equal(await objectCount(join(root, 'objects')), before)
    assert.equal(store.facts().length, 0)
  })

  const hugeRoot = await mkdtemp(join(tmpdir(), 's4b1-huge-'))
  const hugeStore = await makeFixture(hugeRoot, { example: exampleBody('x'.repeat(13 * 1024)) })
  try {
    const before = await objectCount(join(hugeRoot, 'objects'))
    await assert.rejects(prepareDecompose({
      contract: hugeStore.contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources: hugeStore.resources,
      reader: hugeStore.store,
      writer: hugeStore.store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1'), (error: unknown) =>
      error instanceof DecomposeError && error.code === 'LIMIT_EXCEEDED')
    assert.equal(await objectCount(join(hugeRoot, 'objects')), before)
    assert.equal(hugeStore.store.facts().length, 0)
  } finally {
    await hugeStore.store.close()
    await rm(hugeRoot, { recursive: true, force: true })
  }
})

void test('S4-B1 status reader distinguishes current, same-step, stale, and identity failures', async () => {
  await withFixture(async ({ store, contract, resources }) => {
    const base = {
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: store,
      writer: store,
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }
    const prepared = await prepareDecompose({
      ...base,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
    }, 'b1')
    const resultEvent = prepareResult(1, 1, 1, 'prepare-1', prepared.response)
    const later = fakeSession([prepareCall(0, 1, 1, 'prepare-1'), resultEvent, statusCall(2, 1, 2, 'status-1')], [1])
    const current = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: later,
      currentCallId: 'status-1',
    })
    assert.equal(current.length, 1)
    assert.equal(current[0]?.state, 'current')
    assert.equal(current[0]?.previewRef.id, prepared.previewRef.id)
    assert.equal(current[0]?.previewRef.digest, prepared.previewRef.digest)

    const sameStep = fakeSession([prepareCall(0, 1, 1, 'prepare-1'), resultEvent, statusCall(2, 1, 1, 'status-same')], [1])
    const same = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: sameStep,
      currentCallId: 'status-same',
    })
    assert.equal(same[0]?.state, 'next-step-required')

    const shadowed = fakeSession([prepareCall(0, 1, 1, 'prepare-1'), resultEvent, statusCall(2, 1, 2, 'status-1')], [])
    const staleSurface = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: shadowed,
      currentCallId: 'status-1',
    })
    assert.equal(staleSurface[0]?.state, 'stale')

    const epochChanged = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1'),
      resultEvent,
      statusCall(2, 1, 2, 'status-1'),
    ], [1], 3)
    const staleEpoch = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: epochChanged,
      currentCallId: 'status-1',
    })
    assert.equal(staleEpoch[0]?.state, 'stale')

    const badOutput = {
      ...prepared.response,
      previewRef: { id: 'missing-preview', digest: digestA },
    }
    const bad = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1'),
      prepareResult(1, 1, 1, 'prepare-1', badOutput),
      statusCall(2, 1, 2, 'status-1'),
    ], [1])
    await assert.rejects(readPrepareDeliveries({
      contract, runId: 'run-1', resources, reader: store, session: bad, currentCallId: 'status-1',
    }), (error: unknown) => error instanceof DomainStoreError && error.code === 'OBJECT_MISSING')
  })
})

void test('S4-B1 resource summaries expose only frozen skill and MCP identities', async () => {
  const { summarizeTemplateResources } = await import('../src/resources.ts')
  const summary = summarizeTemplateResources(
    [{ id: 'skill:one', name: 'first-skill' }],
    [{
      id: 'tool:calc',
      serverName: 'calc',
      transport: 'stdio',
      publicToolNames: ['mcp__calc__echo', 'mcp__calc__echo_extra'],
    }],
  )
  assert.deepEqual(summary.skills, [{ id: 'skill:one', name: 'first-skill' }])
  assert.deepEqual(summary.mcpServers, [{
    id: 'tool:calc',
    serverName: 'calc',
    transport: 'stdio',
    tools: ['mcp__calc__echo', 'mcp__calc__echo_extra'],
  }])
})

void test('S4-B1 example cap accepts 12288 bytes and rejects 12289 without CAS writes', async () => {
  const target = 12 * 1024
  const makeAt = (size: number): Record<string, unknown> => {
    const base = exampleBody()
    const prefix = 'pad:'
    for (let length = 0; length < size + 1024; length += 1) {
      const candidate = {
        ...base,
        goal: {
          ...(base['goal'] as Record<string, unknown>),
          summary: `${prefix}${'x'.repeat(length)}`,
        },
      }
      const bytes = textEncoder.encode(canonicalize(candidate)).byteLength
      if (bytes === size) return candidate
      if (bytes > size) break
    }
    throw new Error(`cannot construct example at ${String(size)} canonical bytes`)
  }

  const okRoot = await mkdtemp(join(tmpdir(), 's4b1-example-ok-'))
  const okStore = await makeFixture(okRoot, { example: makeAt(target) })
  try {
    const before = await objectCount(join(okRoot, 'objects'))
    await prepareDecompose({
      contract: okStore.contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources: okStore.resources,
      reader: okStore.store,
      writer: okStore.store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1')
    assert.equal(await objectCount(join(okRoot, 'objects')), before + 2)
  } finally {
    await okStore.store.close()
    await rm(okRoot, { recursive: true, force: true })
  }

  const overRoot = await mkdtemp(join(tmpdir(), 's4b1-example-over-'))
  const overStore = await makeFixture(overRoot, { example: makeAt(target + 1) })
  try {
    const before = await objectCount(join(overRoot, 'objects'))
    await assert.rejects(prepareDecompose({
      contract: overStore.contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources: overStore.resources,
      reader: overStore.store,
      writer: overStore.store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1'), (error: unknown) =>
      error instanceof DecomposeError && error.code === 'LIMIT_EXCEEDED')
    assert.equal(await objectCount(join(overRoot, 'objects')), before)
  } finally {
    await overStore.store.close()
    await rm(overRoot, { recursive: true, force: true })
  }
})

void test('S4-B1 prepare result cap rejects an oversized brief before CAS writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 's4b1-result-over-'))
  const fixture = await makeFixture(root)
  try {
    const binding = fixture.resources.template.children[0]
    assert.ok(binding)
    const resources = {
      ...fixture.resources,
      template: {
        ...fixture.resources.template,
        children: [{ ...binding, brief: 'x'.repeat(33 * 1024) }],
      },
    }
    const before = await objectCount(join(root, 'objects'))
    await assert.rejects(prepareDecompose({
      contract: fixture.contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: fixture.store,
      writer: fixture.store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1'), (error: unknown) =>
      error instanceof DecomposeError && error.code === 'LIMIT_EXCEEDED')
    assert.equal(await objectCount(join(root, 'objects')), before)
    assert.equal(fixture.store.facts().length, 0)
  } finally {
    await fixture.store.close()
    await rm(root, { recursive: true, force: true })
  }
})

void test('S4-B1 rejects duplicate binding ids on the parent template', async () => {
  await withFixture(async ({ store, contract, resources }, root) => {
    const binding = resources.template.children[0]
    assert.ok(binding)
    const duplicateResources = {
      ...resources,
      template: {
        ...resources.template,
        children: [binding, binding],
      },
    }
    const before = await objectCount(join(root, 'objects'))
    await assert.rejects(prepareDecompose({
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources: duplicateResources,
      reader: store,
      writer: store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1'), (error: unknown) =>
      error instanceof DecomposeError && error.code === 'BINDING_FIXED')
    assert.equal(await objectCount(join(root, 'objects')), before)
  })
})

void test('S4-B1 failed or replacement tool results never become current prepare deliveries', async () => {
  await withFixture(async ({ store, contract, resources }) => {
    const prepared = await prepareDecompose({
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: store,
      writer: store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1')
    const failed = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response, { isError: true }),
      statusCall(2, 1, 2, 'status-1'),
    ], [1])
    const failedDeliveries = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: failed,
      currentCallId: 'status-1',
    })
    assert.equal(failedDeliveries.length, 0)

    const replacement = fakeSession([
      prepareCall(0, 1, 1, 'prepare-1'),
      prepareResult(1, 1, 1, 'prepare-1', prepared.response, { surfaceOp: 'replace' }),
      statusCall(2, 1, 2, 'status-1'),
    ], [1])
    const replacementDeliveries = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: replacement,
      currentCallId: 'status-1',
    })
    assert.equal(replacementDeliveries[0]?.state, 'stale')
  })
})

void test('S4-B1 prepare result accepts exactly 32768 bytes and rejects oversized results', async () => {
  await withFixture(async ({ store, contract, resources }, root) => {
    const prepare = async (brief: string, callId: string) => {
      const binding = resources.template.children[0]
      assert.ok(binding)
      return prepareDecompose({
        contract,
        runId: 'run-1',
        sessionId: 'session-s4b1',
        resources: {
          ...resources,
          template: { ...resources.template, children: [{ ...binding, brief }] },
        },
        reader: store,
        writer: store,
        session: fakeSession([prepareCall(0, 1, 1, callId)], []),
        callId,
        epoch: initialContextEpoch('session-s4b1'),
        planningSketchRef: { id: 'sketch', digest: digestA },
        remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
        asOf: 10,
      }, 'b1')
    }
    const baseline = await prepare('x'.repeat(10), 'prepare-baseline')
    const baselineBytes = textEncoder.encode(canonicalize(baseline.response)).byteLength
    const estimatedLength = 10 + (32 * 1024 - baselineBytes)
    let exactLength: number | undefined
    for (let length = Math.max(0, estimatedLength - 10); length <= estimatedLength + 20; length += 1) {
      try {
        const candidate = await prepare('x'.repeat(length), `prepare-exact-${String(length)}`)
        const bytes = textEncoder.encode(canonicalize(candidate.response)).byteLength
        if (bytes === 32 * 1024) {
          exactLength = length
          break
        }
        if (bytes > 32 * 1024) break
      } catch (error) {
        if (error instanceof DecomposeError && error.code === 'LIMIT_EXCEEDED') break
        throw error
      }
    }
    assert.ok(exactLength !== undefined, 'could not construct an exact 32 KiB prepare result')
    const before = await objectCount(join(root, 'objects'))
    await assert.rejects(
      prepare('x'.repeat(exactLength + 100), 'prepare-over'),
      (error: unknown) => error instanceof DecomposeError && error.code === 'LIMIT_EXCEEDED',
    )
    assert.equal(await objectCount(join(root, 'objects')), before)
  })
})

void test('S4-B1 missing, non-UTF8, unknown-field, and malformed examples fail closed', async () => {
  const unknownRoot = await mkdtemp(join(tmpdir(), 's4b1-example-unknown-'))
  const unknownFixture = await makeFixture(unknownRoot, {
    example: { ...exampleBody(), unexpected: true },
  })
  try {
    await assert.rejects(prepareDecompose({
      contract: unknownFixture.contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources: unknownFixture.resources,
      reader: unknownFixture.store,
      writer: unknownFixture.store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1'), (error: unknown) => error instanceof Error && !(error instanceof DecomposeError))
  } finally {
    await unknownFixture.store.close()
    await rm(unknownRoot, { recursive: true, force: true })
  }

  const rawRoot = await mkdtemp(join(tmpdir(), 's4b1-example-raw-'))
  const rawFixture = await makeFixture(rawRoot)
  try {
    const invalidBytes = await rawFixture.store.putObject('invalid-example', new Uint8Array([0xff, 0xfe]), 'object')
    const missingRef: Ref = { id: 'missing-example', digest: digestA }
    for (const exampleRef of [invalidBytes, missingRef]) {
      const resources = {
        ...rawFixture.resources,
        method: {
          ...rawFixture.resources.method,
          templates: rawFixture.resources.method.templates.map(template =>
            template.id === 'template-child' ? { ...template, example: exampleRef } : template),
        },
      }
      await assert.rejects(prepareDecompose({
        contract: rawFixture.contract,
        runId: 'run-1',
        sessionId: 'session-s4b1',
        resources,
        reader: rawFixture.store,
        writer: rawFixture.store,
        session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
        callId: 'prepare-1',
        epoch: initialContextEpoch('session-s4b1'),
        planningSketchRef: { id: 'sketch', digest: digestA },
        remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
        asOf: 10,
      }, 'b1'), (error: unknown) => error instanceof Error && !(error instanceof DecomposeError))
    }
  } finally {
    await rawFixture.store.close()
    await rm(rawRoot, { recursive: true, force: true })
  }
})

void test('S4-B1 result identity, duplicates, and payload tampering are rejected', async () => {
  await withFixture(async ({ store, contract, resources }) => {
    const prepared = await prepareDecompose({
      contract,
      runId: 'run-1',
      sessionId: 'session-s4b1',
      resources,
      reader: store,
      writer: store,
      session: fakeSession([prepareCall(0, 1, 1, 'prepare-1')], []),
      callId: 'prepare-1',
      epoch: initialContextEpoch('session-s4b1'),
      planningSketchRef: { id: 'sketch', digest: digestA },
      remainingBudgetPct: { tokensPct: 90, stepsPct: 90, wallClockPct: 90, depthPct: 100, taskSlotsPct: 100 },
      asOf: 10,
    }, 'b1')
    const read = async (
      resultEvent: FakeEvent,
      currentCallId = 'status-1',
      extraEvents: readonly FakeEvent[] = [],
    ) => readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: fakeSession([
        prepareCall(0, 1, 1, 'prepare-1'),
        resultEvent,
        statusCall(2, 1, 2, currentCallId),
        ...extraEvents,
      ], [resultEvent.seq]),
      currentCallId,
    })
    const valid = prepareResult(1, 1, 1, 'prepare-1', prepared.response)
    const tamperedExample = prepareResult(1, 1, 1, 'prepare-1', {
      ...prepared.response,
      example: { ...prepared.response.example, goal: { ...prepared.response.example.goal, summary: 'tampered' } },
    })
    const missingExample = prepareResult(1, 1, 1, 'prepare-1', {
      ...prepared.response,
      example: undefined,
    })
    const wrongPreviewId = prepareResult(1, 1, 1, 'prepare-1', {
      ...prepared.response,
      previewRef: { ...prepared.response.previewRef, id: 'wrong-preview' },
    })
    const tamperedInterface = prepareResult(1, 1, 1, 'prepare-1', {
      ...prepared.response,
      interface: {
        ...prepared.response.interface,
        instanceSchema: { type: 'object' },
      },
    })

    for (const [label, event] of [
      ['tampered example', tamperedExample],
      ['missing example', missingExample],
      ['tampered instanceSchema', tamperedInterface],
      ['wrong preview id', wrongPreviewId],
    ] as const) {
      const deliveries = await read(event)
      assert.equal(deliveries[0]?.state, 'stale', label)
    }

    const duplicate = await readPrepareDeliveries({
      contract,
      runId: 'run-1',
      resources,
      reader: store,
      session: fakeSession([
        prepareCall(0, 1, 1, 'prepare-1'),
        valid,
        prepareResult(2, 1, 1, 'prepare-1', prepared.response),
        statusCall(3, 1, 2, 'status-1'),
      ], [1, 2]),
      currentCallId: 'status-1',
    })
    assert.equal(duplicate.length, 0)
  })
})

void test('S4-B1 method admission rejects duplicate child binding ids and dangling child templates', async () => {
  const { loadMethodResources } = await import('../src/resources.ts')
  await withFixture(async ({ store, contract, resources }) => {
    const method = resources.method
    const root = method.templates.find(template => template.id === 'template-root')
    const child = method.templates.find(template => template.id === 'template-child')
    assert.ok(root && child)
    const binding = root.children[0]
    assert.ok(binding)
    const seedMethod = async (
      templates: readonly TaskTemplate[],
    ): Promise<TaskContract> => {
      const next = sealMethodRevision({
        v: 1,
        id: `method-s4b1-${String(Math.random())}`,
        entryTemplateId: root.id,
        templates: [...templates],
        skills: [],
        tools: [],
      })
      await store.putObject(next.id, bytes(next), 'method')
      return {
        ...contract,
        resources: { baseTools: [], skills: [], mcpServers: [] },
        method: { id: next.id, digest: next.digest },
        template: { id: root.id, digest: next.digest },
      } as TaskContract
    }

    const duplicateRoot = {
      ...root,
      children: [binding, binding],
    }
    const duplicate = await seedMethod([duplicateRoot, child])
    await assert.rejects(loadMethodResources(store, duplicate), (error: unknown) =>
      error instanceof Error && /appears more than once/.test(error.message))

    const danglingRoot = {
      ...root,
      children: [{ ...binding, templateId: 'missing-template' }],
    }
    const dangling = await seedMethod([danglingRoot])
    await assert.rejects(loadMethodResources(store, dangling), (error: unknown) =>
      error instanceof Error && /must resolve to exactly one template/.test(error.message))
    assert.equal(store.facts().length, 0)
  })
})
