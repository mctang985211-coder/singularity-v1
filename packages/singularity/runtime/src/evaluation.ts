import {
  canonicalize,
  MethodRoundError,
  computeDigest,
  cancellationCutSchema,
  evidenceSchema,
  evaluationMetricSchema,
  executionRecordSchema,
  parseProtocolValue,
  publicReceiptSchema,
  compositionSchema,
  validatePublicReceipt,
} from '@singularity/protocol'
import type {
  Evidence,
  PublicReceipt,
  Ref,
  RoundPlan,
  TaskRunState,
  UsageRecord,
} from '@singularity/protocol'

import { closeRsiRound, readRoundObject, readRoundPlan, requireRound } from './round.ts'
import type { RoundCommandContext } from './round.ts'
import { evaluationCaseFromContract, readEvaluationCase } from './evaluation-case.ts'
import type { CommandService } from './service.ts'
import { publicVerificationOf } from './verification.ts'

export interface EvaluationSlot {
  readonly id: string
  readonly roundId: string
  readonly taskId: string
  readonly partition: 'evaluation' | 'validation'
  readonly caseRef: Ref
  readonly arm: 'baseline' | 'candidate'
  readonly repetition: number
  readonly method: Ref
}

/** Deterministic plan order; missing or failed slots never disappear. */
export function frozenEvaluationSlots(roundId: string, plan: RoundPlan, base: Ref, candidate: Ref): readonly EvaluationSlot[] {
  const slots: EvaluationSlot[] = []
  for (const partition of ['evaluation', 'validation'] as const) {
    const cases = partition === 'evaluation' ? plan.cases : plan.validationCases
    for (const caseRef of cases) {
      for (let repetition = 0; repetition < plan.trialsPerCase; repetition += 1) {
        for (const arm of ['candidate', 'baseline'] as const) {
          const digest = computeDigest('object', { roundId, partition, caseRef, repetition, arm })
          const id = `${roundId}:slot:${digest.slice('sha256:'.length)}`
          slots.push({ id, roundId, taskId: `${id}:task`, partition, caseRef, arm, repetition, method: arm === 'baseline' ? base : candidate })
        }
      }
    }
  }
  return slots
}

export interface EvaluationUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly steps: number
  readonly unknownRequests: number
  readonly complete: boolean
  readonly cacheComplete: boolean
}

export interface PublicEvaluationEvidence {
  readonly slotId: string
  readonly taskId: string
  readonly caseRef: Ref
  readonly partition: EvaluationSlot['partition']
  readonly arm: EvaluationSlot['arm']
  readonly repetition: number
  readonly verdict: 'verified' | 'failed'
  readonly evidenceRef: Ref
  readonly evidence: Omit<Evidence, 'verification'> & {
    readonly verification: Omit<Evidence['verification'], 'privateReceipt'>
  }
  readonly receipt: PublicReceipt
  readonly usage: EvaluationUsage
}

export interface EvaluationSlotResult {
  readonly slot: EvaluationSlot
  readonly status: 'complete' | 'missing' | 'invalid' | 'cancelled'
  readonly usage: EvaluationUsage
  readonly publicEvidence?: PublicEvaluationEvidence
  readonly reason?: string
}

export interface EvaluationManifest {
  readonly slots: readonly EvaluationSlotResult[]
  readonly complete: boolean
  readonly runCount: number
  readonly usage: EvaluationUsage
}

