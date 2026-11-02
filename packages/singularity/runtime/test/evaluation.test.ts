import {checkRecipeRef} from './check-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalize, sealEvidence, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { Ref, RoundPlan, TaskRunState, TaskState } from '@singularity/protocol'

import { compareEvaluation, frozenEvaluationSlots, readEvaluationManifest } from '../src/evaluation.ts'
import type { EvaluationComparator, EvaluationManifest, EvaluationSlotResult, EvaluationUsage } from '../src/evaluation.ts'
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
const usage: EvaluationUsage = { inputTokens: 20, outputTokens: 5, steps: 2, unknownRequests: 0, complete: true }

function manifest(policy: RoundPlan = plan): EvaluationManifest {
  const slots: EvaluationSlotResult[] = frozenEvaluationSlots('round', policy, base, candidate).map(slot => {
    const receipt = sealPublicReceipt({
      v: 1, provider: ref('verifier'), operationId: slot.id, contractDigest: ref('contract').digest,
      inputDigests: [], outputDigests: [], criteria: [{checks: [], id: 'quality', verdict: 'pass', reason: 'fixture', metric: { name: 'quality', unit: 'points', value: 1 } }],
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
      publicEvidence: {checkReports: [],
        slotId: slot.id, taskId: slot.taskId, caseRef: slot.caseRef, partition: slot.partition, arm: slot.arm, repetition: slot.repetition,
        verdict: 'verified', evidenceRef: ref(`${slot.id}:evidence`), evidence, receipt, usage,
      },
    }
  })
  return { slots, runCount: slots.length, complete: true, usage: { ...usage, inputTokens: usage.inputTokens * slots.length, outputTokens: usage.outputTokens * slots.length } }
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
  assert.deepEqual(slots.slice(0, 4).map(slot => [slot.arm, slot.repetition]), [['baseline', 0], ['candidate', 0], ['baseline', 1], ['candidate', 1]])
  assert.equal(slots.filter(slot => slot.partition === 'validation').length, 4)
  assert.ok(slots.every(slot => slot.method.id === (slot.arm === 'baseline' ? base.id : candidate.id)))
})

void test('independent comparator is bounded by frozen minimum delta and every case regression', () => {
  const input = manifest()
  const result = compareEvaluation('round', ref('plan'), plan, input, comparator())
  assert.equal(result.outcome, 'improved')
  assert.equal(result.completeCases, 3)
  assert.equal(result.worstRegression, 0)
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

void test('unknown usage cannot establish a cost improvement or pass a hard cost threshold', () => {
  const input = { ...manifest(), usage: { ...usage, unknownRequests: 1 } }
  assert.equal(compareEvaluation('round', ref('plan'), plan, input, comparator()).outcome, 'improved')
  assert.equal(compareEvaluation('round', ref('plan'), plan, input, comparator([2, 2, 2], true)).outcome, 'insufficient-evidence')
  const costPlan = { ...plan, thresholds: { ...plan.thresholds, maxRelativeCostIncrease: 0.1 } }
  assert.equal(compareEvaluation('round', ref('plan'), costPlan, input, comparator()).reason, 'unknown-cost')
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
    spec: { goal: { summary: 'fixture', deliverable: 'fixture', scope: [], constraints: [] }, criteria: [{id:'task-goal',statement:'The local result is checked.',required:true,checks:[{checkId:'task-goal',recipeRef:checkRecipeRef,params:{}}]}], inputs: [], outputs: [] },
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
  assert.deepEqual(result.usage, { inputTokens: 33, outputTokens: 7, steps: 4, unknownRequests: 1, complete: true })
  assert.equal(result.slots[0].publicEvidence, undefined)
})
