import type {
  FactActor,
  LocalFinalistPolicy,
  MethodPatch,
  Ref,
  ReplayPoint,
  RoundPlan,
  SliceAttempt,
  SliceCampaignResult,
  UsageRecord,
} from '@singularity/protocol'
import {
  AdmissionError,
  canonicalize,
  computeDigest,
  MethodRoundError,
  parseProtocolValue,
  replayPointSchema,
  sliceAttemptSchema,
  sliceCampaignResultSchema,
  sliceSelectionSchema,
  validateRoundPlan,
} from '@singularity/protocol'
import { ZodError } from 'zod'
import type { z } from 'zod'

import type {
  EvaluationComparator,
  EvaluationComparison,
  EvaluationTaskRequest,
} from './evaluation.ts'
import {
  compareLocalCandidate,
  ensureEvaluationSlots,
  frozenLocalSlots,
  readEvaluationManifest,
} from './evaluation.ts'
import { readEvaluationCase } from './evaluation-case.ts'
import { MethodResourceError } from './errors.ts'
import {
  materializeRoundPatch,
  MethodPatchRejection,
  parseRoundPatch,
  readRoundMaterializationContext,
} from './method-patch.ts'
import type { ProposalHistoryView, RsiPatchDraftResult } from './proposer.ts'
import {
  assertBaselineFidelity,
  assertScopedCandidate,
  BaselineDriftError,
  ReplayScopeError,
} from './replay.ts'
import { readRoundObject } from './round.ts'
import { selectUtilityV1 } from './selector.ts'
import type { SliceCandidatePoint } from './selector.ts'
import type { CommandService } from './service.ts'

const encoder = new TextEncoder()

export interface ExecutionLedgerMark {
  readonly v: 1
  readonly nativeId: number
  readonly factSeq: number
  readonly proposerCount: number
}

export interface ExecutionCostFold {
  readonly usage: UsageRecord
  readonly nativeRequests: number
  readonly nativeCompleted: number
  readonly runCount: number
  readonly cacheComplete: boolean
}

export interface ExecutionCostLedger {
  mark(): ExecutionLedgerMark
  foldSince(mark: ExecutionLedgerMark): ExecutionCostFold
  recordProposer(recordRef: Ref, steps: number): void
}

export interface SliceCampaignBudget {
  readonly maxTokens: number
  readonly maxRuns: number
  readonly maxWallClockMs: number
}

export interface RunSliceCampaignRequest {
  readonly service: CommandService
  readonly actor: FactActor
  readonly roundId: string
  readonly roundIndex: number
  readonly pointCandidates: readonly SliceCandidatePoint[]
  readonly rootPlan: RoundPlan
  readonly baseMethod: Ref
  readonly hostFingerprint: string
  readonly comparator: EvaluationComparator
  readonly comparatorKind: 'verified-fraction' | 'metric-scores'
  readonly finalistPolicy: LocalFinalistPolicy
  readonly history: ProposalHistoryView
  readonly requireClosed: boolean
  readonly localTrials: number
  readonly localThresholds: RoundPlan['thresholds']
  readonly localBudget: RoundPlan['budget']
  readonly budget: SliceCampaignBudget
  readonly costs: ExecutionCostLedger
  readonly maxCandidates?: number
  readonly draft: (
    point: ReplayPoint,
    history: ProposalHistoryView,
    attemptId: string,
  ) => Promise<RsiPatchDraftResult>
  readonly extendHistory: (
    history: ProposalHistoryView,
    archivedAttempt: Ref,
  ) => Promise<ProposalHistoryView>
  readonly runTask: (point: ReplayPoint, request: EvaluationTaskRequest) => Promise<void>
  readonly deadlineAt: number
  readonly signal: AbortSignal
  readonly clock?: () => number
}

export interface SliceCampaignRun {
  readonly result: SliceCampaignResult
  readonly resultRef: Ref
}

interface QualifiedAttempt {
  readonly attemptRef: Ref
  readonly patch: MethodPatch
  readonly candidateMethod: Ref
  readonly comparison: EvaluationComparison
  readonly changes: number
}