/** Read only the journal's ordinary Tasks and their final independent receipts. */
export async function readEvaluationManifest(
  service: CommandService,
  slots: readonly EvaluationSlot[],
  priorState?: TaskRunState,
): Promise<EvaluationManifest> {
  const state = priorState ?? await service.taskRunState([])
  const results: EvaluationSlotResult[] = []
  const cancelledRecords = new Map<string, UsageRecord>()
  for (const fact of service.facts()) {
    if (fact.type !== 'task/closed' || fact.data.cancellationCutRef === undefined) continue
    const cut = parseProtocolValue(cancellationCutSchema, await readRoundObject(service, fact.data.cancellationCutRef))
    for (const entry of cut.affected) {
      if (entry.runId === undefined || entry.executionRecordRef === undefined) continue
      const record = parseProtocolValue(executionRecordSchema, await readRoundObject(service, entry.executionRecordRef))
      cancelledRecords.set(entry.runId, record.usage)
    }
  }
  let runCount = 0
  for (const slot of slots) {
    const task = state.tasks.get(slot.taskId)
    const runs = [...state.runs.values()].filter(run => state.tasks.get(run.taskId)?.rootTaskId === slot.taskId)
    runCount += runs.length
    const usage = emptyUsage()
    for (const run of runs) {
      if (run.closed?.usage !== undefined) addUsage(usage, run.closed.usage)
      else {
        const cancelled = cancelledRecords.get(run.runId)
        if (cancelled !== undefined) addUsage(usage, cancelled)
        else usage.complete = false
      }
    }
    if (task === undefined) {
      results.push({ slot, status: 'missing', usage, reason: 'not-started' })
      continue
    }
    const origin = task.contract.origin
    const request = origin.kind === 'root' ? await readRoundObject(service, origin.requestRef) : null
    const expectedRequest = { v: 1, roundId: slot.roundId, slot }
    if (origin.kind !== 'root' || origin.purpose !== 'evaluation'
      || canonicalize(request) !== canonicalize(expectedRequest) || !same(task.contract.method, slot.method)) {
      results.push({ slot, status: 'invalid', usage, reason: 'evaluation-admission-mismatch' })
      continue
    }
    if (task.phase !== 'closed' || runs.some(run => run.phase !== 'closed')
      || [...state.tasks.values()].some(descendant => descendant.rootTaskId === slot.taskId && descendant.phase !== 'closed')) {
      results.push({ slot, status: 'missing', usage, reason: 'not-terminal' })
      continue
    }
    const closure = service.facts().findLast(fact => fact.type === 'task/closed' && fact.data.taskId === slot.taskId)
    const decisiveId = closure?.type === 'task/closed' ? closure.data.decisiveRunId ?? task.runIds.at(-1) : undefined
    const decisive = decisiveId === undefined ? undefined : state.runs.get(decisiveId)
    const evidenceRef = decisive?.closed?.evidenceRef
    if (task.closed?.outcome === 'cancelled') {
      results.push({ slot, status: 'cancelled', usage, reason: task.closed.reason })
      continue
    }
    if (evidenceRef === undefined || task.closed?.outcome === 'invalid') {
      results.push({ slot, status: 'invalid', usage, reason: task.closed?.reason ?? 'missing-independent-evidence' })
      continue
    }
    const evidence = parseProtocolValue(evidenceSchema, await readRoundObject(service, evidenceRef, 'evidence'))
    const receipt = parseProtocolValue(publicReceiptSchema, await readRoundObject(service, evidence.verification.publicReceipt))
    const validated = validatePublicReceipt(receipt, {
      provider: task.contract.acceptance,
      operationId: evidence.verification.operationId,
      contractDigest: task.contract.digest,
      inputDigests: evidence.inputs.map(ref => ref.digest),
      outputDigests: evidence.outputs.map(ref => ref.digest),
      requiredCriteria: task.contract.spec.criteria.filter(criterion => criterion.required).map(criterion => criterion.id),
    })
    if (evidence.task.id !== slot.taskId || evidence.runId !== decisive?.runId
      || evidence.contractDigest !== task.contract.digest || !same(evidence.method, slot.method)
      || validated.verdict === 'invalid' || validated.verdict !== task.closed?.outcome) {
      results.push({ slot, status: 'invalid', usage, reason: 'independent-evidence-mismatch' })
      continue
    }
    const verification = publicVerificationOf(evidence.verification)
    const publicEvidence: PublicEvaluationEvidence = {
      slotId: slot.id, taskId: slot.taskId, caseRef: slot.caseRef, partition: slot.partition,
      arm: slot.arm, repetition: slot.repetition,
      verdict: task.closed.outcome === 'verified' ? 'verified' : 'failed',
      evidenceRef, evidence: { ...evidence, verification }, receipt, usage,
    }
    results.push({ slot, status: 'complete', usage, publicEvidence })
  }
  const usage = emptyUsage()
  for (const result of results) addUsage(usage, result.usage)
  return { slots: results, runCount, complete: results.every(result => result.status === 'complete'), usage }
}

