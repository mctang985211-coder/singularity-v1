import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest,seal,verifyDigest } from '../src/digest.ts'
import type { FactType } from '../src/fact.ts'
import {
FACT_TYPES,
factSchema,
sealFact,
unsealedFactSchema,
verifyFact,
} from '../src/fact.ts'
import * as protocol from '../src/index.ts'
import type { JsonObject } from '../src/json.ts'
import { canonicalize } from '../src/json.ts'
import { protocolJsonSchema } from '../src/schema.ts'
import { sealTaskContract } from '../src/task.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`

function ref(id: string, digest = digestA): { readonly id: string; readonly digest: string } {
  return { id, digest }
}

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  steps: 2,
  unknownRequests: 0,
}

const budgetReservation = {
  tokens: 1_000,
  steps: 5,
  deadlineAt: 1_800_000_000_000,
}

const childContract = sealTaskContract({
  v: 1,
  taskId: 'task-child-1',
  spec: {
    goal: {
      summary: 'Produce one bounded child result',
      deliverable: 'A result file',
      scope: [],
      constraints: [],
    },
    criteria: [],
    inputs: [],
    outputs: [],
  },
  origin: {
    kind: 'child',
    parentId: 'task-root',
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    bindingId: 'binding-child-1',
  },
  method: ref('method-1', digestB),
  template: ref('template-1', digestC),
  resources: { baseTools: [], skills: [], mcpServers: [] },
  acceptance: ref('acceptance-1', digestD),
  environment: { seed: ref('seed-1', digestA), profile: ref('profile-1', digestB) },
  limits: {
    maxRuns: 1,
    maxStepsPerRun: 5,
    maxTokens: 1_000,
    deadlineAt: 1_800_000_000_000,
    maxDepth: 1,
    maxTasks: 1,
    maxBatchChildren: 1,
  },
})

const payloads: Record<FactType, unknown> = {
  'method/registered': { revision: ref('method-1', digestB), parent: ref('method-0') },
  'method/activated': {
    expectedPrevious: ref('method-1', digestB),
    previous: ref('method-1', digestB),
    next: ref('method-2', digestC),
    approval: ref('approval-1', digestD),
  },
  'task/admitted': { taskId: 'task-root', contract: ref('contract-root', childContract.digest) },
  'run/opened': {
    taskId: 'task-root',
    runId: 'run-root-1',
    attempt: 1,
    sessionId: 'session-root-1',
    composition: ref('composition-1', digestA),
    workspaceKey: 'workspace-root-1',
    workspaceSeed: ref('seed-1', digestB),
    budgetReservation,
  },
  'task/children-admitted': {
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    children: [{ contract: childContract, join: 'required', budgetReservation }],
  },
  'run/submitted': {
    runId: 'run-root-1',
    outputs: ref('outputs-manifest-1', digestC),
    transcriptOffset: { sessionId: 'session-root-1', seq: 42 },
    previewReceipts: [ref('preview-receipt-1', digestA)],
    readReceipts: [ref('read-receipt-1', digestB)],
    planningSketchRef: ref('planning-sketch-1', digestC),
    feedbackRefs: [ref('feedback-1', digestD)],
  },
  'run/closed': {
    runId: 'run-root-1',
    classification: 'verified',
    reason: 'All required criteria passed',
    evidenceRef: ref('evidence-1', digestA),
    usage,
    planningSketchRef: ref('planning-sketch-1', digestB),
    feedbackRefs: [],
  },
  'task/closed': {
    taskId: 'task-root',
    outcome: 'verified',
    reason: 'All required child joins passed',
    decisiveRunId: 'run-root-1',
    evidenceRefs: [ref('evidence-1', digestA)],
  },
  'rsi/trace-sealed': {
    rootTaskId: 'task-root',
    trace: ref('trace-1', digestC),
    usage,
    sessionCuts: [{ sessionId: 'session-root-1', from: 0, to: 42 }],
  },
  'rsi/round-opened': {
    roundId: 'round-1',
    sourceTrace: ref('trace-1', digestA),
    baseMethod: ref('method-1', digestB),
    plan: ref('round-plan-1', digestC),
    proposerSessionId: 'session-proposer-1',
  },
  'rsi/proposal-submitted': { roundId: 'round-1', patch: ref('method-patch-1', digestD) },
  'rsi/candidate-ready': {
    roundId: 'round-1',
    patch: ref('method-patch-1', digestA),
    precheckReceipt: ref('precheck-receipt-1', digestB),
    candidateMethod: ref('method-candidate-1', digestC),
  },
  'rsi/round-closed': {
    roundId: 'round-1',
    outcome: 'no-improvement',
    comparisonRef: ref('comparison-1', digestD),
    reason: 'Candidate did not improve the frozen comparison set',
  },
}

function makeBody(
  type: FactType,
  data: unknown,
  overrides: Record<string, unknown> = {},
): JsonObject {
  return {
    v: 1,
    seq: 0,
    commandId: 'command-1',
    commandDigest: digestB,
    type,
    actor: { kind: 'runtime', id: 'runtime-1' },
    at: 1_800_000_000_000,
    data,
    prev: null,
    ...overrides,
  } as JsonObject
}

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([entry]) => entry !== key))
}

void test('every fact type seals and verifies in the fact domain', () => {
  for (const type of FACT_TYPES) {
    const body = makeBody(type, payloads[type])
    const sealed = sealFact(body)

    assert.equal(sealed.type, type)
    assert.deepEqual(sealed.data, payloads[type])
    assert.equal(sealed.digest, computeDigest('fact', body))
    assert.equal(sealFact(body).digest, sealed.digest)
    assert.equal(verifyFact(sealed), true)
    assert.equal(verifyDigest('fact', sealed), true)
    assert.equal(verifyDigest('contract', sealed), false)
  }
})

