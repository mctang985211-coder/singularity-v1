import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { admitRootTask, canonicalize, sealEvidence, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { Fact, Ref, RoundPlan, TaskContract, TaskRunState, TaskState } from '@singularity/protocol'

import {
  assertPairedEvaluationContracts,
  compareEvaluation,
  compareLocalCandidate,
  compareMetricScores,
  compareVerifiedFraction,
  ensureEvaluationSlots,
  frozenEvaluationSlots,
  frozenLocalSlots,
  readEvaluationManifest,
} from '../src/evaluation.ts'
import type {
  EvaluationComparator,
  EvaluationManifest,
  EvaluationSlot,
  EvaluationTaskRequest,
  PublicEvaluationEvidence,
  EvaluationSlotResult,
  EvaluationUsage,
} from '../src/evaluation.ts'
import { evaluationCaseFromContract, freezeEvaluationCase } from '../src/evaluation-case.ts'
import { CommandService } from '../src/service.ts'

const ref = (id: string): Ref => ({ id, digest: `sha256:${'a'.repeat(64)}` })
const base = ref('base')
const candidate = ref('candidate')
const plan: RoundPlan = {
  v: 1, cases: [ref('case-a'), ref('case-b')], validationCases: [ref('validation')],
  validation: 'required-by-domain', claim: 'domain-evaluation', metric: { name: 'quality', aggregate: 'mean' },
  thresholds: { minDelta: 1, maxRegression: 0 }, trialsPerCase: 2,
  proposerBudget: { maxSteps: 2, maxTokens: 100, maxWallClockMs: 1000 },
  budget: { maxRuns: 24, maxTokens: 1000, maxWallClockMs: 5000, maxActiveRuns: 1 },
  comparator: ref('comparator'), sourceSeed: ref('seed'), expectedPreviousActiveMethod: base,
}
const usage: EvaluationUsage = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 2,
  steps: 2, unknownRequests: 0, complete: true, cacheComplete: true }

function emptyState(tasks: readonly TaskState[] = []): TaskRunState {
  return { tasks: new Map(tasks.map(task => [task.taskId, task])), runs: new Map(), batches: new Map() }
}

function fakeService(
  state: TaskRunState | (() => TaskRunState),
  objects: ReadonlyMap<string, unknown> = new Map(),
): { readonly service: CommandService; readonly writes: Map<string, Uint8Array> } {
  const writes = new Map<string, Uint8Array>()
  const facts: Fact[] = []
  const service = {
    facts: () => facts,
    taskRunState: () => Promise.resolve(typeof state === 'function' ? state() : state),
    putObject: (id: string, bytes: Uint8Array) => { writes.set(id, bytes); return Promise.resolve(ref(id)) },
    readObject: (value: Ref) => {
      const object = objects.get(value.id)
      if (object === undefined) return Promise.reject(new Error(`Missing fake object ${value.id}`))
      return Promise.resolve({ bytes: new TextEncoder().encode(canonicalize(object)) })
    },
  } as unknown as CommandService
  return { service, writes }
}

function evaluationContract(slot: EvaluationSlot, requestRef: Ref, summary = 'fixture', method: Ref = slot.method): TaskContract {
  return sealTaskContract({
    v: 1, taskId: slot.taskId, method, template: ref('template'),
    spec: { goal: { summary, deliverable: 'fixture', scope: [], constraints: [] }, criteria: [], inputs: [], outputs: [] },
    origin: { kind: 'root', purpose: 'evaluation', requestRef },
    resources: { baseTools: [], skills: [], mcpServers: [] }, acceptance: ref('verifier'),
    environment: { seed: ref('seed'), profile: ref('profile') },
    limits: { maxRuns: 1, maxStepsPerRun: 1, maxTokens: 1000, deadlineAt: 5000, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 },
  })
}

function closedTask(slot: EvaluationSlot, contract: TaskContract): TaskState {
  return {
    taskId: slot.taskId, contract, rootTaskId: slot.taskId, depth: 0, phase: 'closed', runIds: [], childIds: [],
    closed: { outcome: 'verified', reason: 'fixture', source: 'task/closed', factDigest: ref('fact').digest },
  }
}

