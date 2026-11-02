import { fileURLToPath } from 'node:url'
import { canonicalize, computeDigest, parseJsonText, sealPublicCheckReport, sealPublicReceipt } from '@singularity/protocol'
import type { JsonValue, PublicReceipt, Ref, RoundPlan, TaskSpec, VerifyRequest } from '@singularity/protocol'

export * from './method.ts'

export interface InventoryCase {
  readonly v: 1
  readonly id: string
  readonly csv: string
}

export const INVENTORY_CASES: readonly InventoryCase[] = [
  { v: 1, id: 'returns', csv: 'sku,delta\nBOLT,8\nNUT,5\nBOLT,-3\nNUT,2\nWASHER,0\n' },
  { v: 1, id: 'cancellations', csv: 'sku,delta\nGEAR,21\nAXLE,-4\nGEAR,-21\nAXLE,12\nPIN,-2\n' },
  { v: 1, id: 'reordered', csv: 'sku,delta\nZ9,10\nA1,3\nZ9,-12\nA1,-1\nM4,7\nM4,5\n' },
]

export interface InventoryReport {
  readonly rowCount: number
  readonly totals: readonly { readonly sku: string; readonly quantity: number }[]
}

/** Domain algorithm; the framework never interprets CSV or inventory metrics. */
export function reconcileInventory(csv: string): InventoryReport {
  const lines = csv.trimEnd().split(/\r?\n/)
  if (lines.shift() !== 'sku,delta') throw new Error('CSV header must be sku,delta')
  const totals = new Map<string, number>()
  for (const line of lines) {
    const parts = line.split(',')
    const sku = parts.at(0), rawDelta = parts.at(1)
    if (parts.length !== 2 || sku === undefined || rawDelta === undefined || !/^[A-Z][A-Z0-9-]*$/.test(sku)
      || !/^-?(?:0|[1-9]\d*)$/.test(rawDelta)) throw new Error('Invalid inventory row')
    const delta = Number(rawDelta)
    const quantity = (totals.get(sku) ?? 0) + delta
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(quantity)) throw new Error('Inventory quantity exceeds integer precision')
    totals.set(sku, quantity)
  }
  return { rowCount: lines.length, totals: [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([sku, quantity]) => ({ sku, quantity })) }
}

export function inventoryTaskSpec(input: Ref): TaskSpec {
  return {
    goal: {
      summary: 'Reconcile the inventory transactions in transactions.csv. Sum signed integer delta by sku, retain zero totals, sort sku ascending, and write report.json as {"rowCount":number,"totals":[{"sku":string,"quantity":number}]}.',
      deliverable: 'report.json', scope: ['Public CSV inventory reconciliation'],
      constraints: ['Use integer arithmetic.', 'Include every row and every SKU, including zero and negative totals.', 'Do not change the input CSV.'],
    },
    criteria: [{ id: 'inventory-exact', statement: 'The frozen report contains the exact row count and sorted per-SKU integer totals for the frozen input CSV.', required: true, checks: [inventoryCheck()] }],
    inputs: [{ id: 'transactions', object: input, path: 'transactions.csv', access: 'copy-to-work' }],
    outputs: [{ id: 'report', path: 'report.json', kind: 'file', role: 'deliverable', required: true }],
  }
}

/** Public two-warehouse case: publication → regional aggregation → individual warehouse calculation. */
export function inventoryWarehouseTaskSpec(inputs: readonly Ref[]): TaskSpec {
  if (inputs.length !== 2) throw new Error('Warehouse network requires east and west input CSVs')
  const spec = inventoryTaskSpec(inputs[0])
  return { ...spec, goal: { ...spec.goal,
    summary: 'Publish the consolidated inventory of warehouse-east.csv and warehouse-west.csv. Count all data rows across both CSVs, sum signed deltas by SKU across warehouses, retain zero/negative totals, sort SKU ascending, and write report.json as {"rowCount":number,"totals":[{"sku":string,"quantity":number}]}.',
    scope: ['Two-warehouse inventory consolidation'], constraints: [...spec.goal.constraints, 'Every Task calculates its report from exactly its own declared CSV inputs.'] },
    inputs: inputs.map((object, index) => ({ id: index === 0 ? 'warehouse-east' : 'warehouse-west', object,
      path: index === 0 ? 'warehouse-east.csv' : 'warehouse-west.csv', access: 'copy-to-work' })) }
}

type PublicInventoryVerifyRequest = VerifyRequest & {
  readonly signal: AbortSignal
  readonly readObject: (ref: Ref, domain: 'object') => Promise<{ readonly bytes: Uint8Array }>
}