export interface ComparisonMetric {
  readonly name: string
  readonly direction: 'higher-is-better' | 'lower-is-better'
  readonly unit: string
  readonly costObjective: boolean
}

export interface ComparedCase {
  readonly caseRef: Ref
  readonly baseline: number
  readonly candidate: number
  readonly verdict: string
}

export interface ComparisonCost {
  readonly baseline: number
  readonly candidate: number
  readonly unit: string
}

export interface TokenCostArm {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly uncachedInputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
}

export interface TokenCostReport {
  readonly complete: boolean
  readonly cacheComplete: boolean
  readonly baseline: TokenCostArm
  readonly candidate: TokenCostArm
}

/** Host-supplied quality comparison; domain bundles cannot inject a comparator. */
export interface EvaluationComparator {
  readonly asset: Ref
  describeMetric(plan: RoundPlan): ComparisonMetric
  compare(plan: RoundPlan, evidence: readonly PublicEvaluationEvidence[]):
    | { readonly comparable: true; readonly cases: readonly ComparedCase[]; readonly aggregateDelta: number; readonly cost?: ComparisonCost }
    | { readonly comparable: false; readonly reason: string }
}

export interface EvaluationComparison {
  readonly v: 1
  readonly roundId: string
  readonly plan: Ref
  readonly claim: RoundPlan['claim']
  readonly complete: boolean
  readonly completeCases: number
  readonly metric?: ComparisonMetric
  readonly aggregateDelta?: number
  readonly worstRegression?: number
  readonly cost?: ComparisonCost
  readonly cases: readonly ComparedCase[]
  readonly usage: EvaluationUsage
  readonly tokenCosts?: TokenCostReport
  readonly slots: readonly EvaluationSlotResult[]
  readonly missingOrInvalid: readonly string[]
  readonly outcome: 'improved' | 'no-improvement' | 'insufficient-evidence'
  readonly reason?: string
}