function runner(slot: EvaluationSlot, requestRef: Ref): EvaluationTaskRequest {
  return {
    slot, requestRef, maxActive: 1, deadlineAt: 5000, signal: new AbortController().signal,
    checkReportedBudget: () => true, canOpenRun: () => true,
  }
}

function manifest(policy: RoundPlan = plan): EvaluationManifest {
  const slots: EvaluationSlotResult[] = frozenEvaluationSlots('round', policy, base, candidate).map(slot => {
    const receipt = sealPublicReceipt({
      v: 1, provider: ref('verifier'), operationId: slot.id, contractDigest: ref('contract').digest,
      inputDigests: [], outputDigests: [], criteria: [{ id: 'quality', verdict: 'pass', reason: 'fixture', metric: { name: 'quality', unit: 'points', value: 1 } }],
      exit: { code: 0, signal: null }, timedOut: false,
    })
    const evidence = sealEvidence({
      v: 1 as const, task: ref(slot.taskId), runId: `${slot.id}:run`, method: slot.method, contractDigest: ref('contract').digest,
      inputs: [], outputs: [], composition: ref('composition'), usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, steps: usage.steps, unknownRequests: usage.unknownRequests },
      sessionCut: { sessionId: slot.id, from: 0, to: 1 }, environment: { seed: ref('seed').digest, mode: 'workspace' },
      verification: { provider: ref('verifier'), operationId: slot.id, publicReceipt: ref('receipt') },
    })
    return {
      slot, status: 'complete', usage,
      publicEvidence: {
        slotId: slot.id, taskId: slot.taskId, caseRef: slot.caseRef, partition: slot.partition, arm: slot.arm, repetition: slot.repetition,
        verdict: 'verified', evidenceRef: ref(`${slot.id}:evidence`), evidence, receipt, usage,
      },
    }
  })
  return { slots, runCount: slots.length, complete: true, usage: { ...usage,
    inputTokens: usage.inputTokens * slots.length, outputTokens: usage.outputTokens * slots.length,
    cacheReadTokens: (usage.cacheReadTokens ?? 0) * slots.length, cacheWriteTokens: (usage.cacheWriteTokens ?? 0) * slots.length } }
}

function comparator(deltas: readonly number[] = [2, 2, 2], costObjective = false): EvaluationComparator {
  return {
    asset: plan.comparator,
    describeMetric: () => ({ name: 'quality', direction: 'higher-is-better', unit: 'points', costObjective }),
    compare: (policy, evidence) => {
      assert.equal(evidence.length, (policy.cases.length + policy.validationCases.length) * 2 * policy.trialsPerCase)
      assert.ok(evidence.every(item => !('privateReceipt' in item.evidence.verification)))
      return {
        comparable: true,
        cases: [...policy.cases, ...policy.validationCases].map((caseRef, index) => ({
          caseRef, baseline: 10, candidate: 10 + deltas[index], verdict: 'fixture aggregate',
        })),
        aggregateDelta: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
        cost: {
          baseline: evidence.filter(item => item.arm === 'baseline').reduce((sum, item) => sum + item.usage.inputTokens + item.usage.outputTokens, 0),
          candidate: evidence.filter(item => item.arm === 'candidate').reduce((sum, item) => sum + item.usage.inputTokens + item.usage.outputTokens, 0),
          unit: 'tokens',
        },
      }
    },
  }
}

void test('slots deterministically include both fresh arms, repetitions and held-out cases', () => {
  const slots = frozenEvaluationSlots('round', plan, base, candidate)
  assert.equal(slots.length, 12)
  assert.equal(new Set(slots.map(slot => slot.id)).size, slots.length)
  assert.deepEqual(slots, frozenEvaluationSlots('round', plan, base, candidate))
  assert.deepEqual(slots.slice(0, 4).map(slot => [slot.arm, slot.repetition]), [['candidate', 0], ['baseline', 0], ['candidate', 1], ['baseline', 1]])
  assert.equal(slots.filter(slot => slot.partition === 'validation').length, 4)
  assert.ok(slots.every(slot => slot.method.id === (slot.arm === 'baseline' ? base.id : candidate.id)))
})

