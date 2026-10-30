import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, seal, verifyDigest } from '../src/digest.ts'
import {
  budgetReservationSchema,
  cancellationCutAffectedSchema,
  cancellationCutPayloadSchema,
  cancellationCutSchema,
  compositionMcpServerSchema,
  compositionPayloadSchema,
  compositionSchema,
  executionRecordPayloadSchema,
  executionRecordSchema,
  sessionCutSchema,
  usageRecordSchema,
  usageRecordSummarySchema,
} from '../src/fact.ts'
import type {
  BudgetReservation,
  CancellationCut,
  CancellationCutAffected,
  CancellationCutPayload,
  Composition,
  CompositionMcpServer,
  CompositionPayload,
  ExecutionRecord,
  ExecutionRecordPayload,
  SessionCut,
  UsageRecord,
} from '../src/fact.ts'
import { canonicalize } from '../src/json.ts'
import { parseProtocolValue, protocolJsonSchema } from '../src/schema.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`

function ref(id: string, digest = digestA): { readonly id: string; readonly digest: string } {
  return { id, digest }
}

const sessionCut: SessionCut = {
  sessionId: 'session-root-1',
  from: 0,
  to: 42,
}

const budgetReservation: BudgetReservation = {
  tokens: 10_000,
  steps: 20,
  deadlineAt: 1_800_000_000_000,
}

const usage: UsageRecord = {
  inputTokens: 120,
  outputTokens: 80,
  steps: 4,
  unknownRequests: 2,
  summary: {
    ownerTaskId: 'task-root',
    sourceContract: digestB,
    inputTokens: 20,
    outputTokens: 10,
    steps: 2,
    unknownRequests: 3,
  },
}

const executionRecordPayload: ExecutionRecordPayload = {
  v: 1,
  taskId: 'task-root',
  runId: 'run-root-1',
  contractDigest: digestC,
  method: ref('method-1', digestB),
  composition: ref('composition-1', digestA),
  inputs: [ref('input-1', digestC), ref('input-2', digestD)],
  outputs: [ref('output-1', digestD)],
  usage,
  sessionCut,
  reason: 'The Run stopped after its agent session drained',
  drainPending: true,
}

const mcpServer: CompositionMcpServer = {
  manifest: ref('mcp-manifest-1', digestA),
  bundle: ref('mcp-bundle-1', digestB),
  schema: ref('mcp-schema-1', digestC),
  config: ref('mcp-config-1', digestD),
  transport: 'streamable-http',
  capabilities: ['filesystem.read', 'network.none'],
}

const compositionPayload: CompositionPayload = {
  v: 1,
  dsh: {
    package: 'dsh',
    version: '0.2.2-alpha.2',
    config: ref('dsh-config-1', digestA),
  },
  platformPrompt: digestB,
  contract: ref('contract-root', digestC),
  template: ref('template-1', digestD),
  guidance: ref('guidance-1', digestA),
  skills: [ref('skill-bundle-1', digestB)],
  mcpServers: [mcpServer],
  modelRoute: ref('model-route-1', digestC),
  resources: ref('resources-1', digestD),
  seed: ref('seed-1', digestA),
}

const cancellationCutPayload: CancellationCutPayload = {
  v: 1,
  targetTaskId: 'task-root',
  affected: [
    {
      taskId: 'task-child-1',
      runId: 'run-child-1',
      executionRecordRef: ref('execution-record-child-1', digestB),
    },
    { taskId: 'task-child-2' },
    { taskId: 'task-child-3', runId: 'run-child-3' },
  ],
}

const affectedWithExecutionRecord: CancellationCutAffected = {
  taskId: 'task-child-1',
  runId: 'run-child-1',
  executionRecordRef: ref('execution-record-child-1', digestB),
}

