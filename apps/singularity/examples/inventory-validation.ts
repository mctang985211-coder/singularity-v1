import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
compareInventory,
INVENTORY_CASES,INVENTORY_COMPARATOR_ASSET,INVENTORY_PUBLIC_GUIDE,INVENTORY_VERIFIER_ASSET,
inventoryGuidedBaseline,inventoryMetric,inventoryTaskSpec,inventoryWarehouseTaskSpec,verifyInventory,
} from '@singularity/domain-inventory'
import type { FactPayloadMap,FactType,GlobalResourceSnapshot,JsonValue,Ref,TaskContract,TaskLimits } from '@singularity/protocol'
import { admitRootTask,canonicalize,closedObject,EXPLORE_TEMPLATE_ID,methodRevisionSchema,parseJsonText,parseProtocolValue,resolveTemplateView,roundPlanSchema,taskLimitsSchema } from '@singularity/protocol'
import type { EvaluationComparator,EvaluationTaskRequest } from '@singularity/runtime'
import {
CommandService,evaluateRsiCandidate,
evaluationCaseFromContract,
executeRsiProposer,executeTaskTree,
freezeEvaluationCase,freezeGlobalResources,
openRsiRound,
precheckMethodPatch,sealPublicTrace,snapshotSession,taskProtocolReference,
} from '@singularity/runtime'

import { bootSpikeProfile,buildSingleRunComposition } from '../src/host-composition.ts'

const actor = { kind: 'runtime', id: 'inventory-validation' } as const
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
const positiveInteger = roundPlanSchema.shape.budget.shape.maxRuns
const routeId = methodRevisionSchema.shape.id.min(1)

/** Trusted launch configuration; admitted Tasks and Round plans retain frozen values. */
export const inventoryValidationConfigSchema = closedObject({
  maxRequests: positiveInteger.optional(),
  maxReportedTokens: positiveInteger.optional(),
  maxOutputTokens: positiveInteger.optional(),
  maxOutputBytes: positiveInteger.optional(),
  objective: routeId.refine(value => value === 'correctness' || value === 'reported-tokens').optional(),
  scenario: routeId.refine(value => value === 'single-csv' || value === 'warehouse-network').optional(),
  provider: routeId.optional(),
  model: routeId.optional(),
  reasoningEffort: routeId.optional(),
  profilePatches: routeId.array().optional(),
  maxActive: positiveInteger.optional(),
  deadlineAt: positiveInteger.optional(),
  task: closedObject({
    maxRuns: positiveInteger.optional(), maxTokens: positiveInteger.optional(), maxStepsPerRun: positiveInteger.optional(),
    maxDepth: taskLimitsSchema.shape.maxDepth.int().nonnegative().optional(), maxTasks: positiveInteger.optional(), maxBatchChildren: positiveInteger.optional(),
  }).optional(),
  proposerBudget: roundPlanSchema.shape.proposerBudget.partial().optional(),
  evaluationBudget: roundPlanSchema.shape.budget.partial().optional(),
})
export type InventoryValidationConfig = ReturnType<typeof inventoryValidationConfigSchema.parse>

export function resolveInventoryValidationBudget(value: unknown, startedAt: number, now = Date.now()) {
  const config = parseProtocolValue(inventoryValidationConfigSchema, value)
  const deadlineAt = config.deadlineAt ?? startedAt + 60 * 60_000
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= startedAt) throw new Error('Validation deadline must be an absolute timestamp after the cumulative start')
  const task = { maxRuns: 2, maxTokens: 1_000_000, maxStepsPerRun: 96, maxDepth: 4, maxTasks: 15, maxBatchChildren: 4, ...config.task }
  const remainingWindow = Math.max(1, deadlineAt - now)
  return {
    maxRequests: config.maxRequests ?? 2000,
    maxReportedTokens: config.maxReportedTokens ?? 200_000_000,
    maxOutputTokens: config.maxOutputTokens ?? 30_000,
    maxOutputBytes: config.maxOutputBytes ?? 16 * 1024 * 1024,
    objective: config.objective ?? 'correctness',
    scenario: config.scenario ?? 'single-csv',
    provider: config.provider ?? 'singularity-local', model: config.model ?? 'deepseek-v4.1-flash',
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    profilePatches: config.profilePatches ?? [], maxActive: config.maxActive ?? 1,
    deadlineAt,
    maxWallClockMs: deadlineAt - startedAt,
    task,
    proposerBudget: { maxSteps: 96, maxTokens: 2_000_000, maxWallClockMs: remainingWindow, ...config.proposerBudget },
    evaluationBudget: { maxRuns: INVENTORY_CASES.length * 2 * task.maxTasks * task.maxRuns,
      maxTokens: task.maxTokens * (INVENTORY_CASES.length * 2 + 2), maxWallClockMs: remainingWindow,
      maxActiveRuns: config.maxActive ?? 1, ...config.evaluationBudget },
  }
}