void test('independent comparator is bounded by frozen minimum delta and every case regression', () => {
  const input = manifest()
  const result = compareEvaluation('round', ref('plan'), plan, input, comparator())
  assert.equal(result.outcome, 'improved')
  assert.equal(result.completeCases, 3)
  assert.equal(result.worstRegression, 0)
  assert.deepEqual(result.tokenCosts, {
    complete: true, cacheComplete: true,
    baseline: { inputTokens: 120, outputTokens: 30, uncachedInputTokens: 72, cacheReadTokens: 36, cacheWriteTokens: 12 },
    candidate: { inputTokens: 120, outputTokens: 30, uncachedInputTokens: 72, cacheReadTokens: 36, cacheWriteTokens: 12 },
  })
  const missingCache = { ...manifest(), usage: { ...manifest().usage, cacheComplete: false } }
  assert.equal(compareEvaluation('round', ref('plan'), plan, missingCache, comparator()).tokenCosts?.baseline.uncachedInputTokens, null)
  assert.equal(compareEvaluation('round', ref('plan'), plan, input, comparator([1, 1, -0.1])).outcome, 'no-improvement')
  assert.equal(compareEvaluation('round', ref('plan'), plan, input, comparator([0.5, 0.5, 0.5])).outcome, 'no-improvement')
})

void test('missing and invalid slots stay in the manifest and never reach comparator as zero scores', () => {
  const input = manifest()
  const first = input.slots[0]
  const slots: EvaluationSlotResult[] = [{ slot: first.slot, status: 'invalid', usage: first.usage, reason: 'no-submission' }, ...input.slots.slice(1)]
  const result = compareEvaluation('round', ref('plan'), plan, { ...input, complete: false, slots }, {
    asset: plan.comparator, describeMetric: () => { throw new Error('must not compare missing evidence') }, compare: () => { throw new Error('must not fill zero') },
  })
  assert.equal(result.outcome, 'insufficient-evidence')
  assert.equal(result.slots.length, input.slots.length)
  assert.deepEqual(result.missingOrInvalid, [first.slot.id])
  assert.equal(result.completeCases, 2)
})

void test('whole-slot usage including failed attempts is charged against frozen relative cost', () => {
  const costPlan = { ...plan, thresholds: { ...plan.thresholds, maxRelativeCostIncrease: 0.1 } }
  const input = manifest(costPlan)
  const slots = input.slots.map(slot => slot.slot.arm === 'candidate'
    ? { ...slot, usage: { ...slot.usage, inputTokens: slot.usage.inputTokens * 3 }, publicEvidence: slot.publicEvidence === undefined ? undefined : { ...slot.publicEvidence, usage: { ...slot.usage, inputTokens: slot.usage.inputTokens * 3 } } }
    : slot)
  const result = compareEvaluation('round', ref('plan'), costPlan, { ...input, slots }, comparator())
  assert.equal(result.outcome, 'no-improvement')
  assert.equal(result.reason, 'cost-threshold')
})

void test('an absent domain comparator closes insufficient and source replay keeps its claim', () => {
  const sourcePlan = { ...plan, claim: 'source-replay' as const }
  assert.equal(compareEvaluation('round', ref('plan'), sourcePlan, manifest(sourcePlan), undefined).reason, 'unsupported-comparator')
  assert.equal(compareEvaluation('round', ref('plan'), sourcePlan, manifest(sourcePlan), comparator()).claim, 'source-replay')
})