void test('UsageRecord keeps known and unknown usage plus the summary sub-record', () => {
  const summary = usage.summary
  assert.ok(summary)
  assert.deepEqual(parseProtocolValue(usageRecordSchema, usage), usage)
  assert.deepEqual(parseProtocolValue(usageRecordSummarySchema, summary), summary)

  const withoutSummary: UsageRecord = {
    inputTokens: 0,
    outputTokens: 0,
    steps: 0,
    unknownRequests: 1,
  }
  assert.deepEqual(parseProtocolValue(usageRecordSchema, withoutSummary), withoutSummary)

  assert.throws(() => parseProtocolValue(usageRecordSchema, { ...usage, extra: true }))
  assert.throws(() =>
    parseProtocolValue(usageRecordSchema, { ...usage, summary: { ...summary, extra: true } }),
  )
  assert.throws(() =>
    parseProtocolValue(usageRecordSchema, { ...usage, summary: { ...summary, sourceContract: 'not-a-digest' } }),
  )
  assert.throws(() =>
    parseProtocolValue(usageRecordSchema, { ...usage, summary: { ...summary, ownerTaskId: undefined } }),
  )
})

void test('ExecutionRecord seals in the object domain with complete optional fields', () => {
  const sealed: ExecutionRecord = executionRecordSchema.parse(seal('object', executionRecordPayload))

  assert.equal(sealed.digest, computeDigest('object', executionRecordPayload))
  assert.equal(verifyDigest('object', sealed), true)
  assert.equal(verifyDigest('composition', sealed), false)
  assert.deepEqual(parseProtocolValue(executionRecordPayloadSchema, executionRecordPayload), executionRecordPayload)
  assert.deepEqual(parseProtocolValue(executionRecordSchema, sealed), sealed)

  const withoutOptionals: ExecutionRecordPayload = {
    v: 1,
    taskId: 'task-root',
    runId: 'run-root-1',
    contractDigest: digestC,
    method: ref('method-1', digestB),
    composition: ref('composition-1', digestA),
    inputs: [],
    usage,
    sessionCut,
    reason: 'No outputs were produced',
  }
  const parsed = parseProtocolValue(executionRecordPayloadSchema, withoutOptionals)
  assert.deepEqual(parsed, withoutOptionals)
  assert.equal('outputs' in parsed, false)
  assert.equal('drainPending' in parsed, false)
})

void test('ExecutionRecord rejects unknown fields and invalid nested values', () => {
  for (const invalid of [
    { ...executionRecordPayload, extra: true },
    { ...executionRecordPayload, v: 2 },
    { ...executionRecordPayload, contractDigest: 'not-a-digest' },
    { ...executionRecordPayload, method: { id: 'method-1' } },
    { ...executionRecordPayload, inputs: [ref('input-1'), { id: 'missing-digest' }] },
    { ...executionRecordPayload, outputs: 'not-an-array' },
    { ...executionRecordPayload, usage: { ...usage, extra: true } },
    { ...executionRecordPayload, sessionCut: { ...sessionCut, extra: true } },
    { ...executionRecordPayload, drainPending: 'yes' },
    { ...executionRecordPayload, digest: 'not-a-digest' },
  ]) {
    assert.throws(() => parseProtocolValue(executionRecordPayloadSchema, invalid))
  }
})

void test('Composition seals in the composition domain with complete MCP servers', () => {
  const sealed: Composition = compositionSchema.parse(seal('composition', compositionPayload))

  assert.equal(sealed.digest, computeDigest('composition', compositionPayload))
  assert.equal(verifyDigest('composition', sealed), true)
  assert.equal(verifyDigest('object', sealed), false)
  assert.deepEqual(parseProtocolValue(compositionPayloadSchema, compositionPayload), compositionPayload)
  assert.deepEqual(parseProtocolValue(compositionSchema, sealed), sealed)

  const minimalMcpServer: CompositionMcpServer = {
    manifest: ref('mcp-manifest-1'),
    bundle: ref('mcp-bundle-1'),
    schema: ref('mcp-schema-1'),
    config: ref('mcp-config-1'),
    transport: 'stdio',
    capabilities: [],
  }
  assert.deepEqual(parseProtocolValue(compositionMcpServerSchema, minimalMcpServer), minimalMcpServer)
})