/** Comparator receives public receipts only; the host enforces frozen thresholds. */
export function compareEvaluation(
  roundId: string,
  planRef: Ref,
  plan: RoundPlan,
  manifest: EvaluationManifest,
  comparator: EvaluationComparator | undefined,
): EvaluationComparison {
  const missingOrInvalid = manifest.slots.filter(slot => slot.status !== 'complete').map(slot => slot.slot.id)
  const common = {
    v: 1 as const, roundId, plan: planRef, claim: plan.claim, complete: manifest.complete,
    completeCases: [...plan.cases, ...plan.validationCases].filter(caseRef => manifest.slots
      .filter(result => same(result.slot.caseRef, caseRef)).every(result => result.status === 'complete')).length,
    usage: manifest.usage, tokenCosts: tokenCostReport(manifest), slots: manifest.slots, missingOrInvalid,
  }
  const insufficient = (reason: string): EvaluationComparison => ({ ...common, cases: [], outcome: 'insufficient-evidence', reason })
  if (comparator === undefined || !same(comparator.asset, plan.comparator)) return insufficient('unsupported-comparator')
  if (!manifest.complete) return insufficient('missing-or-invalid-evidence')
  const metric = comparator.describeMetric(plan)
  if (!metric.name || !metric.unit || !['higher-is-better', 'lower-is-better'].includes(metric.direction)) {
    return insufficient('invalid-comparator-metric')
  }
  if (!manifest.usage.complete && (metric.costObjective || plan.thresholds.maxRelativeCostIncrease !== undefined)) {
    return insufficient('missing-cost')
  }
  const evidence = manifest.slots.flatMap(slot => slot.publicEvidence === undefined ? [] : [slot.publicEvidence])
  const compared = comparator.compare(plan, evidence)
  if (!compared.comparable) return insufficient(compared.reason)
  const expectedCases = [...plan.cases, ...plan.validationCases]
  if (!Number.isFinite(compared.aggregateDelta) || compared.cases.length !== expectedCases.length
    || expectedCases.some(ref => compared.cases.filter(value => same(value.caseRef, ref)).length !== 1)
    || compared.cases.some(value => !Number.isFinite(value.baseline) || !Number.isFinite(value.candidate) || !value.verdict)) {
    return insufficient('invalid-comparator-result')
  }
  const sign = metric.direction === 'higher-is-better' ? 1 : -1
  const worstRegression = Math.max(0, ...compared.cases.map(value => sign * (value.baseline - value.candidate)))
  let costAllowed = true
  if (plan.thresholds.maxRelativeCostIncrease !== undefined) {
    const cost = compared.cost
    if (cost === undefined || !Number.isFinite(cost.baseline) || !Number.isFinite(cost.candidate)
      || cost.baseline < 0 || cost.candidate < 0 || !cost.unit) return insufficient('missing-or-invalid-cost')
    const { baseline, candidate } = cost
    costAllowed = baseline === 0 ? candidate === 0 : (candidate - baseline) / baseline <= plan.thresholds.maxRelativeCostIncrease
  }
  const improved = compared.aggregateDelta > 0 && compared.aggregateDelta >= plan.thresholds.minDelta
    && worstRegression <= plan.thresholds.maxRegression && costAllowed
  return {
    ...common, metric, aggregateDelta: compared.aggregateDelta, worstRegression, cases: compared.cases,
    ...(compared.cost === undefined || !manifest.usage.complete ? {} : { cost: compared.cost }),
    outcome: improved ? 'improved' : 'no-improvement',
    ...(!costAllowed ? { reason: 'cost-threshold' } : {}),
  }
}

export interface EvaluationTaskRequest {
  readonly slot: EvaluationSlot
  readonly requestRef: Ref
  readonly maxActive: number
  readonly deadlineAt: number
  /** Same writer's committed usage, checked by the ordinary DSH request gate. */
  readonly checkReportedBudget: (reported?: { readonly tokens: number }) => boolean
  readonly canOpenRun: () => boolean
  /** Ordinary Task tree runner owns native cancellation and final settlement. */
  readonly signal: AbortSignal
}

