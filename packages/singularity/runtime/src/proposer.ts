import type { Context } from '@deepseek-ai/cordis'
import type { Agent,AgentHandle,AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool,ToolArgsError } from '@deepseek-ai/dsh-tools'
import type {
FactActor,JsonValue,MethodPatch,MethodPatchDraft,ProposalHistoryEntry,Ref,SessionCut,UsageRecord,
} from '@singularity/protocol'
import {
canonicalize,closedObject,digestSchema,methodPatchDraftSchema,methodPatchSchema,methodRevisionSchema,
parseProtocolValue,proposalHistoryEntrySchema,protocolJsonSchema,refSchema,seal,sessionCutSchema,sliceAttemptSchema,
sliceSelectionSchema,usageRecordSchema,
} from '@singularity/protocol'
import { z,ZodError } from 'zod'

import { DecomposeError,throwCollectedErrors } from './errors.ts'

import { snapshotSession } from './agent.ts'
import { MethodPatchRejection,submitMethodPatch } from './method-patch.ts'
import { assertPromptBudget,clampPercent,PROPOSER_PERSONA } from './prompt.ts'
import { readRoundObject,readRoundPlan } from './round.ts'
import { commitFact } from './run-settlement.ts'
import type { CommandService } from './service.ts'
import { withToolExample } from './tool-example.ts'
import type { PublicTrace } from './trace.ts'
import { readPublicTrace,readTraceAsset,readTracePage } from './trace.ts'
import { deliverWakeOnceOrFail } from './wake.ts'

const encoder = new TextEncoder()
const patchInputSchema = protocolJsonSchema(closedObject({ patch: methodPatchDraftSchema }))
delete patchInputSchema.$schema
const zeroUsage: UsageRecord = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
const MAX_HISTORY_RECENT = 32
const MAX_HISTORY_SAME_FOCUS = 8
const HISTORY_PAGE_ENTRIES = 8
const HYPOTHESIS_TEXT_LIMIT = 1024

export const RSI_PROPOSER_CARD = `Improve reusable Method assets from sealed evidence; Task outputs are per-instance results.
Read authoring, pinned Method and relevant original assets with rsi_read;
read the bounded public proposal history when offered, including a supplied focus.
Trace contracts, acceptance concerns, corrections, original outputs and costs; distinguish workflow,
domain and host failures. Improve future reasoning, decomposition and reusable interfaces,
not merely this source's implementation. Choose the smallest change aligned with the metric;
never collapse a useful workflow into a larger single-run runbook just to reduce steps.
Extract reusable algorithms, decoders, runners, comparators, skills and responsibility interfaces;
learn to choose independent consumers, detect empty checks and correct mistaken contracts;
avoid rebuilding code each trial or preserving source-specific review/audit chains.
Examples illustrate; never dispatch on case/suite IDs or copy solved data/answers.
Explain unseen-input transfer and risks; source pass is insufficient.
Skill names are DSH kebab-case machine IDs. Bind changed assets to templates
reachable from entry (set-entry if needed); unreachable changes are no-ops.
Author business guidance, examples, assets and bindings only. The host stamps base,
TaskProposal schema, acceptancePolicy and learning outputs; none belongs in a patch.
The host composes the same public environment for every template and paired arm.
Bind only Method-owned additions. Actual child acceptance is authored by its parent;
examples teach writing and do not freeze checks or output layouts for future Tasks.
Keep the interface within 12 KiB; help is a resource.
Submit one JSON MethodPatchDraft with rsi_submit_patch. Correct invalid arguments in this session;
the host records this draft and owns submission, precheck, evaluation and activation.`

export interface PublicEvaluationView {
  readonly goal: string
  readonly metric: string
  readonly thresholds: readonly string[]
  readonly validationPolicy: 'none' | 'required-by-domain'
  readonly publicCases: readonly { readonly id: string; readonly description: string }[]
}

/** Shared proposer budget across root-only and multi-draft slice execution. */
export interface SharedRsiDraftBudget {
  readonly deadlineAt: number
  readonly maxTokens: number
  readonly maxSteps: number
  readonly used: UsageRecord
}