export function makeLocalPlan(input: {
  readonly rootPlan: RoundPlan
  readonly point: ReplayPoint
  readonly comparatorKind: 'verified-fraction' | 'metric-scores'
  readonly localTrials: number
  readonly thresholds: RoundPlan['thresholds']
  readonly budget: RoundPlan['budget']
}): RoundPlan {
  if (input.comparatorKind === 'metric-scores' && input.localTrials < 3) {
    throw new Error('Continuous local metrics require at least three trials')
  }
  const metric = input.comparatorKind === 'metric-scores' ? input.point.localMetric : input.rootPlan.metric
  if (metric === undefined) throw new Error('Metric replay point has no unambiguous local metric')
  return validateRoundPlan({
    ...input.rootPlan,
    cases: input.point.localCases,
    metric,
    validationCases: [],
    validation: 'none',
    claim: 'source-replay',
    trialsPerCase: input.localTrials,
    thresholds: input.thresholds,
    budget: input.budget,
  })
}

export function qualifyLocalComparison(
  comparison: EvaluationComparison,
  policy: LocalFinalistPolicy,
  comparatorKind: 'verified-fraction' | 'metric-scores',
): 'local-qualified' | 'diagnostic-finalist' | undefined {
  if (policy.kind === 'root-quality') {
    return comparison.outcome === 'improved' ? 'local-qualified' : undefined
  }
  if (comparatorKind !== 'verified-fraction' || !comparison.complete
    || comparison.aggregateDelta !== 0 || comparison.worstRegression !== 0
    || !comparison.usage.complete || comparison.usage.unknownRequests !== 0
    || comparison.tokenCosts?.complete !== true) return undefined
  const allCorrect = comparison.cases.length > 0 && comparison.cases.every(
    value => value.baseline === 1 && value.candidate === 1,
  )
  const cost = comparison.cost
  if (!allCorrect || cost === undefined || cost.unit !== 'reported-tokens'
    || cost.baseline <= 0 || !Number.isFinite(cost.candidate)) return undefined
  const reduction = 1 - cost.candidate / cost.baseline
  return reduction >= policy.minRelativeTokenReduction ? 'diagnostic-finalist' : undefined
}