/** Sequential arms share the ordinary tree runner's capacity and retry policy. */
export async function evaluateRsiCandidate(request: RoundCommandContext & {
  readonly roundId: string
  readonly comparator?: EvaluationComparator
  readonly runTask: (request: EvaluationTaskRequest) => Promise<void>
  readonly clock?: () => number
}): Promise<{ readonly comparison: EvaluationComparison; readonly comparisonRef: Ref }> {
  const { service, roundId } = request
  const round = await requireRound(service, roundId)
  if (round.closed?.comparisonRef !== undefined) {
    // Closed results do not purchase another baseline or candidate request.
    const value = await readRoundObject(service, round.closed.comparisonRef)
    return { comparison: value as unknown as EvaluationComparison, comparisonRef: round.closed.comparisonRef }
  }
  if (round.status !== 'evaluating' || round.candidateMethod === undefined) throw new MethodRoundError('Round has no evaluation candidate')
  const plan = await readRoundPlan(service, round.plan)
  const slots = frozenEvaluationSlots(roundId, plan, round.baseMethod, round.candidateMethod)
  const ready = service.facts().find(fact => fact.type === 'rsi/candidate-ready' && fact.data.roundId === roundId)
  if (ready === undefined) throw new MethodRoundError('Candidate admission is missing')
  const clock = request.clock ?? Date.now
  const deadlineAt = ready.at + plan.budget.maxWallClockMs
  const signal = AbortSignal.timeout(Math.max(0, deadlineAt - clock()))
  for (const slot of slots) {
    if (request.comparator === undefined || !same(request.comparator.asset, plan.comparator)) break
    const state = await service.taskRunState([])
    const existing = state.tasks.get(slot.taskId)
    if (existing?.phase === 'closed') continue
    const manifest = await readEvaluationManifest(service, slots, state)
    if (existing === undefined && (clock() >= deadlineAt
      || tokenCount(manifest.usage) >= plan.budget.maxTokens || manifest.runCount >= plan.budget.maxRuns)) break
    const requestRef = await service.putObject(slot.id, new TextEncoder().encode(canonicalize({ v: 1, roundId, slot })))
    await request.runTask({
      slot, requestRef, maxActive: plan.budget.maxActiveRuns, deadlineAt, signal,
      checkReportedBudget: reported => {
        if (reported === undefined) return reportedEvaluationBudget(service, slots, plan, clock, deadlineAt)
        const otherUsage = manifest.slots.filter(value => value.slot.id !== slot.id)
          .reduce((sum, value) => sum + tokenCount(value.usage), 0)
        return otherUsage + reported.tokens < plan.budget.maxTokens && clock() < deadlineAt
      },
      canOpenRun: () => reportedEvaluationUsage(service, slots).runCount < plan.budget.maxRuns,
    })
    if ((await readEvaluationManifest(service, [slot])).slots[0]?.status !== 'complete') break
  }
  const state = await service.taskRunState([])
  await assertPairedContracts(service, state, slots, plan)
  const manifest = await readEvaluationManifest(service, slots, state)
  if (manifest.slots.some(slot => slot.reason === 'not-terminal')) throw new MethodRoundError('Ordinary evaluation Tasks must drain before Round closure')
  const comparison = compareEvaluation(roundId, round.plan, plan, manifest, request.comparator)
  const comparisonRef = await service.putObject(`${roundId}:comparison`, new TextEncoder().encode(canonicalize(comparison)))
  await closeRsiRound(request, { roundId, outcome: comparison.outcome, comparisonRef, ...(comparison.reason === undefined ? {} : { reason: comparison.reason }) })
  return { comparison, comparisonRef }
}

function reportedEvaluationBudget(service: CommandService, slots: readonly EvaluationSlot[], plan: RoundPlan, clock: () => number, deadlineAt: number): boolean {
  const usage = reportedEvaluationUsage(service, slots)
  return clock() < deadlineAt && usage.tokens < plan.budget.maxTokens && usage.runCount <= plan.budget.maxRuns
}

function reportedEvaluationUsage(service: CommandService, slots: readonly EvaluationSlot[]): { readonly runCount: number; readonly tokens: number } {
  const taskIds = new Set(slots.map(slot => slot.taskId))
  const runs = new Map<string, string>()
  let tokens = 0
  for (const fact of service.facts()) {
    if (fact.type === 'task/children-admitted') {
      const parentTaskId = runs.get(fact.data.parentRunId)
      if (parentTaskId !== undefined && taskIds.has(parentTaskId)) for (const child of fact.data.children) taskIds.add(child.contract.taskId)
    }
    if (fact.type === 'run/opened' && taskIds.has(fact.data.taskId)) runs.set(fact.data.runId, fact.data.taskId)
    if (fact.type === 'run/closed' && runs.has(fact.data.runId)) {
      tokens += tokenCount(fact.data.usage) + (fact.data.usage.summary === undefined ? 0 : tokenCount(fact.data.usage.summary))
    }
  }
  return { runCount: runs.size, tokens }
}

