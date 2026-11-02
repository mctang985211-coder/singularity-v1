import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { admitRootTask, computeDigestBytes, sealPublicReceipt, sealTaskContract } from '@singularity/protocol'
import type { PublicReceipt, Ref, RoundPlan, TaskContract } from '@singularity/protocol'

import { compareInventory, inventoryMetric, inventoryTaskSpec, inventoryWarehouseTaskSpec, verifyInventory, inventoryCheck } from '../src/index.ts'
import type { InventoryTrialEvidence } from '../src/index.ts'

const encoder = new TextEncoder()
const csv = 'sku,delta\nGEAR,21\nAXLE,-4\nGEAR,-21\nAXLE,12\nPIN,-2\n'
const report = { rowCount: 5, totals: [{ sku: 'AXLE', quantity: 8 }, { sku: 'GEAR', quantity: 0 }, { sku: 'PIN', quantity: -2 }] }
const ref = (id: string, text = id): Ref => ({ id, digest: computeDigestBytes('object', encoder.encode(text)) })
const input = ref('case:input', csv)
const output = ref('inventory-task:output:report', JSON.stringify(report))
const provider = ref('inventory-verifier')
const writer = { putObject: (id: string, bytes: Uint8Array) => Promise.resolve({ id, digest: computeDigestBytes('object', bytes) }) }

function contract(): TaskContract {
  return admitRootTask({
    taskId: 'inventory-task', spec: inventoryTaskSpec(input),
    origin: { kind: 'root', purpose: 'work', requestRef: ref('request') },
    method: ref('method'), template: { id: 'template', digest: ref('method').digest },
    resources: { baseTools: [], skills: [], mcpServers: [] }, acceptance: provider,
    environment: { seed: ref('seed'), profile: ref('profile') },
    limits: { maxRuns: 1, maxStepsPerRun: 10, maxTokens: 10_000, deadlineAt: 2_000_000_000_000,
      maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 },
  })
}

async function verify(text: string, task = contract(), outputs: readonly Ref[] = [output]) {
  const reads: Ref[] = []
  const receipt = await verifyInventory({ operationId: 'inventory-run:verify', task, signal: new AbortController().signal,
    inputs: [input, ref('supporting-child-output')], outputs,
    readObject(value) {
      reads.push(value)
      assert.ok(value.id === input.id || value.id === output.id, 'verifier reads only its frozen CSV and declared report')
      return Promise.resolve({ bytes: encoder.encode(value.id === input.id ? csv : text) })
    },
  }, writer)
  return { receipt, reads }
}

void test('inventory verifier checks frozen CSV and report, retains all public receipt identities, and ignores child artifacts', async () => {
  const { receipt, reads } = await verify(JSON.stringify(report))
  assert.deepEqual(reads, [input, output])
  assert.equal(receipt.operationId, 'inventory-run:verify')
  assert.deepEqual(receipt.provider, provider)
  assert.equal(receipt.contractDigest, contract().digest)
  assert.deepEqual(receipt.inputDigests, [input.digest, ref('supporting-child-output').digest])
  assert.deepEqual(receipt.outputDigests, [output.digest])
  assert.equal(receipt.criteria[0]?.verdict, 'pass')
  assert.equal(receipt.criteria[0]?.metric?.value, 1)
})

void test('warehouse and regional acceptance use exactly each Task declared CSVs and combine overlapping zero totals', async () => {
  const westCsv = 'sku,delta\nAXLE,-8\nBOLT,4\nPIN,2\n'
  const west = ref('warehouse-west', westCsv)
  const combined = { rowCount: 8, totals: [{ sku: 'AXLE', quantity: 0 }, { sku: 'BOLT', quantity: 4 },
    { sku: 'GEAR', quantity: 0 }, { sku: 'PIN', quantity: 0 }] }
  const { digest, ...payload } = contract()
  void digest
  const task = sealTaskContract({ ...payload, spec: inventoryWarehouseTaskSpec([input, west]) })
  const reads: string[] = []
  const receipt = await verifyInventory({ task, operationId: 'network:verify', signal: new AbortController().signal, inputs: [input, west, ref('child-report')], outputs: [output],
    readObject(value) {
      reads.push(value.id)
      const content = value.id === input.id ? csv : value.id === west.id ? westCsv : JSON.stringify(combined)
      return Promise.resolve({ bytes: encoder.encode(content) })
    },
  }, writer)
  assert.equal(receipt.criteria[0]?.verdict, 'pass')
  assert.deepEqual(reads, [input.id, west.id, output.id])
  const leaf = sealTaskContract({ ...payload, spec: { ...task.spec, inputs: [task.spec.inputs[0]] } })
  const result = await verify(JSON.stringify(report), leaf)
  assert.equal(result.receipt.criteria[0]?.verdict, 'pass', 'leaf acceptance does not require its parent warehouse inputs')
})

