import { copyFile,mkdir,writeFile } from 'node:fs/promises'
import { basename,join } from 'node:path'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GlobalResourceSnapshot,JsonValue,LocalFinalistPolicy,Ref,RoundPlan,TaskContract,TaskLimits,TaskSpec,UsageRecord } from '@singularity/protocol'
import { admitRootTask,canonicalize,computeDigest,EXPLORE_TEMPLATE_ID,methodRevisionSchema,parseJsonText,parseProtocolValue,resolveTemplateView,sealMethodRevision } from '@singularity/protocol'
import type { EvaluationTaskRequest } from '@singularity/runtime'
import { activateRoundCandidate,AGENT_REVIEW_POLICY,buildProposalHistory,captureReplayPoints,closeRsiRound,contractForLocalSlot,createAgentVerifier,compareMetricScores,compareVerifiedFraction,CommandService,ContractSummaryService,draftRsiPatch,evaluateRsiCandidate,evaluationCaseFromContract,executeRsiProposer,executeTaskTree,extendProposalHistory,freezeEvaluationCase,freezeGlobalResources,openRsiRound,readSliceFinalist,resourceAssetCatalog,precheckMethodPatch,runSliceCampaign,sealPublicTrace,submitMethodPatch,taskProtocolReference } from '@singularity/runtime'

import { bootSpikeProfile,buildSingleRunComposition } from './host-composition.ts'
import { campaignLedger,nativeAccounting } from './accounting.ts'
import { bindDomainTask,freezeDomainTools } from './domain.ts'
import type { ExperimentDomain } from './domain.ts'

const maxWallClockMs = 12 * 60 * 60 * 1000
const maxReportedTokens = 1_000_000_000

export const EXPERIMENT_BUDGET = {
  maxWallClockMs,
  maxReportedTokens,
  maxRequests: 4000,
  rounds: 3,
  trialsPerCase: 1,
  sourceMustVerify: false,
  searchMode: 'root-only' as const,
  autoActivate: true,
  slice: {
    requireClosed: false,
    baselinePolicy: 'strict' as const,
    metricRelativeTolerance: 0,
    maxCandidates: 2,
    finalistPolicy: { kind: 'root-quality' } as const,
    maxTokens: maxReportedTokens,
    maxRuns: 6 * 256 * 3,
    maxWallClockMs,
  },
  maxActive: 4,
  reviewMaxSteps: 128,
  maxOutputBytes: 256 * 1024 * 1024,
  task: { maxRuns: 3, maxStepsPerRun: 4096, maxTokens: maxReportedTokens,
    maxDepth: 8, maxTasks: 256, maxBatchChildren: 8 } satisfies Omit<TaskLimits, 'deadlineAt'>,
  proposerBudget: { maxSteps: 4096, maxTokens: maxReportedTokens,
    maxWallClockMs } satisfies RoundPlan['proposerBudget'],
  evaluationBudget: { maxRuns: 6 * 256 * 3, maxTokens: maxReportedTokens,
    maxWallClockMs, maxActiveRuns: 4 } satisfies RoundPlan['budget'],
}

export type ExperimentBudget = Omit<typeof EXPERIMENT_BUDGET, 'searchMode' | 'autoActivate' | 'slice'> & {
  readonly searchMode?: 'root-only' | 'slice-v1'
  readonly autoActivate?: boolean
  readonly slice?: Omit<typeof EXPERIMENT_BUDGET['slice'], 'finalistPolicy' | 'metricRelativeTolerance'> & { readonly finalistPolicy: LocalFinalistPolicy; readonly metricRelativeTolerance?: number }
}

const actor = { kind: 'runtime', id: 'singularity-experiment' } as const
const bytes = (value: unknown) => value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === 'string' ? value : canonicalize(value))
/** Continuous metrics use a relative geometric mean; fewer trials cannot separate signal from noise. */
export const MIN_CONTINUOUS_TRIALS: number = 3
/** Invalid sources never enter RSI; a strict campaign also rejects failed/cancelled roots. */
export function sourceEligible(classification: string, requireVerified: boolean): boolean {
  return classification !== 'invalid' && (!requireVerified || classification === 'verified')
}

