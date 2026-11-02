import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeAcceptanceChecks, taskProposalSchema, taskSpecSchema, validatePublicReceipt,
  sealPublicReceipt,
} from '../src/index.ts'
import type { ExecutableCheck, TaskCriterion } from '../src/index.ts'

const ref = { id: 'recipe', digest: `sha256:${'a'.repeat(64)}` }
const check = (checkId: string): ExecutableCheck => ({ checkId, recipeRef: ref, params: {} })
const base: TaskCriterion[] = [
  { id: 'fixed', statement: 'Fixed required behavior.', required: true, checks: [check('baseline')] },
  { id: 'local', statement: 'Frozen local task goal.', required: true, checks: [] },
]
const goal = { summary: 'work', deliverable: 'result', scope: [], constraints: [] }

void test('checks preserve template obligations, append in order, and reject changes before admission', () => {
  const before = structuredClone(base)
  const additions = [{ criterionId: 'fixed', checks: [check('extra')] }, { criterionId: 'local', checks: [check('local')] }]
  assert.deepEqual(mergeAcceptanceChecks(base, additions).map(criterion => criterion.checks.map(check => check.checkId)), [['baseline', 'extra'], ['local']])
  assert.deepEqual(base, before)
  for (const groups of [[], [{ criterionId: 'unknown', checks: [check('unknown')] }],
    [...additions, additions[0]], [{ criterionId: 'local', checks: [check('baseline')] }]]) {
    assert.throws(() => mergeAcceptanceChecks(base, groups), { code: 'INVALID_ARGUMENT' })
  }
})

void test('every frozen Task has required executable checks and unique check identities', () => {
  const spec = { goal, inputs: [], outputs: [], criteria: base }
  assert.equal(taskSpecSchema.safeParse(spec).success, false)
  assert.equal(taskSpecSchema.safeParse({ ...spec, criteria: [] }).success, false)
  assert.equal(taskSpecSchema.safeParse({ ...spec, criteria: [{ ...base[0], required: false }] }).success, false)
  assert.equal(taskSpecSchema.safeParse({ ...spec, criteria: [base[0], { ...base[1], checks: [check('baseline')] }] }).success, false)
  assert.equal(taskSpecSchema.safeParse({ ...spec, criteria: mergeAcceptanceChecks(base, [{ criterionId: 'local', checks: [check('local')] }]) }).success, true)
})

void test('proposals require complete check groups and accept no command or name authority', () => {
  const proposal = { goal, inputs: [], acceptanceChecks: [{ criterionId: 'task-goal', checks: [check('behavior')] }] }
  assert.equal(taskProposalSchema.safeParse(proposal).success, true)
  for (const acceptanceChecks of [[{ criterionId: 'task-goal', checks: [] }], [{ criterionId: '', checks: [check('behavior')] }],
    [{ criterionId: 'task-goal', checks: [{ checkId: 'behavior', recipe: 'name', params: {} }] }],
    [{ criterionId: 'task-goal', checks: [{ ...check('behavior'), displayCommand: ['true'] }] }]]) {
    assert.equal(taskProposalSchema.safeParse({ ...proposal, acceptanceChecks }).success, false)
  }
})

void test('receipt check results cover the contract exactly and review cannot override failed checks', () => {
  const requiredCriteria = [{ ...base[0], checks: [check('first'), check('second')] }]
  const expected = { provider: ref, operationId: 'verify', contractDigest: ref.digest, inputDigests: [], outputDigests: [], requiredCriteria }
  const results = ['first', 'second'].map(checkId => ({ checkId, verdict: 'pass' as const, reportRef: ref }))
  const receipt = (checks: unknown, verdict = 'pass') => sealPublicReceipt({ v: 1, provider: ref,
    operationId: 'verify', contractDigest: ref.digest, inputDigests: [], outputDigests: [],
    criteria: [{ id: 'fixed', verdict, reason: 'Independent finding.', checks }], exit: { code: 0, signal: null }, timedOut: false })
  assert.equal(validatePublicReceipt(receipt(results), expected).verdict, 'verified')
  for (const checks of [[], results.slice(1), [...results].reverse(), [results[0], results[0]], [...results, results[0]],
    [results[0], { ...results[1], verdict: 'fail' }], [results[0], { ...results[1], verdict: 'invalid' }]]) {
    assert.equal(validatePublicReceipt(receipt(checks), expected).verdict, 'invalid')
  }
  assert.equal(validatePublicReceipt(receipt(results, 'fail'), expected).verdict, 'failed')
})