void test('slot accounting includes failed attempts, descendants and owned summary usage without inventing a score', async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-evaluation-accounting-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const actor = { kind: 'runtime', id: 'evaluation-accounting-test' } as const
  const service = await CommandService.open({ root, actor, clock: () => 1000 })
  t.after(() => service.close())
  const [slot] = frozenEvaluationSlots('round', plan, base, candidate)
  const requestRef = await service.putObject(slot.id, new TextEncoder().encode(canonicalize({ v: 1, roundId: slot.roundId, slot })))
  const contract = sealTaskContract({
    v: 1, taskId: slot.taskId, method: slot.method, template: ref('template'),
    spec: { goal: { summary: 'fixture', deliverable: 'fixture', scope: [], constraints: [] }, criteria: [], inputs: [], outputs: [] },
    origin: { kind: 'root', purpose: 'evaluation', requestRef },
    resources: { baseTools: [], skills: [], mcpServers: [] }, acceptance: ref('verifier'),
    environment: { seed: ref('seed'), profile: ref('profile') },
    limits: { maxRuns: 2, maxStepsPerRun: 10, maxTokens: 1000, deadlineAt: 5000, maxDepth: 1, maxTasks: 2, maxBatchChildren: 1 },
  })
  const task = {
    taskId: slot.taskId, contract, rootTaskId: slot.taskId, depth: 0, phase: 'closed' as const,
    runIds: ['failed-attempt', 'final-attempt'], childIds: ['child'],
    closed: { outcome: 'failed' as const, reason: 'no-submission', source: 'task/closed' as const, factDigest: ref('fact').digest },
  }
  const state: TaskRunState = {
    tasks: new Map<string, TaskState>([[slot.taskId, task], ['child', { ...task, taskId: 'child', rootTaskId: slot.taskId, parentTaskId: slot.taskId, runIds: ['child-run'], childIds: [] }]]),
    runs: new Map(['failed-attempt', 'final-attempt', 'child-run'].map((runId, index) => [runId, {
      runId, taskId: index === 2 ? 'child' : slot.taskId, attempt: index === 1 ? 2 : 1, phase: 'closed' as const, childIds: [],
      opened: { taskId: index === 2 ? 'child' : slot.taskId, runId, attempt: 1, sessionId: runId, composition: ref('composition'), workspaceKey: runId, workspaceSeed: ref('seed'), budgetReservation: { tokens: 1000, steps: 10, deadlineAt: 5000 } },
      closed: {
        classification: 'failed' as const, reason: 'fixture', source: 'run/closed' as const, factDigest: ref('fact').digest,
        usage: { inputTokens: 10, outputTokens: 2, steps: 1, unknownRequests: index === 2 ? 1 : 0,
          ...(index === 2 ? { summary: { ownerTaskId: 'child', sourceContract: contract.digest, inputTokens: 3, outputTokens: 1, steps: 1, unknownRequests: 0 } } : {}),
        },
      },
    }])),
    batches: new Map(),
  }
  const result = await readEvaluationManifest(service, [slot], state)
  assert.equal(result.complete, false)
  assert.equal(result.slots[0].status, 'invalid')
  assert.equal(result.runCount, 3)
  assert.deepEqual(result.usage, { inputTokens: 33, outputTokens: 7, steps: 4, unknownRequests: 1, complete: true, cacheComplete: false })
  assert.equal(result.slots[0].publicEvidence, undefined)
})

void test('verified-fraction comparison needs every quality trial but never converts cost into quality', () => {
  const evidence = manifest().slots.flatMap(slot => slot.publicEvidence === undefined ? [] : [slot.publicEvidence])
  assert.equal(compareVerifiedFraction(plan, evidence).aggregateDelta, 0)
  assert.equal(compareVerifiedFraction(plan, evidence.slice(1)).comparable, false)
  assert.equal(compareVerifiedFraction(plan, evidence.map(value => ({ ...value, verdict: 'failed' }))).aggregateDelta, 0)
  assert.equal(compareVerifiedFraction(plan, evidence.map(value => value.arm === 'candidate' ? { ...value, verdict: 'failed' } : value)).aggregateDelta, -1)
  assert.equal(compareVerifiedFraction(plan, evidence.map(value => ({ ...value, usage: { ...value.usage, complete: false } }))).comparable, true)
})