/** Operator host for any public domain bundle; domains own no Task or Round state. */
export async function runExperiment(root: string, domain: ExperimentDomain, budget: ExperimentBudget = EXPERIMENT_BUDGET, host: { readonly apiKey?: string; readonly patchFiles?: readonly string[] } = {}) {
  const searchMode = budget.searchMode ?? 'root-only'
  const autoActivate = budget.autoActivate ?? true
  const sliceBudget = budget.slice ?? EXPERIMENT_BUDGET.slice
  if (domain.metric !== undefined && budget.trialsPerCase < MIN_CONTINUOUS_TRIALS) {
    throw new Error(`Continuous metric rounds require at least ${String(MIN_CONTINUOUS_TRIALS)} trials per case`)
  }
  const startedAt = Date.now(), deadlineAt = startedAt + budget.maxWallClockMs
  const campaignId = `experiment:${basename(root).replace(/[^A-Za-z0-9_-]/g, '-')}`
  const id = (suffix: string) => `${campaignId}:${suffix}`
  await mkdir(root)
  const cancellation = new AbortController()
  const patch = join(root, 'compaction.patch.yml')
  await copyFile(new URL('./experiment.patch.yml', import.meta.url), patch)
  const spike = await bootSpikeProfile({ home: join(root, 'dsh'), apiKey: host.apiKey, patchFiles: [patch, ...host.patchFiles ?? []] })
  const accounting = nativeAccounting(spike.ctx, { ...budget, deadlineAt, cancellation, log: join(root, 'requests.jsonl') })
  const service = await CommandService.open({ root: join(root, 'domain'), actor, clock: Date.now })
  const ledger = campaignLedger(accounting, () => service.facts())
  const timer = setTimeout(() => { cancellation.abort('campaign-deadline') }, Math.max(0, deadlineAt - Date.now()))
  const commit = <T extends 'method/registered' | 'method/activated'>(type: T, data: Parameters<typeof service.commit<T>>[0]['data'], id: string) => service.commit({
    command: { v: 1, commandId: id, tool: 'singularity-experiment', toolVersion: 1, actor, scope: {}, input: data as JsonValue }, type, data,
  }, [])
  const outcomes: unknown[] = []
  const priorSliceAttempts: Ref[] = []
  let failure: string | undefined
  const failures: unknown[] = []
  const options: AgentOptions = { provider: 'singularity-local', model: 'deepseek-v4.1-flash', reasoningEffort: ReasoningEffortId('max'), maxTokens: 128000 }
  const put = (id: string, value: unknown) => service.putObject(id, bytes(value))
  try {
    const provider = await put(id('acceptance'), { v: 1, kind: 'independent-contract-review', policy: AGENT_REVIEW_POLICY })
    const checkProvider = await put(id('frozen-check-acceptance'), { v: 1, kind: 'frozen-contract-checks' })
    const metric = domain.metric ?? { name: 'consumer-quality', aggregate: 'mean-verified-fraction' }
    const metricDescription = domain.metric === undefined ? 'Mean verified consumer fraction, higher is better.'
      : `Geometric mean of domain-normalized ${domain.metric.name} (${domain.metric.unit}); reference=1, higher is better, uncapped. Correctness is required. Public cases determine relative gain; validation must not regress.`
    const comparatorAsset = await put(id('comparator'), { v: 1, kind: 'paired-consumer-quality', metric })
    const baseTools = await Promise.all(['bash', 'job_output', 'job_list', 'job_kill'].map(name => put(`${campaignId}:base-tool:${name}`, { v: 1, name })))
    const protocol = await put(id('task-protocol'), taskProtocolReference)
    const tools = domain.tools === undefined ? [] : await freezeDomainTools(service, domain.tools)
    const snapshotValue: GlobalResourceSnapshot = { v: 1, skills: [], tools, baseTools, fallbackAcceptance: checkProvider, fallbackJoin: 'probe',
      documents: [{ id: 'task-protocol', description: 'Task planning, decomposition, schemas and resource usage.', object: protocol }] }
    const snapshot = await freezeGlobalResources(service, id('global-resources'), snapshotValue)
    const seed = await put(id('seed'), { v: 1, name: domain.id })
    const profile = await put(id('profile'), { v: 1, options, compaction: { threshold: 0.75, maxTokens: 128000 }, budget })
    const methodId = id('method-empty')
    const method = await service.putObject(methodId, bytes(sealMethodRevision({ v: 1, id: methodId, templates: [], skills: [], tools: [] })), 'method')
    await commit('method/registered', { revision: method }, id('register-empty'))
    await commit('method/activated', { next: method, approval: await put(id('initial-approval'), { v: 1, purpose: 'empty-initialization' }) }, id('activate-empty'))
    const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: service, agentOptions: options })
    const verify = await createAgentVerifier(spike.ctx, { root: join(root, 'reviews'), reader: service, tools, agentOptions: options, maxOutputBytes: budget.maxOutputBytes, maxSteps: budget.reviewMaxSteps })
    const verifierFor = (contract: TaskContract) => contract.acceptance.id === checkProvider.id && contract.acceptance.digest === checkProvider.digest
      ? { provider: checkProvider, checksOnly: true } as const : { provider: contract.acceptance, verify }
    const runTask = async (contract: TaskContract, slot?: EvaluationTaskRequest) => {
      const runId = `${contract.taskId}:run:1`, sessionId = `${runId}:session`
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract, agentOptions: options, base: { v: 1, seed } })
      const workspaceKey = computeDigest('object', { taskId: contract.taskId }).slice('sha256:'.length)
      return executeTaskTree({ ctx: spike.ctx, journalRoot: join(root, 'domain'), workspace: join(root, 'workspaces', workspaceKey),
        runId, sessionId, admission: { contract, attempt: 1, budgetReservation: { tokens: contract.limits.maxTokens, steps: contract.limits.maxStepsPerRun, deadlineAt: Math.min(deadlineAt, contract.limits.deadlineAt) } },
        composition, agentOptions: options, maxOutputBytes: budget.maxOutputBytes, verifier: verifierFor(contract), actor,
        maxActive: slot?.maxActive ?? budget.maxActive, workspaceRoot: join(root, 'runs'), summaries,
        signal: slot === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, slot.signal]),
        checkReportedBudget: value => accounting.available() && (slot?.checkReportedBudget(value) ?? true),
        ...(slot === undefined ? {} : { canOpenRun: slot.canOpenRun }),
        async resolveRun(input) { return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract, agentOptions: options, base: { v: 1, seed } }),
          agentOptions: options, maxOutputBytes: budget.maxOutputBytes, verifier: verifierFor(input.contract) } },
      }, service)
    }
    const contractFor = async (taskId: string, spec: TaskSpec, pinned: Ref, purpose: 'work' | 'evaluation', requestRef: Ref,
      acceptanceKind: 'review' | 'checks' | undefined = domain.acceptance) => {
      const revision = parseProtocolValue(methodRevisionSchema, JSON.parse(new TextDecoder().decode((await service.readObject(pinned, 'method')).bytes)))
      const templateId = revision.entryTemplateId ?? EXPLORE_TEMPLATE_ID
      const view = resolveTemplateView(revision, templateId, snapshotValue)
      if (view === undefined) throw new Error('Missing pinned entry template')
      const catalog = resourceAssetCatalog({ method: revision, exploration: snapshotValue })
      return admitRootTask({ taskId, spec, origin: { kind: 'root', purpose, requestRef }, method: pinned, template: { id: templateId, digest: pinned.digest },
        resources: { baseTools, exploration: snapshot,
          skills: view.skills.map(id => { const asset = catalog.skills.find(value => value.id === id); if (asset === undefined) throw new Error(`Missing skill ${id}`); return asset.bundle }),
          mcpServers: view.tools.map(id => { const asset = catalog.tools.find(value => value.id === id); if (asset === undefined) throw new Error(`Missing tool ${id}`); return asset.server.bundle }) },
        acceptance: acceptanceKind === 'checks' ? checkProvider : provider, environment: { seed, profile }, limits: { ...budget.task, deadlineAt } })
    }
    const bindSpec = async (id: string, taskDraft: Parameters<typeof bindDomainTask>[0], inputs: Readonly<Record<string, unknown>>) => bindDomainTask(taskDraft, Object.fromEntries(await Promise.all(
      Object.entries(inputs).map(async ([inputId, value]) => [inputId, await put(`${id}:${inputId}`, value)] as const),
    )))
    const sourceSpec = await bindSpec(id('source-input'), domain.sourceTask, domain.source)
    const cases: { spec: TaskSpec; ref: Ref; validation?: boolean; acceptanceKind: 'review' | 'checks' | undefined }[] = []
    for (const definition of domain.cases) {
      const spec = await bindSpec(id(`case-input:${definition.id}`), definition.task, definition.input)
      const acceptanceKind = definition.acceptance ?? domain.acceptance
      const contract = await contractFor(id(`definition:${definition.id}`), spec, method, 'evaluation', profile, acceptanceKind)
      cases.push({ spec, validation: definition.validation, acceptanceKind, ref: await freezeEvaluationCase(service, id(`case:${definition.id}`), evaluationCaseFromContract(contract)) })
    }
    await writeFile(join(root, 'launch.json'), JSON.stringify({ v: 1, startedAt, deadlineAt, pid: process.pid, sourceSpec, cases, budget,
      domain: domain.id, emptyMethod: method, independentReview: provider, checkAcceptance: checkProvider, compaction: 'native enabled; all llm/stream calls accounted' }, null, 2))
    console.log(JSON.stringify({ event: 'campaign-started', pid: process.pid, root, startedAt, deadlineAt }))
    for (let index = 0; index < budget.rounds && accounting.available(); index += 1) {
      const roundId = id(`round:${String(index + 1)}`), taskId = `${roundId}:source`
      const active = (await service.methodRoundState()).productionHead
      if (active === undefined) throw new Error('Missing active Method')
      const source = await runTask(await contractFor(taskId, sourceSpec, active, 'work', await put(`${taskId}:request`, { v: 1, purpose: 'domain-work' })))
      const eligible = sourceEligible(source.root.classification, budget.sourceMustVerify)
      if (!eligible) {
        const outcome = { roundId, source: source.root.classification,
          reason: source.root.classification === 'invalid' ? 'source-not-eligible-for-rsi' : 'source-not-verified',
          usage: { ...accounting.usage } }
        outcomes.push(outcome)
        await writeFile(join(root, `round-${String(index + 1)}.json`), JSON.stringify(outcome, null, 2))
        console.log(JSON.stringify({ event: 'round-finished', ...outcome }))
        break
      }
      const trace = await sealPublicTrace({ ctx: spike.ctx, service, actor, rootTaskId: taskId, summaries, acceptsExecutionRecord: () => true })
      if (!accounting.available()) break
      const remaining = Math.max(1, deadlineAt - Date.now())
      const plan = { v: 1 as const, cases: cases.filter(value => !value.validation).map(value => value.ref), validationCases: cases.filter(value => value.validation).map(value => value.ref),
        metric,
        thresholds: { minDelta: 0.01, maxRegression: 0, ...(domain.metric === undefined ? { maxRelativeCostIncrease: 1 } : {}) }, trialsPerCase: budget.trialsPerCase,
        proposerBudget: { ...budget.proposerBudget, maxWallClockMs: remaining }, budget: { ...budget.evaluationBudget, maxWallClockMs: remaining },
        validation: 'required-by-domain' as const, claim: 'domain-evaluation' as const, comparator: comparatorAsset, sourceSeed: seed, expectedPreviousActiveMethod: active }
      await openRsiRound({ service, actor, roundId, sourceTrace: trace.trace, baseMethod: active, plan, proposerSessionId: `${roundId}:proposer` })
      const workspace = join(root, 'proposers', String(index + 1)); await mkdir(workspace, { recursive: true })
      const publicEvaluation = { goal: 'Improve reusable reasoning, workflow and interfaces across different real consumer tasks. Instance outputs stay in Task results.',
        metric: `${metricDescription} Report total tokens and elapsed time separately.`,
        thresholds: [domain.metric === undefined ? 'Public quality gain at least 0.01 with no per-case regression; reported token cost at most 2x baseline.' : 'Public geometric-mean performance gain at least 1% with no per-case regression. Generation costs are reported separately.'], validationPolicy: 'required-by-domain' as const,
        publicCases: domain.cases.filter(value => !value.validation).map(value => ({ id: value.id, description: value.description })) }
      let proposalRecord: Ref
      let proposalRef: Ref | undefined
      let slice: Awaited<ReturnType<typeof runSliceCampaign>> | undefined
      if (searchMode === 'slice-v1') {
        const base = parseProtocolValue(methodRevisionSchema,
          parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode((await service.readObject(active, 'method')).bytes)))
        const hostFingerprint = `dsh:${String(options.provider)}:${String(options.model)}:${String(options.reasoningEffort)}`
        const sliceDeadlineAt = Math.min(deadlineAt, Date.now() + sliceBudget.maxWallClockMs)
        const points = await captureReplayPoints({ store: service, trace: trace.trace, state: await service.taskRunState([]), base,
          hostFingerprint, campaignDeadlineAt: sliceDeadlineAt, requireClosed: sliceBudget.requireClosed,
          baselinePolicy: sliceBudget.baselinePolicy,
          metricRelativeTolerance: sliceBudget.metricRelativeTolerance })
        let proposerUsed: UsageRecord = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
        const addUsage = (value: UsageRecord) => {
          proposerUsed = { inputTokens: proposerUsed.inputTokens + value.inputTokens,
            outputTokens: proposerUsed.outputTokens + value.outputTokens, steps: proposerUsed.steps + value.steps,
            unknownRequests: proposerUsed.unknownRequests + value.unknownRequests }
        }
        slice = await runSliceCampaign({ service, actor, roundId, roundIndex: index, pointCandidates: points,
          rootPlan: plan, baseMethod: active, hostFingerprint,
          comparator: { asset: comparatorAsset, describeMetric: () => ({ name: domain.metric?.name ?? 'consumer-quality', direction: 'higher-is-better', unit: domain.metric?.unit ?? 'verified-fraction', costObjective: false }), compare: domain.metric === undefined ? compareVerifiedFraction : compareMetricScores },
          comparatorKind: domain.metric === undefined ? 'verified-fraction' : 'metric-scores', finalistPolicy: sliceBudget.finalistPolicy,
          history: await buildProposalHistory({ service, roundId, attemptRefs: priorSliceAttempts }), requireClosed: sliceBudget.requireClosed,
          localTrials: budget.trialsPerCase, localThresholds: plan.thresholds,
          localBudget: { ...budget.evaluationBudget, maxWallClockMs: Math.max(1, sliceDeadlineAt - Date.now()) },
          budget: { maxTokens: sliceBudget.maxTokens, maxRuns: sliceBudget.maxRuns, maxWallClockMs: sliceBudget.maxWallClockMs },
          costs: ledger, maxCandidates: sliceBudget.maxCandidates, deadlineAt: sliceDeadlineAt, signal: cancellation.signal,
          draft: async (point, history, attemptId) => {
            // Native session and workspace paths must stay under one component.
            const attemptKey = computeDigest('object', { attemptId }).slice('sha256:'.length, 'sha256:'.length + 32)
            const draftWorkspace = join(root, 'slice-proposers', attemptKey)
            await mkdir(draftWorkspace, { recursive: true })
            const drafted = await draftRsiPatch({ ctx: spike.ctx, service, actor, roundId,
              proposalSessionId: `slice-proposer:${attemptKey}`, recordId: `${attemptId}:proposer-record`, workspace: draftWorkspace,
              agentOptions: options, publicEvaluation, sharedBudget: { deadlineAt: sliceDeadlineAt,
                maxTokens: plan.proposerBudget.maxTokens, maxSteps: plan.proposerBudget.maxSteps, used: proposerUsed },
              focus: point.templateId === EXPLORE_TEMPLATE_ID ? undefined : point.templateId, history })
            addUsage(drafted.usage)
            return drafted
          },
          extendHistory: (history, attemptRef) => extendProposalHistory({ service, history, attemptRefs: [attemptRef] }),
          runTask: async (point, request) => {
            const methodValue = parseProtocolValue(methodRevisionSchema,
              parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode((await service.readObject(request.slot.method, 'method')).bytes)))
            const contract = await contractForLocalSlot({ store: service, point, base, candidate: request.slot.arm === 'candidate' ? methodValue : undefined,
              arm: request.slot.arm, caseRef: request.slot.caseRef, taskId: request.slot.taskId, requestRef: request.requestRef })
            await runTask(contract, request)
          },
          clock: Date.now })
        proposalRecord = slice.resultRef
        priorSliceAttempts.push(...slice.result.attempts)
        if (slice.result.outcome === 'finalist') {
          const finalist = await readSliceFinalist(service, slice.result, active)
          proposalRef = await submitMethodPatch({ service, actor, roundId, value: finalist.patch, mode: 'frozen' })
        } else {
          // No finalist means no root comparison: the Round has insufficient evidence,
          // never a business no-improvement verdict.
          await closeRsiRound({ service, actor }, { roundId, outcome: 'insufficient-evidence',
            reason: slice.result.reason ?? `slice-campaign-${slice.result.outcome}` })
        }
      } else {
        const proposal = await executeRsiProposer({ ctx: spike.ctx, service, actor, roundId, workspace, agentOptions: options, publicEvaluation })
        proposalRecord = proposal.recordRef
        proposalRef = proposal.proposalRef
      }
      const precheck = proposalRef === undefined ? undefined : await precheckMethodPatch({ service, actor, roundId })
      const evaluation = precheck?.accepted === true ? await evaluateRsiCandidate({ service, actor, roundId,
        comparator: { asset: comparatorAsset, describeMetric: () => ({ name: domain.metric?.name ?? 'consumer-quality', direction: 'higher-is-better', unit: domain.metric?.unit ?? 'verified-fraction', costObjective: false }), compare: domain.metric === undefined ? compareVerifiedFraction : compareMetricScores },
        async runTask(slot) { const value = cases.find(value => value.ref.id === slot.slot.caseRef.id); if (value === undefined) throw new Error('Missing frozen case'); await runTask(await contractFor(slot.slot.taskId, value.spec, slot.slot.method, 'evaluation', slot.requestRef, value.acceptanceKind), slot) },
      }) : undefined
      let activation
      if (evaluation?.comparison.outcome === 'improved' && autoActivate) {
        const next = (await service.methodRoundState()).rounds.get(roundId)?.candidateMethod
        if (next === undefined) throw new Error('Missing improved candidate')
        const approval = await put(`${roundId}:approval`, { v: 1, authorization: 'operator-authorized-evaluated-winner', expectedPrevious: active, next })
        activation = await activateRoundCandidate({ service, actor, roundId, approval })
      }
      const outcome = { roundId, source: source.root.classification, trace: trace.trace, proposal: proposalRecord, precheck,
        ...(slice === undefined ? {} : { slice: slice.resultRef }), comparison: evaluation?.comparison, activation, usage: { ...accounting.usage } }
      outcomes.push(outcome)
      await writeFile(join(root, `round-${String(index + 1)}.json`), JSON.stringify(outcome, null, 2))
      console.log(JSON.stringify({ event: 'round-finished', ...outcome }))
    }
  } catch (error) {
    failures.push(error)
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    clearTimeout(timer)
    try { await spike.dispose() } catch (error) { failures.push(error) }
    accounting.dispose()
    try { await service.close() } catch (error) { failures.push(error) }
    await writeFile(join(root, 'result.json'), JSON.stringify({ v: 1, startedAt, finishedAt: Date.now(), deadlineAt, outcomes, usage: accounting.usage, failure }, null, 2))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Domain experiment failed')
}
