import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalize } from '../src/json.ts'
import {
  localFinalistPolicySchema,
  proposalHistoryEntrySchema,
  replayClosureSchema,
  replayPointSchema,
  sliceAttemptSchema,
  sliceCampaignResultSchema,
  sliceFeaturesSchema,
  sliceSelectionSchema,
} from '../src/replay.ts'
import type {
  LocalFinalistPolicy,
  ProposalHistoryEntry,
  ReplayClosure,
  ReplayPoint,
  SliceAttempt,
  SliceCampaignResult,
  SliceFeatures,
  SliceSelection,
} from '../src/replay.ts'
import type { Ref } from '../src/refs.ts'
import { parseProtocolValue, protocolJsonSchema } from '../src/schema.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`

function ref(id: string, digest = digestA): Ref {
  return { id, digest }
}

const sourceCase = ref('case-source', digestA)
const siblingCase = ref('case-sibling', digestB)

const usage = {
  inputTokens: 120,
  outputTokens: 80,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  steps: 4,
  unknownRequests: 1,
}

const bestEffortClosure: ReplayClosure = {
  level: 'best-effort',
  workspace: 'fresh-cas-inputs',
  network: 'uncontrolled',
  hostFilesystem: 'uncontrolled',
  reasons: ['ordinary-runner-has-no-execution-proof'],
}

const closedClosure: ReplayClosure = {
  level: 'closed',
  workspace: 'fresh-cas-inputs',
  network: 'disabled',
  hostFilesystem: 'denied',
  executionProof: ref('runner-proof', digestC),
  reasons: ['trusted-runner-attestation'],
}

const replayPoint: ReplayPoint = {
  v: 1,
  id: 'replay:root:task-child:run-2',
  sourceTrace: ref('trace-1', digestA),
  sourceTaskId: 'task-child',
  sourceContract: ref('contract-child', digestB),
  sourceEvidence: ref('evidence-child', digestC),
  sourceCase,
  baseMethod: ref('method-base', digestA),
  templateId: 'implement-consumer',
  bindingPath: ['root-binding', 'child-binding'],
  outcome: 'failed',
  localCases: [sourceCase, siblingCase],
  localMetric: { criterion: 'runtime', name: 'speedup', unit: 'ratio' },
  closure: bestEffortClosure,
  fanOut: { bindingReferences: 2, shared: true },
  hostFingerprint: 'host:dsh:0.2.2-alpha.2:model-route:seed',
  replayTolerance: { relative: 0.05 },
}

const features: SliceFeatures = {
  failed: true,
  leaf: false,
  retries: 2,
  subtreeTokens: 900,
  rootTokens: 3000,
  priorAttempts: 1,
  qualityHeadroom: true,
}

const selection: SliceSelection = {
  v: 1,
  campaignId: 'campaign-1',
  point: replayPoint,
  features,
  policy: { name: 'utility-v1', revision: 1 },
  visibleHistory: [ref('history-1', digestB)],
  score: 4.2,
  reasons: ['independent-failed-evidence', 'retry-pressure'],
}

const attempt: SliceAttempt = {
  v: 1,
  attemptId: 'attempt-1',
  campaignId: 'campaign-1',
  selection: ref('selection-1', digestA),
  patch: ref('patch-1', digestB),
  candidateMethod: ref('method-candidate', digestC),
  proposalRecord: ref('proposal-record-1', digestA),
  localPlan: ref('local-plan-1', digestB),
  comparison: ref('comparison-1', digestC),
  scope: {
    kind: 'existing-template',
    sharedTemplate: true,
    affectedTemplateIds: ['implement-consumer'],
  },
  outcome: 'local-qualified',
  usage,
  nativeRequests: 6,
  nativeCompleted: 6,
  runCount: 2,
  cacheComplete: true,
}