void test('continuous performance uses every public trial, remains uncapped, and keeps validation separate', () => {
  const receiptPayload = (receipt: PublicEvaluationEvidence['receipt']) => { const { digest, ...payload } = receipt; assert.ok(digest); return payload }
  const policy = { ...plan, metric: { criterion: 'quality', name: 'quality', unit: 'points' }, thresholds: { minDelta: 0.01, maxRegression: 0 } }
  const input = manifest(policy)
  const measured = (publicScore: number, validationScore = 1, baselineScore = 1) => input.slots.flatMap(slot => {
    if (slot.publicEvidence === undefined) return []
    const value = slot.slot.arm === 'baseline' ? baselineScore : slot.slot.partition === 'validation' ? validationScore : publicScore
    return [{ ...slot.publicEvidence, receipt: sealPublicReceipt({ ...receiptPayload(slot.publicEvidence.receipt),
      criteria: [{ id: 'quality', verdict: 'pass' as const, reason: 'Measured by the frozen checker.', metric: { name: 'quality', unit: 'points', value } }] }) }]
  })
  const metricComparator: EvaluationComparator = { asset: policy.comparator,
    describeMetric: () => ({ name: 'quality', direction: 'higher-is-better', unit: 'points', costObjective: false }), compare: compareMetricScores }
  const compare = (evidence: ReturnType<typeof measured>) => compareEvaluation('round', ref('plan'), policy,
    { ...input, slots: input.slots.map((slot, index) => ({ ...slot, publicEvidence: evidence[index] })) }, metricComparator)
  assert.ok(Math.abs((compareMetricScores(policy, measured(100)).aggregateDelta ?? 0) - 99) < 1e-10)
  assert.equal(compare(measured(2)).outcome, 'improved')
  assert.equal(compare(measured(1, 100)).outcome, 'no-improvement', 'held-out gain cannot raise the public objective')
  assert.equal(compare(measured(2, 0.9)).outcome, 'no-improvement', 'public gain cannot hide held-out regression')
  assert.equal(compare(measured(1)).outcome, 'no-improvement')
  assert.ok(Math.abs((compareMetricScores(policy, measured(2, 2, 0.5)).aggregateDelta ?? 0) - 3) < 1e-10)
  assert.equal(compareMetricScores(policy, measured(2).slice(1)).comparable, false)
  const wrong = measured(100).map((value, index) => index === 0 ? { ...value, verdict: 'failed' as const } : value)
  assert.equal(compare(wrong).outcome, 'no-improvement', 'incorrect artifacts cannot earn a large performance score')
  const missing = measured(2).map(value => ({ ...value, receipt: sealPublicReceipt({ ...receiptPayload(value.receipt),
    criteria: [{ id: 'quality', verdict: 'pass' as const, reason: 'Missing measurement.' }] }) }))
  assert.equal(compareMetricScores(policy, missing).comparable, false)
  const badUnit = measured(2).map(value => ({ ...value, receipt: sealPublicReceipt({ ...receiptPayload(value.receipt),
    criteria: [{ id: 'quality', verdict: 'pass' as const, reason: 'Wrong unit.', metric: { name: 'quality', unit: 'ms', value: 2 } }] }) }))
  assert.equal(compareMetricScores(policy, badUnit).comparable, false)
})

void test('validation-only verified-fraction gain is never averaged into public quality', () => {
  const evidence = manifest().slots.flatMap(slot => slot.publicEvidence === undefined ? [] : [{ ...slot.publicEvidence,
    verdict: slot.slot.partition === 'validation' && slot.slot.arm === 'candidate' ? 'verified' as const : 'failed' as const }])
  assert.equal(compareVerifiedFraction(plan, evidence).aggregateDelta, 0)
})