for (const [label, value] of [
  ['omitted zero SKU', { ...report, totals: report.totals.filter(total => total.quantity !== 0) }],
  ['wrong row count', { ...report, rowCount: 4 }],
  ['wrong order', { ...report, totals: [...report.totals].reverse() }],
  ['extra output field', { ...report, unchecked: true }],
] as const) {
  void test(`inventory verifier rejects ${label}`, async () => {
    const { receipt } = await verify(JSON.stringify(value))
    assert.equal(receipt.criteria[0]?.verdict, 'fail')
    assert.equal(receipt.criteria[0]?.metric?.value, 0)
  })
}

void test('inventory verifier reports malformed or missing report as a failed criterion', async () => {
  const malformed = await verify('{"rowCount":5,"rowCount":0,"totals":[]}')
  assert.equal(malformed.receipt.criteria[0]?.verdict, 'fail')
  const missing = await verify('', contract(), [])
  assert.equal(missing.receipt.criteria[0]?.verdict, 'fail')
  assert.deepEqual(missing.reads, [input])
})

void test('inventory CAS failures propagate to host invalid instead of becoming scored domain failures', async () => {
  for (const failed of [input, output]) {
    await assert.rejects(verifyInventory({ operationId: 'inventory-run:verify', task: contract(), signal: new AbortController().signal, inputs: [input], outputs: [output],
      readObject(value) {
        if (value.id === failed.id) throw new Error('CAS read unavailable')
        return Promise.resolve({ bytes: encoder.encode(csv) })
      },
    }, writer), /CAS read unavailable/)
  }
})

void test('inventory own execution deadline waits for the pending read and returns invalid without a score', async () => {
  const { digest, ...payload } = contract()
  void digest
  const task = sealTaskContract({ ...payload, limits: { ...payload.limits, deadlineAt: Date.now() + 20 } })
  let readFinished = false
  const reports: Record<string, unknown>[] = []
  const receipt = await verifyInventory({ operationId: 'inventory-timeout:verify', task, signal: new AbortController().signal,
    inputs: [input], outputs: [output],
    async readObject() {
      await delay(50)
      readFinished = true
      return { bytes: encoder.encode(csv) }
    },
  }, { putObject(id, bytes) {
    reports.push(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>)
    return writer.putObject(id, bytes)
  } })
  assert.equal(readFinished, true)
  assert.equal(receipt.criteria[0].verdict, 'invalid')
  assert.equal(receipt.criteria[0].metric, undefined)
  assert.equal(receipt.criteria[0].score, undefined)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].timedOut, true)
  assert.equal(reports[0].verdict, 'invalid')
  assert.deepEqual(reports[0].exit, { code: null, signal: null })
})

void test('inventory external cancellation and an unrelated TimeoutError preserve their exact causes', async () => {
  const cancellation = new AbortController(), reason = new Error('operator cancellation')
  let finishRead!: () => void
  let readFinished = false
  const pending = verifyInventory({ operationId: 'inventory-cancel:verify', task: contract(), signal: cancellation.signal,
    inputs: [input], outputs: [output], readObject: () => new Promise(resolve => {
      finishRead = () => { readFinished = true; resolve({ bytes: encoder.encode(csv) }) }
    }) }, writer)
  const rejected = assert.rejects(pending, error => error === reason)
  cancellation.abort(reason)
  assert.equal(readFinished, false)
  finishRead()
  await rejected
  assert.equal(readFinished, true)
  const cause = new DOMException('upstream storage timeout', 'TimeoutError')
  await assert.rejects(verifyInventory({ operationId: 'inventory-host-error:verify', task: contract(), signal: new AbortController().signal,
    inputs: [input], outputs: [output], readObject: () => Promise.reject(cause) }, writer), error => error === cause)
})

