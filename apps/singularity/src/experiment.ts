import { copyFile,mkdir,writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GlobalResourceSnapshot,JsonValue,Ref,RoundPlan,TaskContract,TaskLimits,TaskSpec,ToolAsset } from '@singularity/protocol'
import { admitRootTask,canonicalize,EXPLORE_TEMPLATE_ID,methodRevisionSchema,parseProtocolValue,resolveTemplateView,sealMethodRevision } from '@singularity/protocol'
import type { CasObjectWriter,EvaluationTaskRequest } from '@singularity/runtime'
import { activateRoundCandidate,AGENT_REVIEW_POLICY,createAgentVerifier,compareReportedTokens,CommandService,ContractSummaryService,evaluateRsiCandidate,evaluationCaseFromContract,executeRsiProposer,executeTaskTree,freezeEvaluationCase,freezeGlobalResources,openRsiRound,precheckMethodPatch,sealPublicTrace,taskProtocolReference } from '@singularity/runtime'

import { bootSpikeProfile,buildSingleRunComposition } from './host-composition.ts'
import { nativeAccounting } from './accounting.ts'

const maxWallClockMs = 12 * 60 * 60 * 1000
const maxReportedTokens = 1_000_000_000

/** All agents share the campaign cap; child budgets do not multiply it. */
export const EXPERIMENT_BUDGET = {
  maxWallClockMs,
  maxReportedTokens,
  maxRequests: 4000,
  rounds: 3,
  maxActive: 4,
  maxOutputBytes: 256 * 1024 * 1024,
  task: { maxRuns: 3, maxStepsPerRun: 4096, maxTokens: maxReportedTokens,
    maxDepth: 8, maxTasks: 256, maxBatchChildren: 8 } satisfies Omit<TaskLimits, 'deadlineAt'>,
  proposerBudget: { maxSteps: 4096, maxTokens: maxReportedTokens,
    maxWallClockMs } satisfies RoundPlan['proposerBudget'],
  evaluationBudget: { maxRuns: 6 * 256 * 3, maxTokens: maxReportedTokens,
    maxWallClockMs, maxActiveRuns: 4 } satisfies RoundPlan['budget'],
}

