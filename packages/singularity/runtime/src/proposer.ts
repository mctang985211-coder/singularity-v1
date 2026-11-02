import type { Context } from '@deepseek-ai/cordis'
import type { Agent,AgentHandle,AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool,ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { FactActor,JsonValue,MethodPatch,Ref,SessionCut,UsageRecord } from '@singularity/protocol'
import { canonicalize,closedObject,methodPatchSchema,methodRevisionSchema,parseProtocolValue,protocolJsonSchema,seal } from '@singularity/protocol'
import { ZodError } from 'zod'
import { DecomposeError,throwCollectedErrors } from './errors.ts'

import { snapshotSession } from './agent.ts'
import type { EvaluationComparison } from './evaluation.ts'
import { MethodPatchRejection,submitMethodPatch } from './method-patch.ts'
import { assertPromptBudget,clampPercent,PROPOSER_PERSONA } from './prompt.ts'
import { readRoundObject,readRoundPlan } from './round.ts'
import { commitFact } from './run-settlement.ts'
import type { CommandService } from './service.ts'
import { sameRef } from './skill-resources.ts'
import { withToolExample } from './tool-example.ts'
import type { PublicTrace } from './trace.ts'
import { readPublicTrace,readTraceAsset,readTracePage } from './trace.ts'
import { deliverWakeOnceOrFail } from './wake.ts'

const encoder = new TextEncoder()
const patchInputSchema = protocolJsonSchema(closedObject({ patch: methodPatchSchema }))
delete patchInputSchema.$schema

export const RSI_PROPOSER_CARD = `You improve one pinned Method using one sealed root execution trace.
Read the pinned Method and the original guidance/example assets you will change.
Use the source contract, acceptance, subtree usage and relevant trace pages to
identify an observed bottleneck. Consult the public protocol resource for runtime
rules. Distinguish domain failures from infrastructure errors and protocol misuse.
Align one causal hypothesis with the frozen evaluation metric and thresholds.
If correctness is already saturated, extra correctness prose cannot raise it.
Read previous-round feedback when present; revise an unsuccessful hypothesis
using its measured result. Preserve useful assets and choose the smallest
executable change that addresses the evidence. Children own their local workflow.
Start with the root receipt's failed criteria. Follow related Task/Run evidence,
children and planning pages, then examine relevant costliest Runs. Replan from
the observed failure mechanism; submit when evidence supports a concrete change. Keep the patch
concise: put each reusable instruction in one asset and refer to it from guidance.
Use short guidance naming operations and their inputs/outputs; keep detailed code
in one skill or MCP asset. Send one JSON object as the tool arguments.
Submit one reusable MethodPatch with rsi_submit_patch. Templates, guidance,
examples, skill/MCP assets and bindings may evolve; host precheck, evaluation
and activation approval determine the result.`

export interface PublicEvaluationView {
  readonly goal: string
  readonly metric: string
  readonly thresholds: readonly string[]
  readonly validationPolicy: 'none' | 'required-by-domain'
  readonly publicCases: readonly { readonly id: string; readonly description: string }[]
}

export interface ExecuteRsiProposerRequest {
  readonly ctx: Context
  readonly service: CommandService
  readonly actor: FactActor
  readonly roundId: string
  readonly workspace: string
  readonly agentOptions: AgentOptions
  readonly publicEvaluation: PublicEvaluationView
  readonly clock?: () => number
}

export interface RsiProposerResult {
  readonly roundId: string
  readonly proposalRef?: Ref
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly recordRef: Ref
  readonly failure?: string
}

/** Independent DSH composition. Host callbacks hold the writer; the Agent receives only scoped RSI tools. */
export async function executeRsiProposer(request: ExecuteRsiProposerRequest): Promise<RsiProposerResult> {
  const { service, roundId } = request
  const opened = service.facts().find(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  if (opened?.type !== 'rsi/round-opened') throw new Error('Proposer requires a frozen open Round')
  if (service.facts().some(fact => (fact.type === 'rsi/proposal-submitted' || fact.type === 'rsi/round-closed') && fact.data.roundId === roundId)) throw new Error('Proposer Round is no longer proposing')
  const trace = await readPublicTrace(service, opened.data.sourceTrace)
  if (canonicalize(trace.rootTask.method) !== canonicalize(opened.data.baseMethod)) throw new Error('Sealed trace does not use the pinned proposer Method')
  const sourceSessions = new Set(trace.sessionCuts.map(cut => cut.sessionId))
  const sourceRunIds = new Set(service.facts().flatMap(fact => fact.type === 'run/opened' && sourceSessions.has(fact.data.sessionId) ? [fact.data.runId] : []))
  const costliestRuns = service.facts().flatMap(fact => fact.type === 'run/closed' && sourceRunIds.has(fact.data.runId)
    ? [{ runId: fact.data.runId, classification: fact.data.classification, steps: fact.data.usage.steps,
      reportedTokens: fact.data.usage.inputTokens + fact.data.usage.outputTokens
        + (fact.data.usage.summary?.inputTokens ?? 0) + (fact.data.usage.summary?.outputTokens ?? 0) }] : [])
    .sort((left, right) => right.reportedTokens - left.reportedTokens).slice(0, 3)
  const index = { ...traceIndex(trace), costliestRuns }
  const plan = await readRoundPlan(service, opened.data.plan)
  if (request.publicEvaluation.validationPolicy !== plan.validation) throw new Error('Public validation policy differs from the frozen RoundPlan')
  const method = parseProtocolValue(methodRevisionSchema, await readRoundObject(service, opened.data.baseMethod, 'method'))
  const entry = method.templates.find(template => template.id === method.entryTemplateId)
  const methodIndex = { ref: opened.data.baseMethod,
    ...(method.entryTemplateId === undefined ? {} : { entryTemplateId: method.entryTemplateId }),
    counts: { templates: method.templates.length, skills: method.skills.length, tools: method.tools.length },
    ...(entry === undefined ? {} : { entry: { id: entry.id, guidance: entry.guidance, example: entry.example } }) }
  const previousRound = await previousRoundFeedback(service, roundId, opened.data.baseMethod)
  const feedbackRef = previousRound === undefined ? undefined : await putJson(service, `${roundId}:previous-round-public`, previousRound)
  const budget = plan.proposerBudget
  const clock = request.clock ?? Date.now
  const deadlineAt = opened.at + budget.maxWallClockMs
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, deadlineAt - clock())))
  const failures: unknown[] = []
  let handle: AgentHandle | undefined
  let agent: Agent | undefined
  let proposalRef: Ref | undefined
  let failure: string | undefined
  let usage: UsageRecord = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
  let sessionCut: SessionCut = { sessionId: opened.data.proposerSessionId, from: 0, to: 0 }
  const currentUsage = () => agent === undefined ? usage : snapshotSession(agent.session, false).usage
  const percentages = () => {
    const actual = currentUsage()
    return {
      tokens: actual.unknownRequests > 0 ? 0 : clampPercent(budget.maxTokens - actual.inputTokens - actual.outputTokens, budget.maxTokens),
      steps: clampPercent(budget.maxSteps - actual.steps, budget.maxSteps),
      wallClock: clampPercent(deadlineAt - clock(), budget.maxWallClockMs),
    }
  }
  const available = (nextRequest = false) => {
    const actual = currentUsage()
    return clock() < deadlineAt && actual.unknownRequests === 0
      && actual.inputTokens + actual.outputTokens + (nextRequest ? 1 : 0) <= budget.maxTokens
      && actual.steps + (nextRequest ? 1 : 0) <= budget.maxSteps
  }
  const view = () => ({
    v: 1, roundId, sourceTrace: opened.data.sourceTrace, baseMethod: opened.data.baseMethod,
    publicEvaluation: {
      goal: request.publicEvaluation.goal, metric: request.publicEvaluation.metric,
      thresholds: [...request.publicEvaluation.thresholds], validationPolicy: request.publicEvaluation.validationPolicy,
      publicCases: request.publicEvaluation.publicCases.map(item => ({ id: item.id, description: item.description })),
    },
    ...(previousRound === undefined ? {} : { previousRound: { roundId: previousRound.roundId, outcome: previousRound.outcome,
      readKind: 'previous-round' } }),
    remainingBudgetPct: percentages(),
    readPolicy: { kinds: ['proposer-view', 'trace-index', 'trace-page', 'method', 'asset', 'public-resources', 'previous-round'], pageMode: 'bounded-paged' },
  })
  const cancel = () => agent?.cancel({ kind: 'hook', reason: 'proposer deadline' })
  deadline.addEventListener('abort', cancel, { once: true })
  try {
    if (!available()) throw new DecomposeError('INVALID_ARGUMENT', 'Proposer budget is exhausted')
    const setup = (ctx: Context, instance: Agent) => {
      agent = instance
      const register = (tool: ToolDefinition) => ctx.tools.register({ ...tool, execute: async (args, exec) => {
        try { return await tool.execute(args, exec) } catch (error) {
          if (error instanceof ToolArgsError || error instanceof DecomposeError || error instanceof MethodPatchRejection || error instanceof ZodError) throw error
          failures.push(error)
          instance.cancel({ kind: 'hook', reason: 'proposer-host-error' })
          throw error
        }
      } })
      ctx.on('agent/request-error', () => Promise.resolve(undefined), { prepend: true })
      ctx.on('agent/pre-step', (_payload, next) => available(true) ? next() : Promise.resolve({ kind: 'reject' as const }))
      ctx.systemPrompt.section({ name: 'deployment:persona-prefix',
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: PROPOSER_PERSONA, interpolate: false })
      ctx.systemPrompt.section({ name: 'singularity:rsi-card', order: 100, text: RSI_PROPOSER_CARD, interpolate: false })
      ctx.systemPrompt.section({ name: 'singularity:worker-card', order: 100, text: '', interpolate: false })
      ctx.systemPrompt.context({
        name: 'singularity:proposer-view', order: 200, required: true, interpolate: false,
        text: () => {
          const text = canonicalize({ proposer: view(), trace: index, method: methodIndex })
          assertPromptBudget(text, 8 * 1024, 'ProposerView')
          return text
        },
      })
      register(withToolExample(defineTool({
        name: 'rsi_read', description: 'Read the proposer view, sealed trace chapters, pinned Method and authorized public source assets by bounded pages.',
        parameters: {
          kind: { type: 'string', required: true, enum: ['proposer-view', 'trace-index', 'trace-page', 'method', 'asset', 'public-resources', 'previous-round'], description: 'Use {kind:"trace-index"} to list chapters. Read a chapter with {kind:"trace-page",id:"contract",page:0}. Read method for templates, then asset for original guidance/example refs. public-resources lists frozen documents including a task protocol reference when supplied. previous-round gives the latest same-base closed Round public feedback. Omit id except for trace-page and asset.' },
          id: { type: 'string', description: 'For trace-page use chapters[].id (for example contract), as listed in the trace index. For asset use an authorized public asset ID or digest.' },
          cursor: { type: 'string', description: 'nextCursor from the previous page.' },
          page: { type: 'integer', description: 'Nonnegative page number, starting at 0.' },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: canonicalize(value) }] },
        execute: async args => {
          if (!available()) throw new DecomposeError('INVALID_ARGUMENT', 'Proposer budget is exhausted')
          const page = args.cursor === undefined ? args.page ?? 0 : Number(args.cursor)
          if (!Number.isSafeInteger(page) || page < 0) throw new DecomposeError('INVALID_ARGUMENT', 'Read cursor must identify a nonnegative page')
          let result: unknown
          if (args.kind === 'proposer-view' || args.kind === 'trace-index') {
            if (page !== 0 || args.id !== undefined) throw new DecomposeError('INVALID_ARGUMENT', 'Omit id and use page 0 for this single-page read kind')
            const data = args.kind === 'proposer-view' ? view() : index
            const objectRef = await putJson(service, `round:${roundId}:${args.kind}`, data)
            result = { data, objectRef }
          } else if (args.kind === 'previous-round') {
            if (args.id !== undefined || previousRound === undefined || feedbackRef === undefined) throw new DecomposeError('INVALID_ARGUMENT', 'No previous Round feedback is available; omit id')
            const text = canonicalize(previousRound), pages = Math.max(1, Math.ceil(text.length / 3072))
            if (page >= pages) throw new DecomposeError('INVALID_ARGUMENT', 'Previous Round page is out of range')
            result = { data: { format: 'json', text: text.slice(page * 3072, (page + 1) * 3072), page },
              objectRef: feedbackRef, ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}) }
          } else if (args.kind === 'trace-page') {
            if (args.id === undefined) throw new DecomposeError('INVALID_ARGUMENT', 'Trace page requires a chapter ID')
            result = await readTracePage(service, trace, args.id, page)
          } else {
            const ref = args.kind === 'method' ? opened.data.baseMethod
              : args.kind === 'public-resources' ? trace.sourceResourceSnapshot : publicAssetRef(trace, args.id)
            result = await readTraceAsset(service, trace, ref, page)
          }
          const response = { ...result as object, remainingBudgetPct: percentages() }
          assertPromptBudget(canonicalize(response), 16 * 1024, 'RSI read result')
          return response as unknown as JsonValue
        },
      }), { kind: 'trace-index' }))
      const submit = defineTool({
        name: 'rsi_submit_patch', description: 'Submit one reusable MethodPatch. guidance is inline text; example uses illustrative exampleText inputs. files maps relative paths to UTF-8 contents; a skill requires SKILL.md. acceptancePolicy reuses an authorized source/base Ref. set-entry selects a template, or null removes the entry. The host creates refs and digests.',
        parameters: { patch: { type: 'json', required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: canonicalize(value) }] },
        execute: async (args, exec) => {
          if (!available()) throw new DecomposeError('INVALID_ARGUMENT', 'Proposer budget is exhausted')
          proposalRef = await submitMethodPatch({ service, actor: request.actor, roundId, value: args.patch })
          exec.concludeTurn()
          return { submitted: true, proposalRef, remainingBudgetPct: percentages() } as unknown as JsonValue
        },
      })
      register(withToolExample({ ...submit, parameters: patchInputSchema }, { patch: { v: 1, base: opened.data.baseMethod,
        hypothesis: 'Describe the reusable improvement.', changes: [], predictedRisks: [], transferPlan: 'Evaluate the changed workflow.' } }))
      const globalNames = request.ctx.tools.definitions().map(definition => definition.name)
      if (globalNames.length > 0) ctx.tools.restrict({ deny: globalNames })
      assertPromptBudget(canonicalize(ctx.tools.schemas(instance)), 12 * 1024, 'RSI tool schemas')
    }
    handle = await request.ctx.agents.create({ sessionId: opened.data.proposerSessionId as SessionId,
      meta: { cwd: request.workspace }, agentOptions: request.agentOptions, signal: deadline, setup })
    deadline.throwIfAborted()
    await deliverWakeOnceOrFail(handle.agent, { wakeId: `${roundId}:propose`, text: 'Inspect the sealed public source trace and pinned Method, then submit one reusable MethodPatch.' })
    await handle.agent.whenIdle()
    deadline.throwIfAborted()
  } catch (error) {
    if (!deadline.aborted && available()) failures.push(error)
    else failure = error instanceof Error ? error.message : String(error)
  } finally {
    deadline.removeEventListener('abort', cancel)
    if (handle !== undefined) {
      try { await handle.dispose() } catch (error) { failures.push(error) }
      try {
        const snapshot = snapshotSession(handle.agent.session)
        usage = snapshot.usage
        sessionCut = snapshot.sessionCut
        if (snapshot.failure !== undefined && !deadline.aborted && failures.length === 0) failures.push(new Error(snapshot.failure))
      } catch (error) { failures.push(error) }
    }
  }
  throwCollectedErrors(failures)
  const recordRef = await putJson(service, `round:${roundId}:proposer-record`, seal('object', {
    v: 1, roundId, sessionCut, usage, ...(proposalRef === undefined ? {} : { proposalRef }),
    ...(failure === undefined ? {} : { failure }),
  }))
  if (proposalRef === undefined || failure !== undefined) {
    const reason = failure !== undefined ? 'proposer-failure' : available() ? 'no-proposal' : 'proposer-budget-exhausted'
    await commitFact(service, request.actor, `round:${roundId}:proposer-closed`, 'rsi_proposer_closed', {},
      { roundId, reason }, 'rsi/round-closed', { roundId, outcome: 'insufficient-evidence', reason }, [])
  }
  return { roundId, usage, sessionCut, recordRef, ...(proposalRef === undefined ? {} : { proposalRef }),
    ...(failure === undefined ? {} : { failure }) }
}