/** Bounded public-domain exercise; credentials stay in the boot launch environment. */
export async function runInventoryValidation(root: string, rounds = 1, previousRoot?: string, configuration: number | InventoryValidationConfig = {}): Promise<unknown> {
  const previous = previousRoot === undefined ? undefined : parseJsonText(await readFile(join(previousRoot, 'result.json'), 'utf8'))
  if (previous !== undefined && (typeof previous !== 'object' || previous === null || Array.isArray(previous))) throw new Error('Prior validation result must be an object')
  const priorUsage = previous?.usage
  if (priorUsage !== undefined && (typeof priorUsage !== 'object' || priorUsage === null || Array.isArray(priorUsage))) throw new Error('Prior validation usage must be an object')
  const priorTokens = priorUsage?.tokens ?? 0, priorSteps = priorUsage?.steps ?? 0, priorUnknown = priorUsage?.unknown ?? 0
  const priorRequests = previous?.requestBoundaries ?? 0
  const startedAt = previous?.startedAt ?? Date.now()
  if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error('Validation rounds must be a positive safe integer')
  if (![startedAt, priorTokens, priorSteps, priorUnknown, priorRequests].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) throw new Error('Prior validation counters must be nonnegative safe integers')
  if (typeof startedAt !== 'number' || typeof priorTokens !== 'number' || typeof priorSteps !== 'number'
    || typeof priorUnknown !== 'number' || typeof priorRequests !== 'number') throw new Error('Prior validation counters must be numeric')
  const budget = resolveInventoryValidationBudget(typeof configuration === 'number' ? { deadlineAt: configuration } : configuration, startedAt)
  const { deadlineAt } = budget
  if (Date.now() >= deadlineAt || priorUnknown !== 0 || priorTokens >= budget.maxReportedTokens || priorRequests >= budget.maxRequests) {
    throw new Error('Validation launch budget is exhausted or has unknown usage')
  }
  await mkdir(dirname(resolve(root)), { recursive: true })
  await mkdir(root)
  const cancellation = new AbortController()
  const sessions = new Map<string, Session>()
  let requestBoundaries = priorRequests
  const spike = await bootSpikeProfile({ home: join(root, 'dsh'), patchFiles: budget.profilePatches })
  const service = await CommandService.open({ root: join(root, 'domain'), actor, clock: Date.now }).catch(async (error: unknown) => {
    try { await spike.dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Validation startup failed') }
    throw error instanceof Error ? error : new Error(String(error), { cause: error })
  })
  const usage = (final = false) => [...sessions.values()].map(session => snapshotSession(session, final).usage)
    .reduce((total, value) => ({ tokens: total.tokens + value.inputTokens + value.outputTokens,
      steps: total.steps + value.steps, unknown: total.unknown + value.unknownRequests }), { tokens: priorTokens, steps: priorSteps, unknown: priorUnknown })
  const withinBudget = () => {
    const current = usage()
    return !cancellation.signal.aborted && Date.now() < deadlineAt && current.tokens < budget.maxReportedTokens && current.unknown === 0
  }
  const canPurchase = () => withinBudget() && requestBoundaries < budget.maxRequests
  const disposeGate = spike.ctx.on('agent/pre-step', ({ agent }, next) => {
    sessions.set(String(agent.session.id), agent.session)
    if (!canPurchase()) {
      cancellation.abort('validation-budget-exhausted')
      agent.cancel({ kind: 'hook', reason: 'validation-budget-exhausted' })
      return Promise.resolve({ kind: 'reject' as const })
    }
    requestBoundaries += 1
    console.log(JSON.stringify({ sessionId: String(agent.session.id), requestBoundary: requestBoundaries, reported: usage() }))
    return next()
  })
  const timer = setTimeout(() => {
    cancellation.abort('validation-deadline')
    for (const session of sessions.values()) spike.ctx.agents.get(session.id)?.cancel({ kind: 'hook', reason: 'validation-deadline' })
  }, deadlineAt - Date.now())
  const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
    command: { v: 1, commandId: id, tool: 'inventory-host', toolVersion: 1, actor, scope: {}, input: data as JsonValue }, type, data,
  }, [])
  const outcomes: unknown[] = []
  let failure: string | undefined
  const failures: unknown[] = []
  try {
    const provider = await service.putObject('inventory:verifier', bytes(INVENTORY_VERIFIER_ASSET))
    const comparatorRef = await service.putObject('inventory:comparator', bytes(INVENTORY_COMPARATOR_ASSET))
    const baseTool = await service.putObject('base-tool:bash', bytes({ v: 1, name: 'bash' }))
    const document = await service.putObject('inventory:public-guide', bytes({ v: 1, text: INVENTORY_PUBLIC_GUIDE }))
    const protocol = await service.putObject('singularity:task-protocol', bytes(taskProtocolReference))
    const snapshotValue: GlobalResourceSnapshot = { v: 1,
      documents: [{ id: 'inventory-guide', description: 'Public CSV reconciliation rules.', object: document },
        { id: 'task-protocol', description: 'Current planning hierarchy, Task schemas and native skill paths; read before inferring protocol rules from errors.', object: protocol }],
      skills: [], tools: [], baseTools: [baseTool], fallbackAcceptance: provider, fallbackJoin: 'probe' }
    const snapshot = await freezeGlobalResources(service, 'inventory:global-resources', snapshotValue)
    const seed = await service.putObject('inventory:seed', bytes({ v: 1, seed: 'inventory-2026-10-31' }))
    const options: AgentOptions = { provider: budget.provider, model: budget.model, maxTokens: budget.maxOutputTokens,
      ...(budget.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(budget.reasoningEffort) }) }
    const profile = await service.putObject('inventory:profile', bytes({ v: 1, profile: 'singularity', agentOptions: options }))
    const baseline = inventoryGuidedBaseline(provider, budget.scenario === 'warehouse-network' ? 'warehouse-network' : 'single-csv')
    for (const asset of baseline.assets) await service.putObject(asset.ref.id, bytes(asset.value))
    const method = await service.putObject(baseline.method.id, bytes(baseline.method), 'method')
    await commit('method/registered', { revision: method }, 'inventory:register-baseline')
    const approval = await service.putObject('inventory:initial-approval', bytes({ v: 1, purpose: 'isolated-validation-domain-initialization' }))
    await commit('method/activated', { next: method, approval }, 'inventory:initialize-head')
    const cases: { readonly ref: Ref; readonly inputs: readonly Ref[] }[] = []
    const comparator: EvaluationComparator = { asset: comparatorRef,
      describeMetric: inventoryMetric,
      compare: compareInventory }
    const taskLimits: TaskLimits = { ...budget.task, deadlineAt }
    const runTask = async (contract: TaskContract, slot?: EvaluationTaskRequest) => {
      const runId = `${contract.taskId}:run:1`, sessionId = `${runId}:session`
      const workspace = join(root, 'workspaces', Buffer.from(contract.taskId).toString('hex'))
      const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract,
        agentOptions: options, base: { v: 1, seed } })
      return executeTaskTree({ ctx: spike.ctx, journalRoot: join(root, 'domain'), workspace, runId, sessionId,
        admission: { contract, attempt: 1, budgetReservation: { tokens: contract.limits.maxTokens, steps: contract.limits.maxStepsPerRun, deadlineAt } },
        composition, agentOptions: options, maxOutputBytes: budget.maxOutputBytes, verifier: { provider, verify: verifyInventory }, actor,
        maxActive: slot?.maxActive ?? budget.maxActive, workspaceRoot: join(root, 'runs'),
        signal: slot === undefined ? cancellation.signal : AbortSignal.any([cancellation.signal, slot.signal]),
        checkReportedBudget: reported => withinBudget() && (slot?.checkReportedBudget(reported) ?? true),
        ...(slot === undefined ? {} : { canOpenRun: slot.canOpenRun }),
        async resolveRun(input) {
          return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId,
            contract: input.contract, agentOptions: options, base: { v: 1, seed } }),
            agentOptions: options, maxOutputBytes: budget.maxOutputBytes, verifier: { provider: input.contract.acceptance, verify: verifyInventory } }
        },
      }, service)
    }
    const contractFor = async (taskId: string, inputs: readonly Ref[], pinned: Ref, purpose: 'work' | 'evaluation', requestRef: Ref) => {
      const spec = budget.scenario === 'warehouse-network' ? inventoryWarehouseTaskSpec(inputs) : inventoryTaskSpec(inputs[0])
      const revision = parseProtocolValue(methodRevisionSchema,
        parseJsonText(new TextDecoder().decode((await service.readObject(pinned, 'method')).bytes)))
      const templateId = revision.entryTemplateId ?? EXPLORE_TEMPLATE_ID
      const view = resolveTemplateView(revision, templateId, snapshotValue)
      if (view === undefined) throw new Error('Pinned inventory Method entry is absent')
      return admitRootTask({ taskId,
        spec,
        origin: { kind: 'root', purpose, requestRef }, method: pinned,
        template: { id: templateId, digest: pinned.digest }, resources: { baseTools: [baseTool],
          skills: view.skills.map(id => {
            const asset = revision.skills.find(asset => asset.id === id)
            if (asset === undefined) throw new Error('Inventory entry skill is absent')
            return asset.bundle
          }),
          mcpServers: view.tools.map(id => {
            const asset = revision.tools.find(asset => asset.id === id)
            if (asset === undefined) throw new Error('Inventory entry MCP server is absent')
            return asset.server.bundle
          }), exploration: snapshot },
        acceptance: provider, environment: { seed, profile }, limits: taskLimits })
    }
    for (const value of INVENTORY_CASES) {
      const csvs = budget.scenario === 'warehouse-network' ? [value.csv,
        // Public second warehouse: overlapping SKUs, cancellations and cross-warehouse totals.
        `sku,delta\n${value.csv.trimEnd().split('\n').slice(1).reverse().map((line, index) => {
          const [sku, delta] = line.split(',')
          return `${sku},${String(-Number(delta) + index)}`
        }).join('\n')}\n`] : [value.csv]
      const inputs: Ref[] = []
      for (const [index, csv] of csvs.entries()) inputs.push(await service.putObject(`inventory:input:${value.id}:${String(index)}`, new TextEncoder().encode(csv)))
      const definition = await contractFor(`inventory:case-definition:${value.id}`, inputs, method, 'evaluation', profile)
      cases.push({ inputs, ref: await freezeEvaluationCase(service, `inventory:case:${value.id}`, evaluationCaseFromContract(definition)) })
    }
    for (let index = 0; index < rounds && canPurchase(); index += 1) {
      const roundId = `inventory:round:${String(index + 1)}`
      const taskId = `${roundId}:source`
      const sourceRequest = await service.putObject(`${taskId}:request`, bytes({ v: 1, domain: 'inventory', purpose: 'work' }))
      const activeMethod = (await service.methodRoundState()).productionHead
      if (activeMethod === undefined) throw new Error('Inventory validation has no active Method')
      const publicCases = cases.slice(0, 2)
      const sourceCase = publicCases.at(index % publicCases.length), validationCase = cases.at(2)
      if (sourceCase === undefined || validationCase === undefined) throw new Error('Inventory validation cases are absent')
      const source = await runTask(await contractFor(taskId, sourceCase.inputs, activeMethod, 'work', sourceRequest))
      const trace = await sealPublicTrace({ ctx: spike.ctx, service, actor, rootTaskId: taskId })
      const costObjective = budget.objective === 'reported-tokens'
      const plan = { v: 1 as const, cases: cases.slice(0, 2).map(value => value.ref), validationCases: [validationCase.ref],
        metric: { name: costObjective ? 'inventory-reported-tokens' : 'inventory-correctness' },
        thresholds: { minDelta: costObjective ? 1000 : 0.1, maxRegression: 0, maxRelativeCostIncrease: costObjective ? 0 : 1 },
        trialsPerCase: 1, proposerBudget: { ...budget.proposerBudget, maxWallClockMs: Math.max(1, Math.min(budget.proposerBudget.maxWallClockMs, deadlineAt - Date.now())) },
        budget: { ...budget.evaluationBudget, maxWallClockMs: Math.max(1, Math.min(budget.evaluationBudget.maxWallClockMs, deadlineAt - Date.now())) },
        validation: 'required-by-domain' as const, claim: 'domain-evaluation' as const, comparator: comparatorRef,
        sourceSeed: seed, expectedPreviousActiveMethod: activeMethod }
      await openRsiRound({ service, actor, roundId, sourceTrace: trace.trace, baseMethod: activeMethod, plan, proposerSessionId: `${roundId}:proposer` })
      const proposerWorkspace = join(root, 'proposers', String(index + 1))
      await mkdir(proposerWorkspace, { recursive: true })
      const proposal = await executeRsiProposer({ ctx: spike.ctx, service, actor, roundId, workspace: proposerWorkspace, agentOptions: options,
        publicEvaluation: { goal: 'Improve reusable inventory reconciliation workflow from the sealed source. Keep assets and examples generic.',
          metric: costObjective ? 'Mean reported tokens per complete Task subtree; lower is better. Every baseline and candidate report must pass exact correctness.' : 'Mean exact inventory report correctness across all paired cases and repetitions.',
          thresholds: [costObjective ? 'Save at least 1000 mean reported tokens; no per-case cost regression; preserve exact correctness on every trial.' : 'Correctness delta at least 0.1; no case regression; relative token increase at most 1.0.'],
          validationPolicy: 'required-by-domain', publicCases: INVENTORY_CASES.slice(0, 2).map(value => ({ id: value.id, description: 'Public signed inventory transactions.' })) } })
      const checked = proposal.proposalRef === undefined ? undefined : await precheckMethodPatch({ service, actor, roundId })
      const evaluation = checked?.accepted === true ? await evaluateRsiCandidate({ service, actor, roundId, comparator,
        async runTask(slot) {
          const value = cases.find(value => value.ref.digest === slot.slot.caseRef.digest && value.ref.id === slot.slot.caseRef.id)
          if (value === undefined) throw new Error('Unknown frozen inventory case')
          await runTask(await contractFor(slot.slot.taskId, value.inputs, slot.slot.method, 'evaluation', slot.requestRef), slot)
        },
      }) : undefined
      const result = { roundId, source: { classification: source.root.classification, trace: trace.trace },
        proposal: { recordRef: proposal.recordRef, usage: proposal.usage, failure: proposal.failure }, precheck: checked,
        evaluation: evaluation === undefined ? undefined : { comparisonRef: evaluation.comparisonRef, comparison: evaluation.comparison } }
      outcomes.push(result)
      await writeFile(join(root, `round-${String(index + 1)}.json`), JSON.stringify(result, null, 2))
      console.log(JSON.stringify({ roundId, source: source.root.classification, proposer: proposal.proposalRef !== undefined,
        candidate: checked?.accepted, evaluation: evaluation?.comparison.outcome, usage: usage() }))
    }
  } catch (error) {
    failures.push(error)
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    clearTimeout(timer)
    disposeGate()
    try { await spike.dispose() } catch (error) { failures.push(error) }
    try { await service.close() } catch (error) { failures.push(error) }
  }
  const result = { v: 1, startedAt, finishedAt: Date.now(), previousRoot, budget,
    requestBoundaries, usage: usage(true), outcomes, ...(failure === undefined ? {} : { failure }) }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  if (failures.length === 1 && failures[0] instanceof Error) throw failures[0]
  if (failures.length > 0) throw new AggregateError(failures, 'Validation execution or cleanup failed')
  return result
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const args = process.argv.slice(2)
  const configIndex = args.indexOf('--config')
  let configuration: InventoryValidationConfig = {}
  if (configIndex >= 0) {
    const path = args.at(configIndex + 1)
    if (path === undefined) throw new Error('--config requires a JSON configuration path')
    configuration = parseProtocolValue(inventoryValidationConfigSchema, parseJsonText(await readFile(resolve(path), 'utf8')))
    if (configuration.profilePatches !== undefined) configuration = {
      ...configuration, profilePatches: configuration.profilePatches.map(patch => resolve(dirname(resolve(path)), patch)),
    }
    args.splice(configIndex, 2)
  }
  if (args.at(3) !== undefined) configuration = { ...configuration, deadlineAt: Number(args.at(3)) }
  await runInventoryValidation(resolve(args.at(0) ?? 'artifacts/inventory-validation'), Number(args.at(1) ?? 1), args.at(2), configuration)
}