/** Independent acceptance sees frozen objects only, and produces no total verdict. */
export async function verifyInventory(request: PublicInventoryVerifyRequest, writer: { putObject(id: string, bytes: Uint8Array): Promise<Ref> }): Promise<PublicReceipt> {
  const deadlineAt = Math.min(request.task.limits.deadlineAt, Date.now() + INVENTORY_RECIPE.maxWallClockMs)
  const timeout = new DOMException('Inventory check execution deadline elapsed', 'TimeoutError')
  const checkDeadline = () => {
    request.signal.throwIfAborted()
    if (Date.now() >= deadlineAt) throw timeout
  }
  let passed = false
  let timedOut = false
  let comparedReports = 0
  let reason = 'The required inventory report is absent.'
  const required = request.task.spec.criteria.filter(criterion => criterion.required)
  try {
    checkDeadline()
    if (required.length > 0) {
      const inputs = request.task.spec.inputs
      const output = request.outputs.find(ref => ref.id.endsWith(':output:report'))
      if (inputs.length === 0) throw new Error('Inventory verifier requires the frozen input CSV.')
      const rows: string[] = []
      for (const input of inputs) {
        const csv = new TextDecoder('utf-8', { fatal: true }).decode((await request.readObject(input.object, 'object')).bytes)
        checkDeadline()
        // Each declared source has its own header; direct child artifacts remain supporting inputs.
        reconcileInventory(csv)
        rows.push(...csv.trimEnd().split(/\r?\n/).slice(1))
      }
      const expected = reconcileInventory(`sku,delta\n${rows.join('\n')}\n`)
      if (output !== undefined) {
        comparedReports = 1
        // A failed CAS read is infrastructure invalid, not a zero domain score.
        const bytes = (await request.readObject(output, 'object')).bytes
        checkDeadline()
        try {
          const actual = parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          passed = canonicalize(actual) === canonicalize(expected)
          reason = passed ? 'Exact row count and sorted inventory totals match the frozen CSV.' : 'Inventory totals, order, row count or output structure differ from the frozen CSV.'
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
      }
    }
    checkDeadline()
  } catch (error) {
    request.signal.throwIfAborted()
    if (error !== timeout) throw error
    timedOut = true
    reason = timeout.message
  }
  const criteria = await Promise.all(required.map(async criterion => {
    request.signal.throwIfAborted()
    const supported = criterion.id === 'inventory-exact' || criterion.id === 'task-goal'
    const verdict = timedOut || !supported ? 'invalid' as const : passed ? 'pass' as const : 'fail' as const
    const checks = await Promise.all(criterion.checks.map(async check => {
      if (check.recipeRef.id !== INVENTORY_RECIPE_REF.id || check.recipeRef.digest !== INVENTORY_RECIPE_REF.digest) throw new Error('Unsupported inventory recipe')
      const report = sealPublicCheckReport({ v: 1, operationId: request.operationId, contractDigest: request.task.digest,
        criterionId: criterion.id, checkId: check.checkId, recipeRef: check.recipeRef,
        inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
        exit: { code: timedOut ? null : 0, signal: null }, timedOut, verdict, data: { comparedReports, matched: passed, reason } })
      return { checkId: check.checkId, verdict, reportRef: await writer.putObject(`${request.operationId}:${criterion.id}:${check.checkId}`, new TextEncoder().encode(canonicalize(report))) }
    }))
    return { id: criterion.id, verdict, reason: supported ? reason : `Inventory verifier does not implement criterion ${criterion.id}.`, checks,
      ...(supported && !timedOut ? { metric: { name: 'inventory-correct', unit: 'fraction', value: passed ? 1 : 0 } } : {}) }
  }))
  request.signal.throwIfAborted()
  return sealPublicReceipt({
    v: 1, provider: request.task.acceptance, operationId: request.operationId, contractDigest: request.task.digest,
    inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
    criteria,
    exit: { code: 0, signal: null }, timedOut: false,
  })
}

/** Public exact comparison recipe; the same rules back local feedback and frozen verification. */
export const INVENTORY_RECIPE = {
  v: 1, name: 'inventory-exact', entrypoint: [process.execPath, fileURLToPath(new URL('./check-cli.js', import.meta.url))], dependencies: [],
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  resultSchema: { type: 'object', required: ['comparedReports', 'matched', 'reason'],
    properties: { comparedReports: { type: 'integer', minimum: 0 }, matched: { type: 'boolean' }, reason: { type: 'string' } } },
  publicDataPolicy: 'Every declared CSV row and SKU, retaining zero/negative totals; exact JSON shape and ascending SKU order.',
  passRule: 'The independently computed report equals the frozen candidate report exactly.', maxWallClockMs: 30_000,
}
export const INVENTORY_RECIPE_REF: Ref = { id: 'inventory:recipe:exact', digest: computeDigest('object', INVENTORY_RECIPE) }
export const inventoryCheck = () => ({ checkId: 'inventory-exact', recipeRef: INVENTORY_RECIPE_REF, params: {} })
export function describeInventoryCheck({ spec }: { spec: Pick<TaskSpec, 'outputs'> & { readonly inputs: readonly { readonly path: string }[] } }) {
  if (!spec.outputs.some(output => output.id === 'report' && output.path === 'report.json' && output.kind === 'file')) throw new Error('Inventory checks require declared CSV inputs and report.json file output')
  return { displayCommand: [...INVENTORY_RECIPE.entrypoint, ...spec.inputs.flatMap(input => ['--input', input.path]), '--candidate', 'report.json', '--report', 'checks/inventory.json'],
    expectedReport: { comparedReports: 1, matched: true, reason: 'Exact report equality.' } }
}

/** Public domain assets have explicit identities that can be frozen into CAS. */
export const INVENTORY_VERIFIER_ASSET: JsonValue = {
  v: 1, domain: 'public-inventory', provider: 'inventory-verifier/v1',
  publicBoundary: 'All case inputs and report criteria are public; verifier reads frozen CAS only.',
  checkRecipes: [INVENTORY_RECIPE_REF], checkResources: [],
}

export const INVENTORY_COMPARATOR_ASSET: JsonValue = {
  v: 1, domain: 'public-inventory', comparator: 'inventory-report/v2',
  metrics: ['inventory-correctness: mean exact-report correctness',
    'inventory-reported-tokens: mean subtree reported tokens, with exact correctness required on every trial'],
  cost: 'reported input plus output tokens across each complete Task subtree, including summaries',
}

/** Choose the objective before opening a Round; acceptance remains exact correctness. */
export function inventoryMetric(plan: RoundPlan) {
  const costObjective = plan.metric.name === 'inventory-reported-tokens'
  return { name: costObjective ? 'inventory-reported-tokens' : 'inventory-correctness',
    direction: costObjective ? 'lower-is-better' as const : 'higher-is-better' as const,
    unit: costObjective ? 'reported-tokens' : 'fraction', costObjective }
}

export interface InventoryTrialEvidence {
  readonly caseRef: Ref
  readonly arm: 'baseline' | 'candidate'
  readonly receipt: PublicReceipt
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
}

/** Domain metric and aggregation, independent of Method and worker transcripts. */
export function compareInventory(plan: RoundPlan, evidence: readonly InventoryTrialEvidence[]) {
  if (plan.metric.name !== 'inventory-correctness' && plan.metric.name !== 'inventory-reported-tokens') {
    return { comparable: false as const, reason: 'unsupported-inventory-metric' }
  }
  const costObjective = inventoryMetric(plan).costObjective
  if (costObjective && evidence.some(trial => trial.receipt.criteria.find(value => value.id === 'inventory-exact')?.verdict !== 'pass')) {
    return { comparable: false as const, reason: 'exact-correctness-required-for-cost' }
  }
  const cases = [...plan.cases, ...plan.validationCases].map(caseRef => {
    const score = (arm: 'baseline' | 'candidate') => {
      const trials = evidence.filter(trial => trial.caseRef.digest === caseRef.digest && trial.caseRef.id === caseRef.id && trial.arm === arm)
      if (trials.length !== plan.trialsPerCase) throw new Error('Inventory comparison requires every frozen repetition')
      if (costObjective) return trials.reduce((sum, trial) => sum + trial.usage.inputTokens + trial.usage.outputTokens, 0) / trials.length
      return trials.reduce((sum, trial) => sum + (trial.receipt.criteria.find(value => value.id === 'inventory-exact')?.verdict === 'pass' ? 1 : 0), 0) / trials.length
    }
    const baseline = score('baseline'), candidate = score('candidate')
    const delta = (candidate - baseline) * (costObjective ? -1 : 1)
    return { caseRef, baseline, candidate, verdict: delta > 0 ? 'improved' : delta < 0 ? 'regression' : 'equal' }
  })
  const tokens = (arm: 'baseline' | 'candidate') => evidence.filter(trial => trial.arm === arm)
    .reduce((sum, trial) => sum + trial.usage.inputTokens + trial.usage.outputTokens, 0)
  return { comparable: true as const, cases,
    aggregateDelta: cases.reduce((sum, value) => sum + (value.candidate - value.baseline) * (costObjective ? -1 : 1), 0) / cases.length,
    cost: { baseline: tokens('baseline'), candidate: tokens('candidate'), unit: 'reported-tokens' } }
}
