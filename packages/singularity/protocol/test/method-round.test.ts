import assert from 'node:assert/strict'
import test from 'node:test'

import { sealFact } from '../src/fact.ts'
import type { Fact, FactPayloadMap, FactType } from '../src/fact.ts'
import { projectMethodRounds } from '../src/method-round.ts'
import type { Ref } from '../src/refs.ts'
import { validateRoundPlan } from '../src/round-plan.ts'
import type { RoundPlan } from '../src/round-plan.ts'

const ref = (id: string): Ref => ({ id, digest: `sha256:${'a'.repeat(64)}` })
const base = ref('base')
const candidate = ref('candidate')

const plan: RoundPlan = {
  v: 1,
  cases: [ref('case-a'), ref('case-b')],
  metric: { name: 'domain-quality' },
  thresholds: { minDelta: 1, maxRegression: 0 },
  trialsPerCase: 1,
  proposerBudget: { maxSteps: 2, maxTokens: 100, maxWallClockMs: 1000 },
  budget: { maxRuns: 6, maxTokens: 1000, maxWallClockMs: 5000, maxActiveRuns: 1 },
  validation: 'required-by-domain',
  validationCases: [ref('held-out')],
  claim: 'domain-evaluation',
  comparator: ref('comparator'),
  sourceSeed: ref('seed'),
  expectedPreviousActiveMethod: base,
}

function append<Type extends FactType>(facts: Fact[], type: Type, data: FactPayloadMap[Type]): void {
  facts.push(sealFact({
    v: 1,
    seq: facts.length,
    commandId: `command-${String(facts.length)}`,
    commandDigest: ref('command').digest,
    actor: { kind: 'runtime', id: 'round-test' },
    at: 1000,
    prev: facts.at(-1)?.digest ?? null,
    type,
    data,
  }))
}

function initial(): Fact[] {
  const facts: Fact[] = []
  append(facts, 'method/registered', { revision: base })
  append(facts, 'method/activated', { next: base, approval: ref('initial-approval') })
  append(facts, 'rsi/trace-sealed', {
    rootTaskId: 'root', trace: ref('trace'),
    usage: { inputTokens: 10, outputTokens: 1, steps: 1, unknownRequests: 0 }, sessionCuts: [],
  })
  append(facts, 'rsi/round-opened', {
    roundId: 'round', sourceTrace: ref('trace'), baseMethod: base, plan: ref('plan'), proposerSessionId: 'proposer',
  })
  return facts
}

void test('RoundPlan freezes complete multi-case and independent validation purchase', () => {
  assert.deepEqual(validateRoundPlan(plan), plan)
  assert.throws(() => validateRoundPlan({ ...plan, budget: { ...plan.budget, maxRuns: 5 } }), /every frozen slot/)
  assert.throws(() => validateRoundPlan({ ...plan, validationCases: [plan.cases[0]] }), /distinct/)
  assert.throws(() => validateRoundPlan({ ...plan, validationCases: [] }), /independent/)
  assert.throws(() => validateRoundPlan({ ...plan, validation: 'none', validationCases: [] }), /source-replay/)
  assert.throws(() => validateRoundPlan({ ...plan, unknown: true }))
})

void test('candidate-ready atomically registers candidate and closure leaves head unchanged', () => {
  const facts = initial()
  append(facts, 'rsi/proposal-submitted', { roundId: 'round', patch: ref('patch') })
  append(facts, 'rsi/candidate-ready', { roundId: 'round', patch: ref('patch'), precheckReceipt: ref('precheck'), candidateMethod: candidate })
  append(facts, 'rsi/round-closed', { roundId: 'round', outcome: 'improved', comparisonRef: ref('comparison') })
  const state = projectMethodRounds(facts, new Map([['plan', plan]]))
  assert.deepEqual(state.productionHead, base)
  assert.deepEqual(state.methods.get(candidate.id), candidate)
  assert.equal(state.rounds.get('round')?.status, 'closed')
  append(facts, 'method/activated', { previous: base, expectedPrevious: base, next: candidate, approval: ref('approval'), evaluationRef: ref('comparison') })
  assert.deepEqual(projectMethodRounds(facts, new Map([['plan', plan]])).productionHead, candidate)
  append(facts, 'method/activated', { previous: base, expectedPrevious: base, next: base, approval: ref('stale-approval') })
  assert.throws(() => projectMethodRounds(facts, new Map([['plan', plan]])), /expected head/)
})

void test('each Round has one proposal and a consecutive Round needs a new sealed root', () => {
  const facts = initial()
  append(facts, 'rsi/proposal-submitted', { roundId: 'round', patch: ref('patch') })
  append(facts, 'rsi/proposal-submitted', { roundId: 'round', patch: ref('patch-2') })
  assert.throws(() => projectMethodRounds(facts, new Map([['plan', plan]])), /another proposal/)
  facts.pop()
  append(facts, 'rsi/round-closed', { roundId: 'round', outcome: 'insufficient-evidence', reason: 'no-candidate' })
  append(facts, 'rsi/round-opened', { roundId: 'round-2', sourceTrace: ref('trace'), baseMethod: base, plan: ref('plan'), proposerSessionId: 'proposer-2' })
  assert.throws(() => projectMethodRounds(facts, new Map([['plan', plan]])), /new sealed root/)
})

void test('a new sealed root and current active head permit a second completed Round', () => {
  const facts = initial()
  append(facts, 'rsi/proposal-submitted', { roundId: 'round', patch: ref('patch') })
  append(facts, 'rsi/candidate-ready', { roundId: 'round', patch: ref('patch'), precheckReceipt: ref('precheck'), candidateMethod: candidate })
  append(facts, 'rsi/round-closed', { roundId: 'round', outcome: 'improved', comparisonRef: ref('comparison') })
  append(facts, 'method/activated', { previous: base, expectedPrevious: base, next: candidate, approval: ref('approval'), evaluationRef: ref('comparison') })
  append(facts, 'rsi/trace-sealed', { rootTaskId: 'root-2', trace: ref('trace-2'), usage: { inputTokens: 10, outputTokens: 1, steps: 1, unknownRequests: 0 }, sessionCuts: [] })
  const secondPlan = { ...plan, expectedPreviousActiveMethod: candidate }
  append(facts, 'rsi/round-opened', { roundId: 'round-2', sourceTrace: ref('trace-2'), baseMethod: candidate, plan: ref('plan-2'), proposerSessionId: 'proposer-2' })
  append(facts, 'rsi/proposal-submitted', { roundId: 'round-2', patch: ref('patch-2') })
  append(facts, 'rsi/candidate-ready', { roundId: 'round-2', patch: ref('patch-2'), precheckReceipt: ref('precheck-2'), candidateMethod: ref('candidate-2') })
  append(facts, 'rsi/round-closed', { roundId: 'round-2', outcome: 'no-improvement', comparisonRef: ref('comparison-2') })
  const state = projectMethodRounds(facts, new Map([['plan', plan], ['plan-2', secondPlan]]))
  assert.deepEqual(state.productionHead, candidate)
  assert.equal(state.rounds.size, 2)
  assert.equal(state.rounds.get('round-2')?.closed?.outcome, 'no-improvement')
  assert.deepEqual(state.rounds.get('round-2')?.baseMethod, candidate)
})