async function assertPairedContracts(service: CommandService, state: TaskRunState, slots: readonly EvaluationSlot[], plan: RoundPlan): Promise<void> {
  const cases = new Map<string, string>()
  const environments = new Map<string, string>()
  const sessions = new Set<string>()
  const workspaces = new Set<string>()
  for (const slot of slots) {
    const contract = state.tasks.get(slot.taskId)?.contract
    if (contract === undefined) continue
    if (plan.claim === 'source-replay' && !same(contract.environment.seed, plan.sourceSeed)) {
      throw new MethodRoundError('Source replay must use the source admission seed')
    }
    const key = `${slot.caseRef.id}:${slot.caseRef.digest}`
    let frozen = cases.get(key)
    if (frozen === undefined) {
      frozen = canonicalize(await readEvaluationCase(service, slot.caseRef))
      cases.set(key, frozen)
    }
    if (canonicalize(evaluationCaseFromContract(contract)) !== frozen) throw new MethodRoundError('Paired Task differs from the frozen evaluation case')
    for (const run of state.runs.values()) {
      if (state.tasks.get(run.taskId)?.rootTaskId !== slot.taskId) continue
      if (sessions.has(run.opened.sessionId) || workspaces.has(run.opened.workspaceKey)) {
        throw new MethodRoundError('Evaluation trials require fresh sessions and workspace identities')
      }
      sessions.add(run.opened.sessionId)
      workspaces.add(run.opened.workspaceKey)
      const composition = parseProtocolValue(compositionSchema, await readRoundObject(service, run.opened.composition, 'composition'))
      const environment = canonicalize({
        dsh: { package: composition.dsh.package, version: composition.dsh.version, config: composition.dsh.config.digest },
        modelRoute: composition.modelRoute.digest, resources: composition.resources.digest,
      })
      const priorEnvironment = environments.get(key)
      if (priorEnvironment !== undefined && priorEnvironment !== environment) throw new MethodRoundError('Paired Tasks differ in frozen model route or global resources')
      environments.set(key, environment)
    }
  }
}

type MutableEvaluationUsage = { -readonly [Key in keyof EvaluationUsage]: EvaluationUsage[Key] }

function emptyUsage(): MutableEvaluationUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    steps: 0, unknownRequests: 0, complete: true, cacheComplete: true }
}

function addUsage(target: MutableEvaluationUsage, source: UsageRecord | EvaluationUsage): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.steps += source.steps
  target.unknownRequests += source.unknownRequests
  if ('complete' in source) target.complete &&= source.complete
  const cacheComplete = 'cacheComplete' in source ? source.cacheComplete
    : source.cacheReadTokens !== undefined && source.cacheWriteTokens !== undefined
  target.cacheComplete &&= cacheComplete
  if (target.cacheComplete) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (source.cacheReadTokens ?? 0)
    target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (source.cacheWriteTokens ?? 0)
  } else {
    delete target.cacheReadTokens
    delete target.cacheWriteTokens
  }
  if ('summary' in source && source.summary !== undefined) addUsage(target, source.summary)
}

function tokenCostReport(manifest: EvaluationManifest): TokenCostReport {
  const cacheComplete = manifest.complete && manifest.usage.cacheComplete
  const arm = (name: 'baseline' | 'candidate'): TokenCostArm => {
    const usage = emptyUsage()
    for (const slot of manifest.slots) if (slot.slot.arm === name) addUsage(usage, slot.usage)
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      uncachedInputTokens: cacheComplete
        ? usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0) : null,
      cacheReadTokens: cacheComplete ? usage.cacheReadTokens ?? 0 : null,
      cacheWriteTokens: cacheComplete ? usage.cacheWriteTokens ?? 0 : null,
    }
  }
  return { complete: manifest.complete, cacheComplete, baseline: arm('baseline'), candidate: arm('candidate') }
}

function tokenCount(usage: Pick<UsageRecord, 'inputTokens' | 'outputTokens'>): number {
  return usage.inputTokens + usage.outputTokens
}