void test('local slots share baseline identities and keep every candidate independent', () => {
  const localPlan = { cases: [ref('local-a'), ref('local-b')], trialsPerCase: 2 }
  const baseline = frozenLocalSlots('round-local', localPlan, base)
  const first = frozenLocalSlots('round-local', localPlan, base, ref('candidate-a'))
  const second = frozenLocalSlots('round-local', localPlan, base, ref('candidate-b'))
  assert.equal(baseline.length, 4)
  assert.equal(first.length, 8)
  assert.deepEqual(first.slice(0, 4).map(slot => slot.id), baseline.map(slot => slot.id))
  assert.deepEqual(second.slice(0, 4).map(slot => slot.id), baseline.map(slot => slot.id))
  const firstCandidates = first.slice(4), secondCandidates = second.slice(4)
  assert.equal(firstCandidates.length, 4)
  assert.ok(firstCandidates.every(slot => slot.arm === 'candidate' && slot.method.id === 'candidate-a'))
  assert.ok(secondCandidates.every(slot => slot.arm === 'candidate' && slot.method.id === 'candidate-b'))
  assert.equal(new Set([...firstCandidates, ...secondCandidates].map(slot => slot.id)).size, 8)
  assert.ok([...first, ...second].every(slot => slot.roundId === 'round-local'))
  assert.equal(new Set(baseline.map(slot => `${slot.taskId}:${slot.id}`)).size, 4)
})

void test('ensureEvaluationSlots binds requestRef to slot.roundId', async () => {
  const slots = frozenLocalSlots('slot-owned-round', { cases: [ref('case')], trialsPerCase: 1 }, base, ref('candidate'))
  const candidateSlot = slots.find(slot => slot.arm === 'candidate')
  assert.ok(candidateSlot)
  const fake = fakeService(emptyState())
  let captured: EvaluationTaskRequest | undefined
  await ensureEvaluationSlots({
    service: fake.service, slots: [candidateSlot],
    runTask: request => { captured = request; return Promise.resolve() },
    requestFor: runner,
  })
  const bytes = fake.writes.get(candidateSlot.id)
  assert.ok(bytes)
  assert.ok(captured)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), { v: 1, roundId: 'slot-owned-round', slot: candidateSlot })
  assert.equal(captured.slot.id, candidateSlot.id)
  assert.equal(captured.requestRef.id, candidateSlot.id)
})

void test('executionOrder controls purchase order while keeping every slot addressable', async () => {
  const slots = frozenLocalSlots('round-order', { cases: [ref('case')], trialsPerCase: 1 }, base, ref('candidate'))
  const baselineSlot = slots.find(slot => slot.arm === 'baseline')
  const candidateSlot = slots.find(slot => slot.arm === 'candidate')
  assert.ok(baselineSlot && candidateSlot)
  const fake = fakeService(emptyState())
  const purchased: string[] = []
  await ensureEvaluationSlots({
    service: fake.service, slots: [baselineSlot, candidateSlot], executionOrder: [candidateSlot],
    runTask: value => { purchased.push(value.slot.id); return Promise.resolve() }, requestFor: runner,
  })
  assert.deepEqual(purchased, [candidateSlot.id])
  await assert.rejects(ensureEvaluationSlots({
    service: fakeService(emptyState()).service, slots: [baselineSlot], executionOrder: ['unknown-slot'],
    runTask: () => { throw new Error('an unknown order entry must not purchase') }, requestFor: runner,
  }), /Unknown evaluation slot in execution order/)
})

void test('ensureEvaluationSlots never re-enters an in-flight identity', async () => {
  const slot = frozenLocalSlots('round-flight', { cases: [ref('case')], trialsPerCase: 1 }, base, ref('candidate'))[0]
  const requestRef = ref('flight-request')
  const task: TaskState = { ...closedTask(slot, evaluationContract(slot, requestRef)), phase: 'open', closed: undefined }
  const fake = fakeService(emptyState([task]))
  await ensureEvaluationSlots({
    service: fake.service, slots: [slot],
    runTask: () => { throw new Error('in-flight identities must not run again') },
    requestFor: runner,
  })
  assert.equal(fake.writes.size, 0)
})