export interface ExperimentDomain {
  readonly id: string
  readonly source: JsonValue
  readonly cases: readonly { readonly id: string; readonly input: JsonValue; readonly description: string; readonly validation?: boolean; readonly task?: (input: Ref) => TaskSpec }[]
  task(input: Ref): TaskSpec
  tools(writer: CasObjectWriter): Promise<ToolAsset[]>
}
const actor = { kind: 'runtime', id: 'singularity-experiment' } as const
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
/** Operator host for any public domain package; domains own no Task or Round state. */
export async function runExperiment(root: string, domain: ExperimentDomain, budget = EXPERIMENT_BUDGET) {
  const startedAt = Date.now(), deadlineAt = startedAt + budget.maxWallClockMs
  await mkdir(root)
  const cancellation = new AbortController()
  const patch = join(root, 'compaction.patch.yml')
  await copyFile(new URL('./experiment.patch.yml', import.meta.url), patch)
  const spike = await bootSpikeProfile({ home: join(root, 'dsh'), patchFiles: [patch] })
  const accounting = nativeAccounting(spike.ctx, { ...budget, deadlineAt, cancellation, log: join(root, 'requests.jsonl') })
  const service = await CommandService.open({ root: join(root, 'domain'), actor, clock: Date.now })
  const timer = setTimeout(() => { cancellation.abort('campaign-deadline') }, Math.max(0, deadlineAt - Date.now()))
  const commit = <T extends 'method/registered' | 'method/activated'>(type: T, data: Parameters<typeof service.commit<T>>[0]['data'], id: string) => service.commit({
    command: { v: 1, commandId: id, tool: 'singularity-experiment', toolVersion: 1, actor, scope: {}, input: data as JsonValue }, type, data,
  }, [])
  const outcomes: unknown[] = []
  let failure: string | undefined
  const failures: unknown[] = []
  const options: AgentOptions = { provider: 'singularity-local', model: 'deepseek-flash', reasoningEffort: ReasoningEffortId('max'), maxTokens: 40000 }
  const put = (id: string, value: unknown) => service.putObject(id, bytes(value))
  try {
    const provider = await put('experiment:acceptance', { v: 1, kind: 'independent-contract-review', policy: AGENT_REVIEW_POLICY })
    const comparatorAsset = await put('experiment:comparator', { v: 1, metric: 'reported-tokens' })
    const baseTools = await Promise.all(['bash', 'job_output', 'job_list', 'job_kill'].map(name => put(`base-tool:${name}`, { v: 1, name })))
    const protocol = await put('experiment:task-protocol', taskProtocolReference)
    const tools = await domain.tools(service)
    const snapshotValue: GlobalResourceSnapshot = { v: 1, skills: [], tools, baseTools, fallbackAcceptance: provider, fallbackJoin: 'probe',
      documents: [{ id: 'task-protocol', description: 'Task planning, decomposition, schemas and resource usage.', object: protocol }] }
    const snapshot = await freezeGlobalResources(service, 'experiment:global-resources', snapshotValue)
    const seed = await put('experiment:seed', { v: 1, name: domain.id })
    const profile = await put('experiment:profile', { v: 1, options, compaction: { threshold: 0.75, maxTokens: 40000 }, budget })
    const method = await service.putObject('experiment:method-empty', bytes(sealMethodRevision({ v: 1, id: 'experiment:method-empty', templates: [], skills: [], tools: [] })), 'method')
    await commit('method/registered', { revision: method }, 'experiment:register-empty')
    await commit('method/activated', { next: method, approval: await put('experiment:initial-approval', { v: 1, purpose: 'empty-initialization' }) }, 'experiment:activate-empty')
    const summaries = new ContractSummaryService({ ctx: spike.ctx, writer: service, agentOptions: options })
    const verify = await createAgentVerifier(spike.ctx, { root: join(root, 'reviews'), reader: service, tools, agentOptions: options, maxOutputBytes: budget.maxOutputBytes })
    const runTask = async (contract: TaskContract, slot?: EvaluationTaskRequest) => {
      const runId = `${contract.taskId}:run:1`, sessionId = `${runId}:session`
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract, agentOptions: options, base: { v: 1, seed } })
      return executeTaskTree({ ctx: spike.ctx, journalRoot: join(root, 'domain'), workspace: join(root, 'workspaces', Buffer.from(contract.taskId).toString('hex')),
        runId, sessionId, admission: { contract, attempt: 1, budgetReservation: { tokens: contract.limits.maxTokens, steps: contract.limits.maxStepsPerRun, deadlineAt } },
        composition, agentOptions: options, maxOutputBytes: budget.maxOutputBytes, verifier: { provider, verify }, actor,
        maxActive: slot?.maxActive ?? budget.maxActive, workspaceRoot: join(root, 'runs'), summaries,
        signal: slot === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, slot.signal]),
        checkReportedBudget: value => accounting.available() && (slot?.checkReportedBudget(value) ?? true),
        ...(slot === undefined ? {} : { canOpenRun: slot.canOpenRun }),
        async resolveRun(input) { return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract, agentOptions: options, base: { v: 1, seed } }),
          agentOptions: options, maxOutputBytes: budget.maxOutputBytes, verifier: { provider: input.contract.acceptance, verify } } },
      }, service)
    }
    const contractFor = async (taskId: string, spec: TaskSpec, pinned: Ref, purpose: 'work' | 'evaluation', requestRef: Ref) => {
      const revision = parseProtocolValue(methodRevisionSchema, JSON.parse(new TextDecoder().decode((await service.readObject(pinned, 'method')).bytes)))
      const templateId = revision.entryTemplateId ?? EXPLORE_TEMPLATE_ID
      const view = resolveTemplateView(revision, templateId, snapshotValue)
      if (view === undefined) throw new Error('Missing pinned entry template')
      return admitRootTask({ taskId, spec, origin: { kind: 'root', purpose, requestRef }, method: pinned, template: { id: templateId, digest: pinned.digest },
        resources: { baseTools, exploration: snapshot,
          skills: view.skills.map(id => { const asset = revision.skills.find(value => value.id === id); if (asset === undefined) throw new Error(`Missing skill ${id}`); return asset.bundle }),
          mcpServers: view.tools.map(id => { const asset = [...revision.tools, ...tools].find(value => value.id === id); if (asset === undefined) throw new Error(`Missing tool ${id}`); return asset.server.bundle }) },
        acceptance: provider, environment: { seed, profile }, limits: { ...budget.task, deadlineAt } })
    }
    const sourceSpec = domain.task(await put('experiment:source-input', domain.source))
    const cases: { spec: TaskSpec; ref: Ref; validation?: boolean }[] = []
    for (const definition of domain.cases) {
      const spec = (definition.task ?? domain.task)(await put(`experiment:case-input:${definition.id}`, definition.input))
      const contract = await contractFor(`experiment:definition:${definition.id}`, spec, method, 'evaluation', profile)
      cases.push({ spec, validation: definition.validation, ref: await freezeEvaluationCase(service, `experiment:case:${definition.id}`, evaluationCaseFromContract(contract)) })
    }
    await writeFile(join(root, 'launch.json'), JSON.stringify({ v: 1, startedAt, deadlineAt, pid: process.pid, sourceSpec, cases, budget,
      domain: domain.id, emptyMethod: method, independentReview: provider, compaction: 'native enabled; all llm/stream calls accounted' }, null, 2))
    console.log(JSON.stringify({ event: 'campaign-started', pid: process.pid, root, startedAt, deadlineAt }))
    for (let index = 0; index < budget.rounds && accounting.available(); index += 1) {
      const roundId = `experiment:round:${String(index + 1)}`, taskId = `${roundId}:source`
      const active = (await service.methodRoundState()).productionHead
      if (active === undefined) throw new Error('Missing active Method')
      const source = await runTask(await contractFor(taskId, sourceSpec, active, 'work', await put(`${taskId}:request`, { v: 1, purpose: 'domain-work' })))
      const trace = await sealPublicTrace({ ctx: spike.ctx, service, actor, rootTaskId: taskId, summaries, acceptsExecutionRecord: () => true })
      if (!accounting.available()) break
      const remaining = Math.max(1, deadlineAt - Date.now())
      const plan = { v: 1 as const, cases: cases.filter(value => !value.validation).map(value => value.ref), validationCases: cases.filter(value => value.validation).map(value => value.ref),
        metric: { name: 'reported-tokens' }, thresholds: { minDelta: 1000, maxRegression: 0 }, trialsPerCase: 1,
        proposerBudget: { ...budget.proposerBudget, maxWallClockMs: remaining }, budget: { ...budget.evaluationBudget, maxWallClockMs: remaining },
        validation: 'required-by-domain' as const, claim: 'domain-evaluation' as const, comparator: comparatorAsset, sourceSeed: seed, expectedPreviousActiveMethod: active }
      await openRsiRound({ service, actor, roundId, sourceTrace: trace.trace, baseMethod: active, plan, proposerSessionId: `${roundId}:proposer` })
      const workspace = join(root, 'proposers', String(index + 1)); await mkdir(workspace, { recursive: true })
      const proposal = await executeRsiProposer({ ctx: spike.ctx, service, actor, roundId, workspace, agentOptions: options,
        publicEvaluation: { goal: 'Improve reusable domain methods from sealed evidence; evaluate transfer across the supplied tasks. Instance outputs stay in Task results.',
          metric: 'Mean host-accounted reported tokens per complete verified Task subtree, lower is better. Every functional criterion must pass in both arms.',
          thresholds: ['Save at least 1000 mean reported tokens; no per-case cost regression. Failed functionality or missing usage is not comparable.'], validationPolicy: 'required-by-domain',
          publicCases: domain.cases.filter(value => !value.validation).map(value => ({ id: value.id, description: value.description })) } })
      const precheck = proposal.proposalRef === undefined ? undefined : await precheckMethodPatch({ service, actor, roundId })
      const evaluation = precheck?.accepted === true ? await evaluateRsiCandidate({ service, actor, roundId,
        comparator: { asset: comparatorAsset, describeMetric: () => ({ name: 'reported-tokens', direction: 'lower-is-better', unit: 'reported-tokens', costObjective: true }), compare: compareReportedTokens },
        async runTask(slot) { const value = cases.find(value => value.ref.id === slot.slot.caseRef.id); if (value === undefined) throw new Error('Missing frozen case'); await runTask(await contractFor(slot.slot.taskId, value.spec, slot.slot.method, 'evaluation', slot.requestRef), slot) },
      }) : undefined
      let activation
      if (evaluation?.comparison.outcome === 'improved') {
        const next = (await service.methodRoundState()).rounds.get(roundId)?.candidateMethod
        if (next === undefined) throw new Error('Missing improved candidate')
        const approval = await put(`${roundId}:approval`, { v: 1, authorization: 'operator-authorized-evaluated-winner', expectedPrevious: active, next })
        activation = await activateRoundCandidate({ service, actor, roundId, approval })
      }
      const outcome = { roundId, source: source.root.classification, trace: trace.trace, proposal: proposal.recordRef, precheck,
        comparison: evaluation?.comparison, activation, usage: { ...accounting.usage } }
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