export async function runSliceCampaign(request: RunSliceCampaignRequest): Promise<SliceCampaignRun> {
  const { service, roundId } = request
  const clock = request.clock ?? Date.now
  const campaignMark = request.costs.mark()
  const deadlineAt = Math.min(request.deadlineAt, clock() + request.budget.maxWallClockMs)
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, deadlineAt - clock()))),
  ])
  const campaignId = `${roundId}:slice:${computeDigest('object', {
    base: request.baseMethod,
    hostFingerprint: request.hostFingerprint,
  }).slice('sha256:'.length)}`
  const maxCandidates = Math.min(2, Math.max(1, Math.floor(request.maxCandidates ?? 2)))
  if (request.finalistPolicy.kind === 'engineering-cost-diagnostic'
    && request.comparatorKind !== 'verified-fraction') {
    throw new Error('Engineering cost diagnostic requires verified-fraction correctness')
  }
  const opened = service.facts().find(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  if (opened?.type !== 'rsi/round-opened') throw new Error('Slice campaign requires an open root Round')
  const context = await readRoundMaterializationContext(service, roundId)
  if (!same(context.baseMethod, request.baseMethod)) throw new Error('Slice campaign base differs from the root Round')

  const totals = () => request.costs.foldSince(campaignMark)
  const canPurchase = () => {
    const cost = totals()
    return !signal.aborted && clock() < deadlineAt
      && cost.usage.inputTokens + cost.usage.outputTokens < request.budget.maxTokens
      && cost.runCount < request.budget.maxRuns
  }
  const finish = async (
    value: Omit<SliceCampaignResult, 'usage' | 'nativeRequests' | 'nativeCompleted' | 'runCount' | 'cacheComplete'>,
    id = `${campaignId}:result`,
  ): Promise<SliceCampaignRun> => {
    const result = parseProtocolValue(sliceCampaignResultSchema, { ...value, ...totals() })
    const resultRef = await putArchive(service, id, sliceCampaignResultSchema, result)
    return { result, resultRef }
  }
  const common = {
    v: 1 as const,
    campaignId,
    roundId,
    finalistPolicy: request.finalistPolicy,
    hostFingerprint: request.hostFingerprint,
    budget: request.budget,
  }
  const selection = selectUtilityV1(
    request.pointCandidates,
    request.requireClosed,
    request.finalistPolicy.kind === 'root-quality',
  )
  if (selection === undefined) {
    return finish({
      ...common,
      baselineSlots: [], attempts: [], outcome: 'not-replayable',
      reason: 'no-eligible-task-for-frozen-policy',
      diagnostics: [`candidatePoints=${String(request.pointCandidates.length)}`],
    })
  }
  const point = parseProtocolValue(replayPointSchema, selection.point)
  if (!same(point.baseMethod, request.baseMethod) || !same(point.sourceTrace, opened.data.sourceTrace)
    || point.hostFingerprint !== request.hostFingerprint) {
    return finish({
      ...common,
      baselineSlots: [], attempts: [], outcome: 'not-replayable',
      reason: 'replay-point-identity-mismatch',
    })
  }
  const selectionRef = await putArchive(service, `${campaignId}:selection`, sliceSelectionSchema, {
    v: 1,
    campaignId,
    point,
    features: selection.features,
    policy: { name: 'utility-v1', revision: 1 },
    visibleHistory: request.history.historyRefs,
    score: selection.score,
    reasons: selection.reasons,
  })
  let localPlan: RoundPlan
  try {
    localPlan = makeLocalPlan({
      rootPlan: request.rootPlan,
      point,
      comparatorKind: request.comparatorKind,
      localTrials: request.localTrials,
      thresholds: request.localThresholds,
      budget: request.localBudget,
    })
    for (const caseRef of point.localCases) {
      if ((await readEvaluationCase(service, caseRef)).limits.deadlineAt !== deadlineAt) {
        throw new BaselineDriftError('source-case', 'Local case deadline differs from the campaign deadline')
      }
    }
  } catch (error) {
    if (!(error instanceof BaselineDriftError)) throw error
    return finish({
      ...common,
      selection: selectionRef,
      baselineSlots: [], attempts: [], outcome: 'not-replayable',
      reason: error.message,
    })
  }
  const localPlanRef = await service.putObject(
    `${campaignId}:plan`,
    encoder.encode(canonicalize(localPlan)),
    'round-plan',
  )
  const baselineRoundId = `${campaignId}:baseline:${localPlanRef.digest}`
  const baselineSlots = frozenLocalSlots(
    baselineRoundId,
    localPlan,
    request.baseMethod,
    undefined,
    localPlanRef.digest,
  )
  const baselineSlotIds = baselineSlots.map(slot => slot.id)
  let baselineFidelity: 'exact' | 'verdict-drift' = 'exact'
  const runSlots = async (slots: typeof baselineSlots, arm: 'baseline' | 'candidate') => ensureEvaluationSlots({
    service,
    slots,
    budget: { [arm]: { maxTokens: request.localBudget.maxTokens, maxRuns: request.localBudget.maxRuns } },
    canPurchase,
    clock,
    deadlineAt,
    runTask: task => request.runTask(point, task),
    requestFor: (slot, requestRef, manifest) => ({
      slot,
      requestRef,
      maxActive: request.localBudget.maxActiveRuns,
      deadlineAt,
      signal,
      canOpenRun: canPurchase,
      checkReportedBudget: reported => {
        if (!canPurchase()) return false
        if (reported === undefined) return true
        const others = manifest.slots.filter(value => value.slot.id !== slot.id)
          .reduce((sum, value) => sum + value.usage.inputTokens + value.usage.outputTokens, 0)
        return others + reported.tokens < request.localBudget.maxTokens
      },
    }),
  })

  try {
    await runSlots(baselineSlots, 'baseline')
    const baseline = await readEvaluationManifest(service, baselineSlots)
    for (const result of baseline.slots.filter(slot => same(slot.slot.caseRef, point.sourceCase))) {
      if (result.status !== 'complete' || result.publicEvidence === undefined) {
        throw new BaselineDriftError('baseline-verdict', 'Shared baseline has no complete source-case Evidence')
      }
      const fidelity = await assertBaselineFidelity({
        store: service,
        point,
        hostFingerprint: request.hostFingerprint,
        observation: {
          caseRef: result.slot.caseRef,
          verdict: result.publicEvidence.verdict,
          receipt: result.publicEvidence.receipt,
        },
      })
      if (fidelity.fidelity === 'verdict-drift') baselineFidelity = 'verdict-drift'
    }
    if (baseline.slots.some(slot => slot.status !== 'complete')) {
      throw new BaselineDriftError('baseline-verdict', 'Shared baseline did not complete every frozen slot')
    }
  } catch (error) {
    if (!(error instanceof BaselineDriftError)) throw error
    return finish({
      ...common,
      selection: selectionRef,
      localPlan: localPlanRef,
      baselineRoundId,
      baselineSlots: baselineSlotIds,
      attempts: [],
      outcome: 'not-replayable',
      reason: error.message,
    })
  }

  const attempts: Ref[] = []
  const seenCandidates = new Set<string>()
  const qualified: QualifiedAttempt[] = []
  let draftHistory = request.history
  let halted = signal.aborted
  for (let index = 0; index < maxCandidates; index += 1) {
    if (!canPurchase()) {
      halted = true
      break
    }
    const ordinal = index + 1
    const draftId = `${campaignId}:attempt:${String(ordinal)}`
    const attemptMark = request.costs.mark()
    const drafted = await request.draft(point, draftHistory, draftId)
    request.costs.recordProposer(drafted.recordRef, drafted.usage.steps)
    let attemptId = draftId
    const archiveAttempt = async (
      outcome: SliceAttempt['outcome'],
      fields: Partial<Pick<SliceAttempt, 'patch' | 'candidateMethod' | 'comparison' | 'scope' | 'reason'>> = {},
    ) => {
      const ref = await putArchive(service, `${attemptId}:record`, sliceAttemptSchema, {
        v: 1,
        attemptId,
        campaignId,
        selection: selectionRef,
        proposalRecord: drafted.recordRef,
        localPlan: localPlanRef,
        outcome,
        ...fields,
        ...request.costs.foldSince(attemptMark),
      })
      attempts.push(ref)
      draftHistory = await request.extendHistory(draftHistory, ref)
      return ref
    }
    if (drafted.draft === undefined) {
      await archiveAttempt('proposer-failure', { reason: drafted.failure ?? drafted.closureReason ?? 'no-draft' })
      if (drafted.closureReason === 'proposer-budget-exhausted') halted = true
      continue
    }

    try {
      const materialized = await materializeRoundPatch(service, context, drafted.draft, 'draft')
      attemptId = `${draftId}:${materialized.candidateMethod.digest}`
      const scoped = assertScopedCandidate({
        base: context.base,
        candidate: materialized.candidate,
        patch: materialized.patch,
        point,
        editBudget: Math.max(2, 3 - Math.floor(request.roundIndex / 3)),
      })
      const scope = {
        kind: scoped.kind,
        sharedTemplate: scoped.sharedTemplate,
        affectedTemplateIds: [...scoped.affectedTemplateIds],
      }
      const stable = await materializeRoundPatch(service, context, materialized.patch, 'frozen')
      if (!same(stable.candidateMethod, materialized.candidateMethod)) {
        throw new MethodPatchRejection('Candidate materialization is not stable')
      }
      const candidateKey = `${materialized.candidateMethod.id}:${materialized.candidateMethod.digest}`
      if (seenCandidates.has(candidateKey)) {
        await archiveAttempt('duplicate-candidate', {
          patch: await putJson(service, `${attemptId}:patch`, materialized.patch),
          candidateMethod: materialized.candidateMethod,
          scope,
          reason: 'duplicate-candidate',
        })
        continue
      }
      seenCandidates.add(candidateKey)
      const candidateSlots = frozenLocalSlots(
        attemptId,
        localPlan,
        request.baseMethod,
        materialized.candidateMethod,
        localPlanRef.digest,
      ).filter(slot => slot.arm === 'candidate')
      await runSlots(candidateSlots, 'candidate')
      const paired = [...candidateSlots, ...baselineSlots]
      const comparison = await compareLocalCandidate({
        service,
        roundId: attemptId,
        planRef: localPlanRef,
        plan: localPlan,
        slots: paired,
        comparator: request.comparator,
      })
      const comparisonRef = await putJson(service, `${attemptId}:comparison`, comparison)
      const qualification = qualifyLocalComparison(comparison, request.finalistPolicy, request.comparatorKind)
      const patchRef = await putJson(service, `${attemptId}:patch`, materialized.patch)
      const outcome = qualification === 'local-qualified' && baselineFidelity === 'verdict-drift'
        ? 'diagnostic-finalist'
        : qualification ?? (comparison.outcome === 'insufficient-evidence' ? 'insufficient-evidence' : 'no-improvement')
      const attemptRef = await archiveAttempt(outcome, {
        patch: patchRef,
        candidateMethod: materialized.candidateMethod,
        comparison: comparisonRef,
        scope,
        ...(comparison.reason === undefined ? {} : { reason: comparison.reason }),
      })
      if (qualification !== undefined) {
        qualified.push({
          attemptRef,
          patch: materialized.patch,
          candidateMethod: materialized.candidateMethod,
          comparison,
          changes: materialized.patch.changes.length,
        })
      }
    } catch (error) {
      if (!isCandidateBusinessError(error)) throw error
      await archiveAttempt(error instanceof MethodRoundError ? 'insufficient-evidence' : 'rejected', {
        reason: error.message,
      })
    }
    if (signal.aborted) halted = true
  }

  qualified.sort((left, right) => compareQualified(left, right))
  const winner = halted || signal.aborted ? undefined : qualified[0]
  return finish({
    ...common,
    selection: selectionRef,
    localPlan: localPlanRef,
    baselineRoundId,
    baselineSlots: baselineSlotIds,
    baselineFidelity,
    attempts,
    ...(winner === undefined ? {} : { finalistAttempt: winner.attemptRef }),
    outcome: halted || signal.aborted
      ? 'budget-exhausted'
      : winner === undefined ? 'no-qualified-candidate' : 'finalist',
    ...(halted || signal.aborted ? { reason: 'signal-aborted-or-budget-exhausted' } : {}),
  })
}