void test('closed slots are reused only after their Method and request match', async () => {
  const slots = frozenLocalSlots('round-closed', { cases: [ref('case')], trialsPerCase: 1 }, base, ref('candidate'))
  const baselineSlot = slots.find(slot => slot.arm === 'baseline')
  const candidateSlot = slots.find(slot => slot.arm === 'candidate')
  assert.ok(baselineSlot && candidateSlot)
  const requestRef = ref('baseline-request')
  const request = { v: 1, roundId: baselineSlot.roundId, slot: baselineSlot }
  const fake = fakeService(
    emptyState([closedTask(baselineSlot, evaluationContract(baselineSlot, requestRef))]),
    new Map([[requestRef.id, request]]),
  )
  const purchased: string[] = []
  await ensureEvaluationSlots({
    service: fake.service, slots: [baselineSlot, candidateSlot],
    runTask: value => { purchased.push(value.slot.id); return Promise.resolve() },
    requestFor: runner,
  })
  assert.deepEqual(purchased, [candidateSlot.id], 'a matching closed baseline is shown but not repurchased')

  const wrongRequestFake = fakeService(
    emptyState([closedTask(baselineSlot, evaluationContract(baselineSlot, requestRef))]),
    new Map([[requestRef.id, { ...request, roundId: 'stale-round' }]]),
  )
  await assert.rejects(ensureEvaluationSlots({
    service: wrongRequestFake.service, slots: [baselineSlot],
    runTask: () => { throw new Error('mismatched closed slots must not run') }, requestFor: runner,
  }), /does not match its frozen Method and request/)

  const wrongMethodFake = fakeService(
    emptyState([closedTask(baselineSlot, evaluationContract(baselineSlot, requestRef, 'fixture', ref('other-method')))]),
    new Map([[requestRef.id, request]]),
  )
  await assert.rejects(ensureEvaluationSlots({
    service: wrongMethodFake.service, slots: [baselineSlot],
    runTask: () => { throw new Error('mismatched closed slots must not run') }, requestFor: runner,
  }), /does not match its frozen Method and request/)
})

void test('per-arm budgets stop only their own arm while the total fuse stops all purchases', async () => {
  const slots = frozenLocalSlots('round-budget', { cases: [ref('case')], trialsPerCase: 1 }, base, ref('candidate'))
  const baselineSlot = slots.find(slot => slot.arm === 'baseline')
  const candidateSlot = slots.find(slot => slot.arm === 'candidate')
  assert.ok(baselineSlot && candidateSlot)
  const fake = fakeService(emptyState())
  const purchased: string[] = []
  await ensureEvaluationSlots({
    service: fake.service, slots: [candidateSlot, baselineSlot],
    budget: { candidate: { maxTokens: 1000, maxRuns: 0 } },
    runTask: value => { purchased.push(value.slot.id); return Promise.resolve() }, requestFor: runner,
  })
  assert.deepEqual(purchased, [baselineSlot.id], 'candidate cap cannot suppress the baseline arm')

  let totalPurchases = 0
  await ensureEvaluationSlots({
    service: fakeService(emptyState()).service, slots: [baselineSlot],
    budget: { total: { maxTokens: 1000, maxRuns: 0 } },
    runTask: () => { totalPurchases += 1; return Promise.resolve() }, requestFor: runner,
  })
  assert.equal(totalPurchases, 0)

  const blocked = fakeService(emptyState())
  await ensureEvaluationSlots({
    service: blocked.service, slots: [baselineSlot], canPurchase: () => false,
    runTask: () => { throw new Error('the synchronous campaign gate must stop purchase') }, requestFor: runner,
  })
  assert.equal(blocked.writes.size, 0)
})

void test('compareLocalCandidate is read-only and never closes a Round', async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-local-comparison-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root, actor: { kind: 'runtime', id: 'local-comparison-test' }, clock: () => 1000 })
  t.after(() => service.close())
  const localPlan: RoundPlan = {
    ...plan, cases: [ref('local-case')], validationCases: [], validation: 'none', claim: 'source-replay',
  }
  const slots = frozenLocalSlots('round-readonly', localPlan, base, candidate)
  const comparison = await compareLocalCandidate({
    service, roundId: 'round-readonly', planRef: ref('local-plan'), plan: localPlan, slots, comparator: comparator(),
  })
  assert.equal(comparison.outcome, 'insufficient-evidence')
  assert.equal(comparison.complete, false)
  assert.equal(comparison.slots.length, slots.length)
  assert.equal(service.facts().length, 0)
  assert.equal((await service.taskRunState([])).tasks.size, 0)
  assert.equal((await service.methodRoundState()).rounds.size, 0)
})