const campaignResult: SliceCampaignResult = {
  v: 1,
  campaignId: 'campaign-1',
  roundId: 'round-1',
  finalistPolicy: { kind: 'root-quality' },
  selection: ref('selection-1', digestA),
  baselineRoundId: 'round-1:slice:baseline',
  baselineSlots: ['baseline-slot-1'],
  hostFingerprint: 'host:dsh:0.2.2-alpha.2:model-route:seed',
  attempts: [ref('attempt-1', digestA)],
  finalistAttempt: ref('attempt-1', digestA),
  outcome: 'finalist',
  localPlan: ref('local-plan-1', digestB),
  budget: { maxTokens: 100_000, maxRuns: 8, maxWallClockMs: 600_000 },
  usage,
  nativeRequests: 6,
  nativeCompleted: 6,
  runCount: 2,
  cacheComplete: true,
}

function roundTrip<Value>(schema: { parse: (value: unknown) => Value }, value: Value): Value {
  const parsed = schema.parse(value)
  assert.deepEqual(parsed, value)
  const serialized = JSON.parse(JSON.stringify(parsed)) as unknown
  assert.deepEqual(schema.parse(serialized), value)
  return parsed
}

void test('replay closure only accepts proof for closed and hermetic controls', () => {
  roundTrip(replayClosureSchema, closedClosure)
  roundTrip(replayClosureSchema, bestEffortClosure)

  for (const invalid of [
    { ...closedClosure, executionProof: undefined },
    { ...closedClosure, workspace: 'uncontrolled' },
    { ...closedClosure, network: 'uncontrolled' },
    { ...closedClosure, hostFilesystem: 'uncontrolled' },
    { ...bestEffortClosure, executionProof: ref('forged-proof') },
    { ...closedClosure, extra: true },
    { ...bestEffortClosure, reasons: [1] },
  ]) {
    assert.throws(() => parseProtocolValue(replayClosureSchema, invalid))
  }
})

void test('ReplayPoint keeps sourceCase inside localCases and is a strict CAS record', () => {
  const parsed = roundTrip(replayPointSchema, replayPoint)
  assert.equal(parsed.sourceCase.id, sourceCase.id)

  for (const invalid of [
    { ...replayPoint, sourceCase: ref('outside-local-cases', digestC) },
    { ...replayPoint, sourceCase: { id: sourceCase.id, digest: digestC } },
    { ...replayPoint, localCases: [] },
    { ...replayPoint, localCases: [sourceCase, siblingCase, ref('case-third')] },
    { ...replayPoint, hostFingerprint: undefined },
    { ...replayPoint, replayTolerance: { relative: -0.01 } },
    { ...replayPoint, replayTolerance: { relative: 0.1, extra: true } },
    { ...replayPoint, outcome: 'invalid' },
    { ...replayPoint, bindingPath: [1] },
    { ...replayPoint, fanOut: { bindingReferences: -1, shared: false } },
    { ...replayPoint, extra: true },
  ]) {
    assert.throws(() => parseProtocolValue(replayPointSchema, invalid))
  }
})

void test('SliceSelection archives the exact utility-v1 feature snapshot', () => {
  roundTrip(sliceSelectionSchema, selection)

  const withoutFeatures: Record<string, unknown> = { ...selection }
  delete withoutFeatures.features
  for (const invalid of [
    withoutFeatures,
    { ...selection, features: { ...features, extra: true } },
    { ...selection, features: { ...features, retries: -1 } },
    { ...selection, features: { ...features, qualityHeadroom: undefined } },
    { ...selection, policy: { name: 'utility-v1', revision: 2 } },
    { ...selection, point: { ...replayPoint, sourceCase: ref('outside') } },
    { ...selection, extra: true },
  ]) {
    assert.throws(() => parseProtocolValue(sliceSelectionSchema, invalid))
  }
})

void test('ProposalHistoryEntry is public-only and strict', () => {
  const entry: ProposalHistoryEntry = {
    id: 'history-1',
    baseMethod: ref('method-base'),
    focusTemplateId: 'implement-consumer',
    hypothesis: 'The failed consumer path is bottlenecked by retries.',
    operations: ['put-template', 'put-skill'],
    outcome: 'local-qualified',
    reason: 'local comparator improved',
    aggregateDelta: 0.25,
  }
  roundTrip(proposalHistoryEntrySchema, entry)

  for (const invalid of [
    { ...entry, outcome: 'activated' },
    { ...entry, operations: 'put-template' },
    { ...entry, extra: true },
  ]) {
    assert.throws(() => parseProtocolValue(proposalHistoryEntrySchema, invalid))
  }
})