export async function readSliceFinalist(
  service: CommandService,
  result: SliceCampaignResult,
  expectedBase: Ref,
): Promise<{ readonly patch: MethodPatch; readonly candidateMethod: Ref }> {
  if (result.outcome !== 'finalist' || result.finalistAttempt === undefined) {
    throw new Error('Slice campaign has no promotable finalist')
  }
  const attempt = parseProtocolValue(sliceAttemptSchema, await readRoundObject(service, result.finalistAttempt))
  if ((attempt.outcome !== 'local-qualified' && attempt.outcome !== 'diagnostic-finalist')
    || attempt.patch === undefined || attempt.candidateMethod === undefined || attempt.comparison === undefined) {
    throw new Error('Finalist attempt is incomplete')
  }
  const comparison = await readRoundObject(service, attempt.comparison) as unknown as EvaluationComparison
  if (!comparison.complete || comparison.claim !== 'source-replay'
    || !same(comparison.plan, attempt.localPlan)
    || (attempt.outcome === 'local-qualified' && comparison.outcome !== 'improved')) {
    throw new Error('Finalist comparison is not a complete local source replay')
  }
  const patch = parseRoundPatch(await readRoundObject(service, attempt.patch), expectedBase, 'frozen')
  const context = await readRoundMaterializationContext(service, result.roundId)
  const stable = await materializeRoundPatch(service, context, patch, 'frozen')
  if (!same(stable.candidateMethod, attempt.candidateMethod)) {
    throw new Error('Local/root candidate identity mismatch')
  }
  return { patch, candidateMethod: attempt.candidateMethod }
}