function traceIndex(trace: PublicTrace) {
  return { traceId: trace.traceId, rootTask: trace.rootTask, usage: trace.usage, chapters: trace.chapters,
    readPolicy: { pageMode: 'bounded-paged', allow: trace.chapters.map(chapter => chapter.id) } }
}

/** One projection from facts closed before this Round opened; embedded refs grant no additional reads. */
async function previousRoundFeedback(service: CommandService, roundId: string, baseMethod: Ref) {
  const facts = service.facts()
  const before = facts.findIndex(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  const rounds = (await service.methodRoundState()).rounds
  for (const closed of facts.slice(0, before).reverse()) {
    if (closed.type !== 'rsi/round-closed') continue
    const prior = rounds.get(closed.data.roundId)
    if (prior === undefined || !sameRef(prior.baseMethod, baseMethod)) continue
    const patch = prior.patch === undefined ? undefined : await readRoundObject(service, prior.patch) as unknown as MethodPatch
    const comparison = closed.data.comparisonRef === undefined ? undefined
      : await readRoundObject(service, closed.data.comparisonRef) as unknown as EvaluationComparison
    return { roundId: prior.roundId,
      ...(patch === undefined ? {} : { hypothesis: patch.hypothesis }),
      outcome: closed.data.outcome, ...(closed.data.reason === undefined ? {} : { reason: closed.data.reason }),
      ...(comparison === undefined ? {} : { complete: comparison.complete, metric: comparison.metric,
        aggregateDelta: comparison.aggregateDelta, worstRegression: comparison.worstRegression,
        ...(comparison.cost === undefined ? {} : { cost: comparison.cost }),
        ...(comparison.reason === undefined ? {} : { reason: comparison.reason }) }) }
  }
  return undefined
}

function publicAssetRef(trace: PublicTrace, id: string | undefined): Ref {
  const digest = trace.authorizedObjects.find(entry => entry.ref.digest === id)
  if (digest !== undefined) return digest.ref
  const matches = trace.authorizedObjects.filter(entry => entry.ref.id === id)
  if (matches.length !== 1) throw new DecomposeError('INVALID_ARGUMENT', 'Asset ID must identify one object in the sealed source read authorization')
  return matches[0].ref
}

function putJson(service: CommandService, id: string, value: unknown): Promise<Ref> {
  return service.putObject(id, encoder.encode(canonicalize(value)))
}