void test('inventory verifier cannot declare an unimplemented required criterion passed', async () => {
  const { digest, ...payload } = contract()
  void digest
  const task = sealTaskContract({ ...payload, spec: { ...payload.spec,
    criteria: [...payload.spec.criteria, { id: 'unimplemented-check', statement: 'A domain check this provider does not implement.', required: true, checks: [{ ...inventoryCheck(), checkId: 'unknown' }] }],
  } })
  const { receipt } = await verify(JSON.stringify(report), task)
  assert.equal(receipt.criteria.find(criterion => criterion.id === 'inventory-exact')?.verdict, 'pass')
  assert.equal(receipt.criteria.find(criterion => criterion.id === 'unimplemented-check')?.verdict, 'invalid')
  assert.equal(receipt.criteria.find(criterion => criterion.id === 'unimplemented-check')?.metric, undefined)
})

const publicCase = ref('case:public')
const validationCase = ref('case:validation')
const plan: RoundPlan = {
  v: 1, cases: [publicCase], validationCases: [validationCase], metric: { name: 'inventory-correctness' },
  thresholds: { minDelta: 0.1, maxRegression: 0, maxRelativeCostIncrease: 1 }, trialsPerCase: 2,
  proposerBudget: { maxSteps: 6, maxTokens: 24_000, maxWallClockMs: 180_000 },
  budget: { maxRuns: 8, maxTokens: 100_000, maxWallClockMs: 600_000, maxActiveRuns: 1 },
  validation: 'required-by-domain', claim: 'domain-evaluation', comparator: ref('comparator'),
  sourceSeed: ref('seed'), expectedPreviousActiveMethod: ref('method'),
}

function receipt(passed: boolean): PublicReceipt {
  return sealPublicReceipt({ v: 1, provider, operationId: 'trial:verify', contractDigest: contract().digest,
    inputDigests: [input.digest], outputDigests: [output.digest],
    criteria: [{ id: 'inventory-exact', verdict: passed ? 'pass' : 'fail', reason: 'Public exact-report comparison.', checks: [{ checkId: 'inventory-exact', verdict: passed ? 'pass' : 'fail', reportRef: ref('report') }] }],
    exit: { code: 0, signal: null }, timedOut: false,
  })
}

function trials(): InventoryTrialEvidence[] {
  return [publicCase, validationCase].flatMap((caseRef, caseIndex) => [0, 1].flatMap(repetition => [
    { caseRef, arm: 'baseline' as const, receipt: receipt(caseIndex === 1 || repetition === 0), usage: { inputTokens: 10, outputTokens: 2 } },
    { caseRef, arm: 'candidate' as const, receipt: receipt(caseIndex === 0 || repetition === 0), usage: { inputTokens: 12, outputTokens: 3 } },
  ]))
}

void test('inventory comparator includes every public and validation repetition, exposes regression, and totals reported arm costs', () => {
  const result = compareInventory(plan, [...trials()].reverse())
  assert.equal(result.comparable, true)
  assert.deepEqual(result.cases, [
    { caseRef: publicCase, baseline: 0.5, candidate: 1, verdict: 'improved' },
    { caseRef: validationCase, baseline: 1, candidate: 0.5, verdict: 'regression' },
  ])
  assert.equal(result.aggregateDelta, 0)
  assert.deepEqual(result.cost, { baseline: 48, candidate: 60, unit: 'reported-tokens' })
})

void test('inventory comparator refuses missing repetitions and mismatched frozen case identities', () => {
  assert.throws(() => compareInventory(plan, trials().slice(1)), /every frozen repetition/)
  assert.throws(() => compareInventory(plan, trials().map(trial => trial.caseRef.id === validationCase.id
    ? { ...trial, caseRef: { ...trial.caseRef, id: 'different-case-id' } } : trial)), /every frozen repetition/)
})

void test('a frozen cost objective can distinguish correct candidates after correctness saturates', () => {
  const costPlan = { ...plan, metric: { name: 'inventory-reported-tokens' } }
  const exact = trials().map(trial => ({ ...trial, receipt: receipt(true),
    usage: { inputTokens: trial.arm === 'baseline' ? 20 : 10, outputTokens: 2 } }))
  const correctness = compareInventory(plan, exact)
  assert.ok(correctness.comparable)
  assert.equal(correctness.aggregateDelta, 0)
  const cost = compareInventory(costPlan, exact)
  assert.ok(cost.comparable)
  assert.equal(cost.aggregateDelta, 10)
  assert.ok(cost.cases.every(value => value.baseline === 22 && value.candidate === 12 && value.verdict === 'improved'))
  assert.deepEqual(inventoryMetric(costPlan), { name: 'inventory-reported-tokens', direction: 'lower-is-better', unit: 'reported-tokens', costObjective: true })
  assert.deepEqual(compareInventory(costPlan, trials()), { comparable: false, reason: 'exact-correctness-required-for-cost' })
})