function isCandidateBusinessError(error: unknown): error is Error {
  return error instanceof MethodPatchRejection
    || error instanceof ReplayScopeError
    || error instanceof MethodResourceError
    || error instanceof AdmissionError
    || error instanceof MethodRoundError
    || error instanceof ZodError
}

function compareQualified(left: QualifiedAttempt, right: QualifiedAttempt): number {
  const delta = (right.comparison.aggregateDelta ?? -Infinity) - (left.comparison.aggregateDelta ?? -Infinity)
  if (delta !== 0) return delta
  const regression = (left.comparison.worstRegression ?? Infinity) - (right.comparison.worstRegression ?? Infinity)
  if (regression !== 0) return regression
  const cost = relativeTokenCost(left.comparison) - relativeTokenCost(right.comparison)
  if (cost !== 0) return cost
  if (left.changes !== right.changes) return left.changes - right.changes
  return left.candidateMethod.digest.localeCompare(right.candidateMethod.digest)
}

function relativeTokenCost(comparison: EvaluationComparison): number {
  const cost = comparison.cost
  if (cost === undefined || cost.unit !== 'reported-tokens') return Number.POSITIVE_INFINITY
  if (cost.baseline === 0) return cost.candidate === 0 ? 0 : Number.POSITIVE_INFINITY
  return cost.candidate / cost.baseline
}

async function putArchive<T>(
  service: CommandService,
  id: string,
  schema: z.ZodType<T>,
  value: unknown,
): Promise<Ref> {
  const parsed = parseProtocolValue(schema, value)
  return service.putObject(id, encoder.encode(canonicalize(parsed)))
}

function putJson(service: CommandService, id: string, value: unknown): Promise<Ref> {
  return service.putObject(id, encoder.encode(canonicalize(value)))
}

function same(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}