export interface DraftRsiPatchRequest {
  readonly ctx: Context
  readonly service: CommandService
  readonly actor: FactActor
  readonly roundId: string
  readonly proposalSessionId: string
  readonly recordId: string
  readonly workspace: string
  readonly agentOptions: AgentOptions
  readonly publicEvaluation: PublicEvaluationView
  readonly sharedBudget: SharedRsiDraftBudget
  readonly focus?: string
  readonly history?: ProposalHistoryView
  readonly clock?: () => number
}

export interface RsiPatchDraftResult {
  readonly roundId: string
  readonly draft?: MethodPatchDraft
  readonly draftRef?: Ref
  readonly usage: UsageRecord
  readonly sessionCut: SessionCut
  readonly recordRef: Ref
  readonly failure?: string
  readonly closureReason?: 'no-proposal' | 'proposer-budget-exhausted' | 'proposer-failure'
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

export const proposalHistoryViewSchema = closedObject({
  v: z.literal(1),
  roundId: z.string(),
  focus: z.string().optional(),
  entries: z.array(proposalHistoryEntrySchema),
  historyRefs: z.array(refSchema),
})

export type ProposalHistoryView = z.infer<typeof proposalHistoryViewSchema>

export interface BuildProposalHistoryRequest {
  readonly service: CommandService
  readonly roundId: string
  readonly focus?: string
  /** Explicit refs to prior archived SliceAttempt records; no archive enumeration is used. */
  readonly attemptRefs?: readonly Ref[]
}

export interface ExtendProposalHistoryRequest {
  readonly service: CommandService
  readonly history: ProposalHistoryView
  readonly attemptRefs: readonly Ref[]
}

const rsiPatchDraftRecordSchema = closedObject({
  v: z.literal(1),
  kind: z.literal('rsi-patch-draft'),
  roundId: z.string(),
  proposalSessionId: z.string(),
  sessionCut: sessionCutSchema,
  usage: usageRecordSchema,
  draftRef: refSchema.optional(),
  failure: z.string().optional(),
  closureReason: z.enum(['no-proposal', 'proposer-budget-exhausted', 'proposer-failure']).optional(),
  digest: digestSchema,
})

/** Independent DSH composition. Host callbacks hold the writer; the Agent receives only scoped RSI tools. */
export async function draftRsiPatch(request: DraftRsiPatchRequest): Promise<RsiPatchDraftResult> {
  const { service, roundId } = request
  if (request.proposalSessionId.length === 0 || request.recordId.length === 0) {
    throw new Error('Draft requires independent proposal session and record identities')
  }
  assertDraftBudget(request.sharedBudget)
  const opened = service.facts().find(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  if (opened?.type !== 'rsi/round-opened') throw new Error('Proposer requires a frozen open Round')
  if (service.facts().some(fact => (fact.type === 'rsi/proposal-submitted' || fact.type === 'rsi/round-closed') && fact.data.roundId === roundId)) {
    throw new Error('Proposer Round is no longer proposing')
  }
  const trace = await readPublicTrace(service, opened.data.sourceTrace)
  if (canonicalize(trace.rootTask.method) !== canonicalize(opened.data.baseMethod)) throw new Error('Sealed trace does not use the pinned proposer Method')
  const index = { traceId: trace.traceId, rootTask: trace.rootTask, usage: trace.usage, chapters: trace.chapters }
  const plan = await readRoundPlan(service, opened.data.plan)
  if (request.publicEvaluation.validationPolicy !== plan.validation) throw new Error('Public validation policy differs from the frozen RoundPlan')
  const method = parseProtocolValue(methodRevisionSchema, await readRoundObject(service, opened.data.baseMethod, 'method'))
  const entry = method.templates.find(template => template.id === method.entryTemplateId)
  const methodIndex = { ref: opened.data.baseMethod,
    ...(method.entryTemplateId === undefined ? {} : { entryTemplateId: method.entryTemplateId }),
    counts: { templates: method.templates.length, skills: method.skills.length, tools: method.tools.length },
    ...(entry === undefined ? {} : { entry: { id: entry.id, guidance: entry.guidance, example: entry.example } }) }
  const history = request.history === undefined
    ? await buildProposalHistory({ service, roundId, ...(request.focus === undefined ? {} : { focus: request.focus }) })
    : parseProtocolValue(proposalHistoryViewSchema, request.history)
  const clock = request.clock ?? Date.now
  const budget = request.sharedBudget
  const used = parseProtocolValue(usageRecordSchema, budget.used)
  const deadlineAt = budget.deadlineAt
  const deadline = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(0, deadlineAt - clock())))
  const failures: unknown[] = []
  let handle: AgentHandle | undefined
  let agent: Agent | undefined
  let draft: MethodPatchDraft | undefined
  let draftRef: Ref | undefined
  let failure: string | undefined
  let closureReason: RsiPatchDraftResult['closureReason']
  let usage: UsageRecord = { ...zeroUsage }
  let sessionCut: SessionCut = { sessionId: request.proposalSessionId, from: 0, to: 0 }
  const currentUsage = () => agent === undefined ? usage : snapshotSession(agent.session, false).usage
  const usedTokens = (actual: UsageRecord) => used.inputTokens + used.outputTokens + actual.inputTokens + actual.outputTokens
  const percentages = () => {
    const actual = currentUsage()
    return {
      tokens: clampPercent(budget.maxTokens - usedTokens(actual), budget.maxTokens),
      steps: clampPercent(budget.maxSteps - used.steps - actual.steps, budget.maxSteps),
      wallClock: clampPercent(deadlineAt - clock(), Math.max(1, deadlineAt - opened.at)),
    }
  }
  const available = (nextRequest = false) => {
    const actual = currentUsage()
    return clock() < deadlineAt
      && usedTokens(actual) + (nextRequest ? 1 : 0) <= budget.maxTokens
      && used.steps + actual.steps + (nextRequest ? 1 : 0) <= budget.maxSteps
  }
  const view = () => ({
    v: 1, roundId, sourceTrace: opened.data.sourceTrace, baseMethod: opened.data.baseMethod,
    publicEvaluation: {
      goal: request.publicEvaluation.goal, metric: request.publicEvaluation.metric,
      thresholds: [...request.publicEvaluation.thresholds], validationPolicy: request.publicEvaluation.validationPolicy,
      publicCases: request.publicEvaluation.publicCases.map(item => ({ id: item.id, description: item.description })),
    },
    ...(request.focus === undefined ? {} : { focus: request.focus }),
    history: { count: history.entries.length, readKind: 'history' },
    remainingBudgetPct: percentages(),
    readPolicy: { kinds: ['proposer-view', 'trace-index', 'trace-page', 'method', 'asset', 'public-resources', 'history', 'authoring'], pageMode: 'bounded-paged' },
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
      ctx.systemPrompt.section({ name: 'tool:bash', order: 100, text: '', interpolate: false })
      ctx.systemPrompt.section({ name: 'tool:jobs', order: 100, text: '', interpolate: false })
      ctx.systemPrompt.context({
        name: 'singularity:proposer-view', order: 200, required: true, interpolate: false,
        text: () => {
          const text = canonicalize({ proposer: view(), trace: index, method: methodIndex })
          assertPromptBudget(text, 8 * 1024, 'ProposerView')
          return text
        },
      })
      register(withToolExample(defineTool({
        name: 'rsi_read', description: 'Read the proposer view, bounded public proposal history, sealed trace chapters, pinned Method and authorized public source assets by bounded pages.',
        parameters: {
          kind: { type: 'string', required: true, enum: ['proposer-view', 'trace-index', 'trace-page', 'method', 'asset', 'public-resources', 'history', 'authoring'], description: 'Select content: proposer-view=current Round; authoring=MethodPatchDraft schema; trace-index=chapters; trace-page=one chapter; method=base Method; asset=authorized asset; public-resources=public catalog; history=bounded public root/attempt history. Omit id except for trace-page/asset.' },
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
          if (args.kind === 'authoring' || args.kind === 'proposer-view' || args.kind === 'trace-index') {
            if (page !== 0 || args.id !== undefined) throw new DecomposeError('INVALID_ARGUMENT', 'Omit id and use page 0 for this single-page read kind')
            const data = args.kind === 'authoring' ? patchInputSchema : args.kind === 'proposer-view' ? view() : index
            const objectRef = await putJson(service, `round:${roundId}:${args.kind}`, data)
            result = { data, objectRef }
          } else if (args.kind === 'history') {
            if (args.id !== undefined) throw new DecomposeError('INVALID_ARGUMENT', 'Omit id for the bounded history read')
            const pages = Math.max(1, Math.ceil(history.entries.length / HISTORY_PAGE_ENTRIES))
            if (page >= pages) throw new DecomposeError('INVALID_ARGUMENT', 'History page is out of range')
            const start = page * HISTORY_PAGE_ENTRIES
            const data = { v: 1, roundId,
              ...(history.focus === undefined ? {} : { focus: history.focus }), page, total: history.entries.length,
              entries: history.entries.slice(start, start + HISTORY_PAGE_ENTRIES),
              historyRefs: history.historyRefs.slice(start, start + HISTORY_PAGE_ENTRIES) }
            const objectRef = await putJson(service, `round:${roundId}:history-page:${String(page)}`, data)
            result = { data, objectRef, ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}) }
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
        name: 'rsi_submit_patch', description: 'Submit one reusable MethodPatchDraft; read authoring for exact fields. The host records this draft and owns the Round base and interface policy.',
        parameters: { patch: { type: 'json', required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: canonicalize(value) }] },
        execute: async (args, exec) => {
          if (!available()) throw new DecomposeError('INVALID_ARGUMENT', 'Proposer budget is exhausted')
          if (draftRef !== undefined) throw new DecomposeError('INVALID_ARGUMENT', 'A MethodPatchDraft is already recorded for this proposer session')
          draft = parseMethodPatchDraft(args.patch)
          draftRef = await putJson(service, `${request.recordId}:draft`, draft)
          exec.concludeTurn()
          return { submitted: true, draftRef, remainingBudgetPct: percentages() } as unknown as JsonValue
        },
      })
      register(withToolExample(submit, { patch: { v: 1,
        hypothesis: 'Describe the reusable improvement.', changes: [], predictedRisks: [], transferPlan: 'Evaluate the changed workflow.' } }))
      const globalNames = request.ctx.tools.definitions().map(definition => definition.name)
      if (globalNames.length > 0) ctx.tools.restrict({ deny: globalNames })
      assertPromptBudget(canonicalize(ctx.tools.schemas(instance)), 12 * 1024, 'RSI tool schemas')
    }
    handle = await request.ctx.agents.create({ sessionId: request.proposalSessionId as SessionId,
      meta: { cwd: request.workspace }, agentOptions: request.agentOptions, signal: deadline, setup })
    deadline.throwIfAborted()
    await deliverWakeOnceOrFail(handle.agent, { wakeId: `${roundId}:propose`, text: 'Inspect the sealed public source trace and pinned Method, then submit one reusable MethodPatchDraft.' })
    await handle.agent.whenIdle()
    deadline.throwIfAborted()
  } catch (error) {
    if (!deadline.aborted && available()) failures.push(error)
    else {
      failure = error instanceof Error ? error.message : String(error)
      closureReason = 'proposer-failure'
    }
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
  if (draftRef === undefined) {
    closureReason = failure !== undefined ? 'proposer-failure' : available() ? 'no-proposal' : 'proposer-budget-exhausted'
  }
  const record = parseProtocolValue(rsiPatchDraftRecordSchema, seal('object', {
    v: 1, kind: 'rsi-patch-draft', roundId, proposalSessionId: request.proposalSessionId, sessionCut, usage,
    ...(draftRef === undefined ? {} : { draftRef }),
    ...(failure === undefined ? {} : { failure }),
    ...(closureReason === undefined ? {} : { closureReason }),
  }))
  const recordRef = await putJson(service, request.recordId, record)
  return { roundId, ...(draft === undefined ? {} : { draft }), ...(draftRef === undefined ? {} : { draftRef }),
    usage, sessionCut, recordRef, ...(failure === undefined ? {} : { failure }), ...(closureReason === undefined ? {} : { closureReason }) }
}

/** Root-only wrapper: the draft agent never writes proposal or closure facts. */
export async function executeRsiProposer(request: ExecuteRsiProposerRequest): Promise<RsiProposerResult> {
  const { service, roundId } = request
  const opened = service.facts().find(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  if (opened?.type !== 'rsi/round-opened') throw new Error('Proposer requires a frozen open Round')
  if (service.facts().some(fact => (fact.type === 'rsi/proposal-submitted' || fact.type === 'rsi/round-closed') && fact.data.roundId === roundId)) {
    throw new Error('Proposer Round is no longer proposing')
  }
  const plan = await readRoundPlan(service, opened.data.plan)
  if (request.publicEvaluation.validationPolicy !== plan.validation) throw new Error('Public validation policy differs from the frozen RoundPlan')
  const history = await buildProposalHistory({ service, roundId })
  const drafted = await draftRsiPatch({
    ctx: request.ctx, service, actor: request.actor, roundId,
    proposalSessionId: opened.data.proposerSessionId,
    recordId: `round:${roundId}:proposer-record`,
    workspace: request.workspace, agentOptions: request.agentOptions,
    publicEvaluation: request.publicEvaluation,
    sharedBudget: {
      deadlineAt: opened.at + plan.proposerBudget.maxWallClockMs,
      maxTokens: plan.proposerBudget.maxTokens,
      maxSteps: plan.proposerBudget.maxSteps,
      used: zeroUsage,
    },
    history,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
  })
  if (drafted.draft !== undefined && drafted.failure === undefined) {
    const proposalRef = await submitMethodPatch({ service, actor: request.actor, roundId, value: drafted.draft })
    return { roundId, proposalRef, usage: drafted.usage, sessionCut: drafted.sessionCut, recordRef: drafted.recordRef }
  }
  const reason = drafted.closureReason ?? 'no-proposal'
  await commitFact(service, request.actor, `round:${roundId}:proposer-closed`, 'rsi_proposer_closed', {},
    { roundId, reason }, 'rsi/round-closed', { roundId, outcome: 'insufficient-evidence', reason }, [])
  return { roundId, usage: drafted.usage, sessionCut: drafted.sessionCut, recordRef: drafted.recordRef,
    ...(drafted.failure === undefined ? {} : { failure: drafted.failure }) }
}

/** Project each root Round closed before this Round's opening fact, across Method bases. */
export async function buildProposalHistory(request: BuildProposalHistoryRequest): Promise<ProposalHistoryView> {
  const { service, roundId } = request
  const facts = service.facts()
  const before = facts.findIndex(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  if (before < 0) throw new Error('Proposal history requires a frozen open Round')
  const rounds = (await service.methodRoundState()).rounds
  const entries: ProposalHistoryEntry[] = []
  for (const fact of facts.slice(0, before).reverse()) {
    if (fact.type !== 'rsi/round-closed') continue
    const prior = rounds.get(fact.data.roundId)
    if (prior?.patch === undefined) continue
    const outcome = rootHistoryOutcome(fact.data.outcome)
    if (outcome === undefined) continue
    const patch = await readArchivedPatch(service, prior.patch)
    const comparison = fact.data.comparisonRef === undefined ? undefined : await readRoundObject(service, fact.data.comparisonRef)
    const focusTemplateId = patchFocusTemplate(patch)
    entries.push(historyEntryFromPatch({ id: prior.roundId,
      baseMethod: 'base' in patch ? patch.base : prior.baseMethod,
      ...(focusTemplateId === undefined ? {} : { focusTemplateId }),
      patch, outcome, ...(comparison === undefined ? {} : comparisonProjection(comparison)) }))
  }
  entries.reverse()
  for (const ref of request.attemptRefs ?? []) entries.push(await readArchivedAttemptEntry(service, ref))
  return materializeProposalHistory(service, roundId, request.focus, boundProposalHistory(dedupeHistory(entries), request.focus))
}

/** Add only explicitly supplied archived SliceAttempt refs; never enumerate archive prefixes or future refs. */
export async function extendProposalHistory(request: ExtendProposalHistoryRequest): Promise<ProposalHistoryView> {
  const history = parseProtocolValue(proposalHistoryViewSchema, request.history)
  const known = new Set(history.entries.map(entry => entry.id))
  const entries = [...history.entries]
  for (const ref of request.attemptRefs) {
    const entry = await readArchivedAttemptEntry(request.service, ref)
    if (known.has(entry.id)) continue
    known.add(entry.id)
    entries.push(entry)
  }
  return materializeProposalHistory(request.service, history.roundId, history.focus, boundProposalHistory(entries, history.focus))
}

function assertDraftBudget(budget: SharedRsiDraftBudget): void {
  if (!Number.isSafeInteger(budget.deadlineAt) || budget.deadlineAt < 0
    || !Number.isSafeInteger(budget.maxTokens) || budget.maxTokens <= 0
    || !Number.isSafeInteger(budget.maxSteps) || budget.maxSteps <= 0) {
    throw new Error('Shared proposer budget is invalid')
  }
}

function parseMethodPatchDraft(value: unknown): MethodPatchDraft {
  const draft = parseProtocolValue(methodPatchDraftSchema, value)
  for (const change of draft.changes) {
    if (change.op === 'put-skill' && !isSkillName(change.skill.name)) {
      throw new MethodPatchRejection(`skill name ${JSON.stringify(change.skill.name)} is not DSH kebab-case`)
    }
  }
  if (encoder.encode(canonicalize(draft)).byteLength > 256 * 1024) throw new Error('MethodPatch exceeds the 256 KiB limit')
  return draft
}

async function readArchivedPatch(service: CommandService, ref: Ref): Promise<MethodPatchDraft | MethodPatch> {
  const value = await readRoundObject(service, ref)
  const draft = methodPatchDraftSchema.safeParse(value)
  return draft.success ? draft.data : parseProtocolValue(methodPatchSchema, value)
}

function rootHistoryOutcome(
  outcome: 'improved' | 'no-improvement' | 'insufficient-evidence' | 'rejected' | 'cancelled',
): ProposalHistoryEntry['outcome'] | undefined {
  switch (outcome) {
    case 'improved': return 'improved'
    case 'no-improvement': return 'no-improvement'
    case 'insufficient-evidence': return 'insufficient-evidence'
    case 'rejected': return 'root-rejected'
    case 'cancelled': return undefined
  }
}

function attemptHistoryOutcome(
  outcome: 'local-qualified' | 'diagnostic-finalist' | 'duplicate-candidate' | 'no-improvement' | 'insufficient-evidence' | 'rejected' | 'proposer-failure',
): ProposalHistoryEntry['outcome'] {
  switch (outcome) {
    case 'local-qualified': return 'local-qualified'
    case 'diagnostic-finalist': return 'local-qualified'
    case 'duplicate-candidate': return 'rejected'
    case 'no-improvement': return 'no-improvement'
    case 'insufficient-evidence': return 'insufficient-evidence'
    case 'rejected': return 'rejected'
    case 'proposer-failure': return 'insufficient-evidence'
  }
}

function historyEntryFromPatch(input: {
  readonly id: string
  readonly baseMethod: Ref
  readonly focusTemplateId?: string
  readonly patch?: MethodPatchDraft | MethodPatch
  readonly outcome: ProposalHistoryEntry['outcome']
  readonly aggregateDelta?: number
}): ProposalHistoryEntry {
  return parseProtocolValue(proposalHistoryEntrySchema, {
    id: input.id, baseMethod: input.baseMethod,
    ...(input.focusTemplateId === undefined ? {} : { focusTemplateId: input.focusTemplateId }),
    ...(input.patch === undefined ? { operations: [] } : {
      hypothesis: publicHypothesis(input.patch.hypothesis),
      operations: patchOperations(input.patch),
    }),
    outcome: input.outcome,
    ...(input.aggregateDelta === undefined ? {} : { aggregateDelta: input.aggregateDelta }),
  })
}

function patchOperations(patch: MethodPatchDraft | MethodPatch): string[] {
  return patch.changes.map(change => {
    switch (change.op) {
      case 'put-template': return `put-template:${change.template.id}`
      case 'remove-template': return `remove-template:${change.id}`
      case 'put-skill': return `put-skill:${change.skill.id}`
      case 'remove-skill': return `remove-skill:${change.id}`
      case 'put-mcp-server': return `put-mcp-server:${change.server.id}`
      case 'remove-mcp-server': return `remove-mcp-server:${change.id}`
      case 'set-entry': return `set-entry:${change.templateId ?? 'null'}`
    }
  })
}

function patchFocusTemplate(patch: MethodPatchDraft | MethodPatch): string | undefined {
  const change = patch.changes.find(value => value.op === 'put-template')
  return change === undefined ? undefined : change.template.id
}

function publicHypothesis(value: string): string {
  return value.length <= HYPOTHESIS_TEXT_LIMIT ? value : `${value.slice(0, HYPOTHESIS_TEXT_LIMIT)}…`
}

function comparisonProjection(value: JsonValue): Pick<ProposalHistoryEntry, 'aggregateDelta'> {
  const record = jsonRecord(value, 'Archived comparison')
  if (record['complete'] !== true) return {}
  const aggregateDelta = record['aggregateDelta']
  if (aggregateDelta === undefined) return {}
  if (typeof aggregateDelta !== 'number' || !Number.isFinite(aggregateDelta)) {
    throw new Error('Archived comparison aggregateDelta is invalid')
  }
  return { aggregateDelta }
}

async function readArchivedAttemptEntry(service: CommandService, ref: Ref): Promise<ProposalHistoryEntry> {
  const attempt = parseProtocolValue(sliceAttemptSchema, await readRoundObject(service, ref))
  const selection = parseProtocolValue(sliceSelectionSchema, await readRoundObject(service, attempt.selection))
  const patch = attempt.patch === undefined ? undefined : await readArchivedPatch(service, attempt.patch)
  const comparison = attempt.comparison === undefined ? undefined : await readRoundObject(service, attempt.comparison)
  return historyEntryFromPatch({
    id: `attempt:${attempt.attemptId}`,
    baseMethod: patch !== undefined && 'base' in patch ? parseProtocolValue(refSchema, patch.base) : selection.point.baseMethod,
    focusTemplateId: selection.point.templateId,
    ...(patch === undefined ? {} : { patch }),
    outcome: attemptHistoryOutcome(attempt.outcome),
    ...(comparison === undefined ? {} : comparisonProjection(comparison)),
  })
}

function jsonRecord(value: JsonValue, label: string): Record<string, JsonValue | undefined> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, JsonValue | undefined>
}

function dedupeHistory(entries: readonly ProposalHistoryEntry[]): ProposalHistoryEntry[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
}

/** Root history is hard-bounded, while a supplied focus contributes at most eight attempts. */
function boundProposalHistory(entries: readonly ProposalHistoryEntry[], focus: string | undefined): ProposalHistoryEntry[] {
  const roots = entries.filter(entry => entry.id.startsWith('round:')).slice(-MAX_HISTORY_RECENT)
  const attempts = entries.filter(entry => entry.id.startsWith('attempt:'))
  const sameFocus = (focus === undefined ? attempts : attempts.filter(entry => entry.focusTemplateId === focus))
    .slice(-MAX_HISTORY_SAME_FOCUS)
  return [...roots, ...sameFocus]
}

async function materializeProposalHistory(
  service: CommandService, roundId: string, focus: string | undefined, entries: readonly ProposalHistoryEntry[],
): Promise<ProposalHistoryView> {
  const historyRefs: Ref[] = []
  for (const entry of entries) historyRefs.push(await putJson(service, `${roundId}:history:${entry.id}`, entry))
  return parseProtocolValue(proposalHistoryViewSchema, { v: 1, roundId,
    ...(focus === undefined ? {} : { focus }), entries, historyRefs })
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