void test('paired contracts normalize host learning drafts on both sides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-paired-case-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root, actor: { kind: 'runtime', id: 'paired-case-test' }, clock: () => 1000 })
  t.after(() => service.close())
  const requestRef = await service.putObject('paired-request', new TextEncoder().encode(canonicalize({ v: 1, purpose: 'fixture' })))
  const contract = admitRootTask({
    taskId: 'paired-task',
    spec: {
      goal: { summary: 'fixture', deliverable: 'fixture', scope: [], constraints: [] },
      criteria: [], inputs: [],
      outputs: [{ id: 'deliverable', path: 'result.txt', kind: 'file', role: 'deliverable', required: true }],
    },
    origin: { kind: 'root', purpose: 'evaluation', requestRef },
    method: candidate, template: { id: 'template', digest: candidate.digest },
    resources: { baseTools: [], skills: [], mcpServers: [] }, acceptance: ref('verifier'),
    environment: { seed: ref('seed'), profile: ref('profile') },
    limits: { maxRuns: 1, maxStepsPerRun: 1, maxTokens: 1000, deadlineAt: 5000, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 },
  })
  assert.deepEqual(contract.spec.outputs.map(output => output.id).slice(-2), ['__skill-drafts', '__mcp-drafts'])
  const caseRef = await freezeEvaluationCase(service, 'paired-case', evaluationCaseFromContract(contract))
  const slot: EvaluationSlot = {
    id: 'paired-slot', roundId: 'paired-round', taskId: contract.taskId, partition: 'evaluation',
    caseRef, arm: 'candidate', repetition: 0, method: candidate,
  }
  const state: TaskRunState = {
    tasks: new Map([[contract.taskId, {
      taskId: contract.taskId, contract, rootTaskId: contract.taskId, depth: 0, phase: 'closed' as const,
      runIds: [], childIds: [], closed: { outcome: 'verified' as const, reason: 'fixture', source: 'task/closed' as const, factDigest: ref('fact').digest },
    }]]),
    runs: new Map(), batches: new Map(),
  }
  await assertPairedEvaluationContracts(service, state, [slot], plan)
  const changed = sealTaskContract({
    v: contract.v, taskId: contract.taskId,
    spec: { ...contract.spec, goal: { ...contract.spec.goal, summary: 'different' } },
    origin: contract.origin, method: contract.method, template: contract.template,
    resources: contract.resources, acceptance: contract.acceptance,
    environment: contract.environment, limits: contract.limits,
  })
  const originalTask = state.tasks.get(contract.taskId)
  assert.ok(originalTask)
  const changedState: TaskRunState = {
    ...state,
    tasks: new Map([[changed.taskId, { ...originalTask, contract: changed }]]),
  }
  await assert.rejects(assertPairedEvaluationContracts(service, changedState, [slot], plan), /Paired Task differs/)
})

void test('ensureEvaluationSlots propagates host runner and request CAS failures unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-evaluation-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root, actor: { kind: 'runtime', id: 'evaluation-host-test' }, clock: () => 1000 })
  t.after(() => service.close())
  const slot = frozenLocalSlots('round-host', { cases: [ref('case')], trialsPerCase: 1 }, base, ref('candidate'))[0]
  const failure = new Error('native provider transport failed')
  await assert.rejects(ensureEvaluationSlots({
    service, slots: [slot],
    runTask: () => Promise.reject(failure),
    requestFor: runner,
  }), error => error === failure)
  assert.equal(service.facts().length, 0)
  assert.equal((await service.taskRunState([])).tasks.size, 0)

  const missingRef = ref('missing-request')
  const fake = fakeService(emptyState([closedTask(slot, evaluationContract(slot, missingRef))]))
  let casFailure: unknown
  try {
    await ensureEvaluationSlots({
      service: fake.service, slots: [slot],
      runTask: () => { throw new Error('missing request must not purchase') }, requestFor: runner,
    })
  } catch (error) {
    casFailure = error
  }
  assert.ok(casFailure instanceof Error)
  assert.match(casFailure.message, /Missing fake object/)
})