void test('Composition rejects unknown fields and invalid nested values', () => {
  for (const invalid of [
    { ...compositionPayload, extra: true },
    { ...compositionPayload, dsh: { ...compositionPayload.dsh, extra: true } },
    { ...compositionPayload, dsh: { ...compositionPayload.dsh, config: 'not-a-ref' } },
    {
      ...compositionPayload,
      mcpServers: [{ ...mcpServer, extra: true }],
    },
    {
      ...compositionPayload,
      mcpServers: [{ ...mcpServer, transport: 'unsupported' }],
    },
    {
      ...compositionPayload,
      mcpServers: [{ ...mcpServer, capabilities: [1] }],
    },
    { ...compositionPayload, skills: [{ id: 'skill-1' }] },
    { ...compositionPayload, platformPrompt: 'not-a-digest' },
    { ...compositionPayload, digest: 'not-a-digest' },
  ]) {
    assert.throws(() => parseProtocolValue(compositionPayloadSchema, invalid))
  }
})

void test('SessionCut and BudgetReservation are strict supporting shapes', () => {
  assert.deepEqual(parseProtocolValue(sessionCutSchema, sessionCut), sessionCut)
  assert.deepEqual(parseProtocolValue(budgetReservationSchema, budgetReservation), budgetReservation)

  assert.throws(() => parseProtocolValue(sessionCutSchema, { ...sessionCut, extra: true }))
  assert.throws(() => parseProtocolValue(sessionCutSchema, { ...sessionCut, sessionId: undefined }))
  assert.throws(() => parseProtocolValue(budgetReservationSchema, { ...budgetReservation, extra: true }))
  assert.throws(() => parseProtocolValue(budgetReservationSchema, { ...budgetReservation, tokens: undefined }))
  assert.throws(() => parseProtocolValue(budgetReservationSchema, { ...budgetReservation, deadlineAt: -1 }))
  assert.throws(() => parseProtocolValue(budgetReservationSchema, { ...budgetReservation, deadlineAt: 1.5 }))
  assert.throws(() =>
    parseProtocolValue(budgetReservationSchema, {
      ...budgetReservation,
      deadlineAt: Number.MAX_SAFE_INTEGER + 1,
    }),
  )

  for (const deadlineAt of [0, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(
      parseProtocolValue(budgetReservationSchema, { ...budgetReservation, deadlineAt }),
      { ...budgetReservation, deadlineAt },
    )
  }
})

void test('CancellationCut is an immutable object-domain snapshot', () => {
  const sealed: CancellationCut = cancellationCutSchema.parse(seal('object', cancellationCutPayload))

  assert.equal(sealed.digest, computeDigest('object', cancellationCutPayload))
  assert.equal(verifyDigest('object', sealed), true)
  assert.equal(verifyDigest('composition', sealed), false)
  assert.deepEqual(parseProtocolValue(cancellationCutPayloadSchema, cancellationCutPayload), cancellationCutPayload)
  assert.deepEqual(parseProtocolValue(cancellationCutAffectedSchema, affectedWithExecutionRecord), affectedWithExecutionRecord)
  assert.deepEqual(parseProtocolValue(cancellationCutAffectedSchema, { taskId: 'task-child-2' }), {
    taskId: 'task-child-2',
  })

  for (const invalid of [
    { ...cancellationCutPayload, extra: true },
    { ...cancellationCutPayload, v: 2 },
    { ...cancellationCutPayload, affected: [{ taskId: 'task-child-1', extra: true }] },
    { ...cancellationCutPayload, affected: [{ runId: 'run-child-1' }] },
    { ...cancellationCutPayload, affected: [{ taskId: 'task-child-1', executionRecordRef: ref('record-1'), extra: true }] },
    { ...cancellationCutPayload, digest: 'not-a-digest' },
  ]) {
    assert.throws(() => parseProtocolValue(cancellationCutPayloadSchema, invalid))
  }
})

void test('supporting object schemas generate stable pure JSON Schema', () => {
  const schemas = [
    usageRecordSchema,
    usageRecordSummarySchema,
    sessionCutSchema,
    budgetReservationSchema,
    executionRecordPayloadSchema,
    executionRecordSchema,
    compositionMcpServerSchema,
    compositionPayloadSchema,
    compositionSchema,
    cancellationCutAffectedSchema,
    cancellationCutPayloadSchema,
    cancellationCutSchema,
  ] as const

  for (const schema of schemas) {
    const jsonSchema = protocolJsonSchema(schema)
    assert.equal(jsonSchema.type, 'object')
    assert.equal(jsonSchema.additionalProperties, false)
    assert.equal(canonicalize(jsonSchema), canonicalize(protocolJsonSchema(schema)))
  }
})