void test('fact type and data must be a matching union variant', () => {
  for (const type of FACT_TYPES) {
    assert.throws(() => sealFact(makeBody(type, { unexpected: true })), Error, type)
  }

  assert.throws(() => sealFact(makeBody('run/opened', payloads['task/admitted'])))
  assert.throws(() => sealFact(makeBody('task/admitted', payloads['run/opened'])))
  assert.throws(() => sealFact(makeBody('task/unknown' as FactType, payloads['task/admitted'])))
})

void test('the fact envelope rejects unknown fields and invalid required fields', () => {
  const valid = makeBody('task/admitted', payloads['task/admitted'])

  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, v: 2 },
    without(valid, 'v'),
    without(valid, 'seq'),
    without(valid, 'commandId'),
    without(valid, 'commandDigest'),
    without(valid, 'type'),
    without(valid, 'actor'),
    without(valid, 'at'),
    without(valid, 'data'),
    without(valid, 'prev'),
    { ...valid, commandId: 1 },
    { ...valid, commandDigest: 'not-a-digest' },
    { ...valid, commandDigest: digestA.toUpperCase() },
    { ...valid, actor: { kind: 'model', id: 'model-1' } },
    { ...valid, actor: { kind: 'runtime' } },
    { ...valid, actor: { kind: 'runtime', id: 1 } },
    { ...valid, actor: { kind: 'runtime', id: 'runtime-1', extra: true } },
    { ...valid, at: -1 },
    { ...valid, at: 1.5 },
    { ...valid, at: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, prev: 'not-a-digest' },
    { ...valid, prev: 1 },
  ]) {
    assert.throws(() => sealFact(invalid))
  }

  assert.doesNotThrow(() => sealFact({ ...valid, prev: null }))
  assert.doesNotThrow(() => sealFact({ ...valid, prev: digestA }))
})

void test('seq starts at zero and must remain a non-negative safe integer', () => {
  const valid = makeBody('task/admitted', payloads['task/admitted'])

  for (const seq of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => sealFact({ ...valid, seq }))
  }
  for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => sealFact({ ...valid, seq }))
  }
})

void test('sealFact is deterministic and verifyFact rejects tampering and wrong domains', () => {
  const body = makeBody('run/opened', payloads['run/opened'])
  const first = sealFact(body)
  const second = sealFact(body)

  assert.deepEqual(first, second)
  assert.equal(first.digest, second.digest)

  for (const tampered of [
    { ...first, commandId: 'command-2' },
    { ...first, commandDigest: digestA },
    { ...first, seq: first.seq + 1 },
    { ...first, at: first.at + 1 },
    { ...first, actor: { kind: 'operator', id: first.actor.id } },
    { ...first, prev: digestA },
    { ...first, data: { ...payloads['run/opened'] as object, runId: 'run-root-2' } },
    { ...first, digest: `sha256:${'0'.repeat(64)}` },
    { ...first, digest: first.digest.toUpperCase() },
    { ...first, extra: true },
  ]) {
    assert.equal(verifyFact(tampered), false)
  }

  assert.equal(verifyFact(seal('contract', body)), false)
  assert.equal(verifyFact(null), false)
  assert.equal(verifyFact('not-a-fact'), false)
  assert.equal(verifyFact([]), false)
  assert.equal(verifyFact(payloads['task/admitted']), false)
})

void test('sealFact rejects non-JSON input and verifyFact returns false', () => {
  const body = makeBody('task/admitted', payloads['task/admitted'])
  const data = payloads['task/admitted'] as Record<string, unknown>

  const invalidInputs: readonly unknown[] = [
    { ...body, data: { ...data, date: new Date(0) } },
    { ...body, data: { ...data, bigint: 1n } },
    { ...body, data: { ...data, nan: Number.NaN } },
    { ...body, data: { ...data, infinity: Number.POSITIVE_INFINITY } },
    { ...body, data: { ...data, missing: undefined } },
    { ...body, data: { ...data, callback: () => 'not-json' } },
    { ...body, data: { ...data, symbol: Symbol('not-json') } },
  ]

  for (const invalid of invalidInputs) {
    assert.throws(() => sealFact(invalid))
    assert.equal(verifyFact(invalid), false)
  }

})

void test('fact envelope union is representable as JSON Schema without refinements', () => {
  const jsonSchema = protocolJsonSchema(factSchema)
  assert.ok(Array.isArray(jsonSchema.oneOf))
  assert.equal(canonicalize(jsonSchema), canonicalize(protocolJsonSchema(factSchema)))
  const unsealedJsonSchema = protocolJsonSchema(unsealedFactSchema)
  assert.ok(Array.isArray(unsealedJsonSchema.oneOf))
})

void test('index exports the fact envelope and supporting schemas', () => {
  const names = [
    'FACT_TYPES',
    'factTypeSchema',
    'factPayloadSchemaByType',
    'factSchema',
    'unsealedFactSchema',
    'sealFact',
    'verifyFact',
    'usageRecordSchema',
    'sessionCutSchema',
    'budgetReservationSchema',
    'executionRecordSchema',
    'compositionSchema',
    'cancellationCutSchema',
  ] as const

  for (const name of names) {
    assert.ok(Object.hasOwn(protocol, name), `${name} must be exported from the protocol index`)
  }
  assert.equal(protocol.sealFact, sealFact)
  assert.equal(protocol.verifyFact, verifyFact)
})