void test('local finalist policy exposes exactly two strict variants', () => {
  const policies: LocalFinalistPolicy[] = [
    { kind: 'root-quality' },
    { kind: 'engineering-cost-diagnostic', minRelativeTokenReduction: 0.2 },
  ]
  for (const policy of policies) roundTrip(localFinalistPolicySchema, policy)

  for (const invalid of [
    { kind: 'engineering-cost-diagnostic' },
    { kind: 'engineering-cost-diagnostic', minRelativeTokenReduction: 0 },
    { kind: 'engineering-cost-diagnostic', minRelativeTokenReduction: 1.1 },
    { kind: 'root-quality', extra: true },
    { kind: 'unknown' },
  ]) {
    assert.throws(() => parseProtocolValue(localFinalistPolicySchema, invalid))
  }
})

void test('SliceAttempt carries real ledger fields and cannot be a campaign outcome', () => {
  roundTrip(sliceAttemptSchema, attempt)

  for (const invalid of [
    { ...attempt, usage: undefined },
    { ...attempt, nativeRequests: undefined },
    { ...attempt, nativeCompleted: undefined },
    { ...attempt, runCount: undefined },
    { ...attempt, cacheComplete: undefined },
    { ...attempt, nativeRequests: '6' },
    { ...attempt, outcome: 'budget-exhausted' },
    { ...attempt, scope: { ...attempt.scope, extra: true } },
    { ...attempt, extra: true },
  ]) {
    assert.throws(() => parseProtocolValue(sliceAttemptSchema, invalid))
  }
})

void test('SliceCampaignResult forbids a finalist on budget exhaustion', () => {
  roundTrip(sliceCampaignResultSchema, campaignResult)

  const budgetExhausted: SliceCampaignResult = {
    ...campaignResult,
    outcome: 'budget-exhausted',
    reason: 'campaign budget exhausted',
  }
  delete budgetExhausted.finalistAttempt
  roundTrip(sliceCampaignResultSchema, budgetExhausted)
  assert.throws(
    () => parseProtocolValue(sliceCampaignResultSchema, { ...budgetExhausted, finalistAttempt: ref('attempt-1') }),
    /budget-exhausted campaigns cannot submit a finalist attempt/,
  )
  assert.throws(
    () => parseProtocolValue(sliceCampaignResultSchema, { ...campaignResult, finalistAttempt: undefined }),
    /must identify the finalist attempt/,
  )
  assert.throws(
    () => parseProtocolValue(sliceCampaignResultSchema, { ...campaignResult, outcome: 'no-qualified-candidate' }),
    /only finalist campaigns/,
  )

  for (const invalid of [
    { ...campaignResult, budget: undefined },
    { ...campaignResult, budget: { maxTokens: 100, maxRuns: 0, maxWallClockMs: 1000 } },
    { ...campaignResult, budget: { maxTokens: 100, maxRuns: 2, maxWallClockMs: 1.5 } },
    { ...campaignResult, nativeRequests: -1 },
    { ...campaignResult, cacheComplete: undefined },
    { ...campaignResult, outcome: 'improved' },
    { ...campaignResult, extra: true },
  ]) {
    assert.throws(() => parseProtocolValue(sliceCampaignResultSchema, invalid))
  }
})

void test('new replay schemas publish strict, stable JSON Schema', () => {
  const objectSchemas = [
    replayClosureSchema,
    sliceFeaturesSchema,
    replayPointSchema,
    sliceSelectionSchema,
    proposalHistoryEntrySchema,
    sliceAttemptSchema,
    sliceCampaignResultSchema,
  ] as const

  for (const schema of objectSchemas) {
    const jsonSchema = protocolJsonSchema(schema)
    assert.equal(jsonSchema.type, 'object')
    assert.equal(jsonSchema.additionalProperties, false)
    assert.equal(canonicalize(jsonSchema), canonicalize(protocolJsonSchema(schema)))
  }

  const policySchema = protocolJsonSchema(localFinalistPolicySchema)
  assert.ok(Array.isArray(policySchema.anyOf) || Array.isArray(policySchema.oneOf))
  assert.equal(canonicalize(policySchema), canonicalize(protocolJsonSchema(localFinalistPolicySchema)))
})