function same(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}

/** Compare real consumer quality; token cost is reported separately and is not the objective. */
export function compareVerifiedFraction(plan: RoundPlan, evidence: readonly PublicEvaluationEvidence[]) {
  const cases = []
  for (const caseRef of [...plan.cases, ...plan.validationCases]) {
    const arm = (name: 'baseline' | 'candidate') => evidence.filter(value => value.caseRef.digest === caseRef.digest && value.caseRef.id === caseRef.id && value.arm === name)
    const baseline = arm('baseline'), candidate = arm('candidate')
    if (baseline.length !== plan.trialsPerCase || candidate.length !== plan.trialsPerCase) {
      return { comparable: false as const, reason: 'missing-quality-trial' }
    }
    const mean = (values: typeof baseline) => values.reduce((sum, value) => sum + (value.verdict === 'verified' ? 1 : 0), 0) / values.length
    const before = mean(baseline), after = mean(candidate)
    cases.push({ caseRef, baseline: before, candidate: after, verdict: after > before ? 'improved' : after < before ? 'regression' : 'equal' })
  }
  const publicCases = cases.slice(0, plan.cases.length)
  return { comparable: true as const, cases,
    aggregateDelta: publicCases.reduce((sum, value) => sum + value.candidate - value.baseline, 0) / publicCases.length,
    cost: pairedTokenCost(evidence) }
}

/** Domain checks own normalization and measurement; validation only guards regression. */
export function compareMetricScores(plan: RoundPlan, evidence: readonly PublicEvaluationEvidence[]) {
  const selected = evaluationMetricSchema.safeParse(plan.metric)
  if (!selected.success) return { comparable: false as const, reason: 'invalid-metric-selector' }
  const cases: ComparedCase[] = []
  for (const caseRef of [...plan.cases, ...plan.validationCases]) {
    const scores = { baseline: [] as number[], candidate: [] as number[] }
    for (const arm of ['baseline', 'candidate'] as const) {
      const trials = evidence.filter(value => same(value.caseRef, caseRef) && value.arm === arm)
      if (trials.length !== plan.trialsPerCase) return { comparable: false as const, reason: 'missing-metric-trial' }
      for (const trial of trials) {
        if (trial.verdict === 'failed') { scores[arm].push(0); continue }
        const metric = trial.receipt.criteria.find(value => value.id === selected.data.criterion)?.metric
        if (metric === undefined || metric.name !== selected.data.name || metric.unit !== selected.data.unit
          || !Number.isFinite(metric.value) || metric.value <= 0) {
          return { comparable: false as const, reason: 'missing-or-invalid-performance-metric' }
        }
        scores[arm].push(metric.value)
      }
    }
    const baseline = geometricMean(scores.baseline), candidate = geometricMean(scores.candidate)
    cases.push({ caseRef, baseline, candidate, verdict: candidate > baseline ? 'improved' : candidate < baseline ? 'regression' : 'equal' })
  }
  const publicCases = cases.slice(0, plan.cases.length)
  const baseline = geometricMean(publicCases.map(value => value.baseline)), candidate = geometricMean(publicCases.map(value => value.candidate))
  return { comparable: true as const, cases,
    aggregateDelta: baseline === 0 ? candidate : candidate / baseline - 1,
    cost: pairedTokenCost(evidence) }
}

function geometricMean(values: readonly number[]): number {
  return values.some(value => value === 0) ? 0 : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
}

function pairedTokenCost(evidence: readonly PublicEvaluationEvidence[]): ComparisonCost {
  const tokens = (arm: 'baseline' | 'candidate') => evidence.filter(value => value.arm === arm)
    .reduce((sum, value) => sum + value.usage.inputTokens + value.usage.outputTokens, 0)
  return { baseline: tokens('baseline'), candidate: tokens('candidate'), unit: 'reported-tokens' }
}
