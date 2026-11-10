import type {
  EvaluationCase,
  Evidence,
  Fact,
  GlobalResourceSnapshot,
  MethodPatchDraft,
  MethodRevision,
  PublicReceipt,
  Ref,
  ReplayClosure,
  ReplayPoint,
  TaskContract,
  TaskRunState,
  TaskState,
  UsageRecord,
} from '@singularity/protocol'
import {
  EXPLORE_TEMPLATE_ID,
  admitRootTask,
  canonicalize,
  evaluationCaseSchema,
  evidenceSchema,
  globalResourceSnapshotSchema,
  parseJsonText,
  parseProtocolValue,
  publicReceiptSchema,
  replayClosureSchema,
  replayPointSchema,
  resolveTemplateView,
  taskContractSchema,
  validateEvidence,
  validatePublicReceipt,
  verifyEvidence,
  verifyMethodRevision,
  verifyDigest,
  verifyTaskContract,
} from '@singularity/protocol'

import { evaluationCaseFromContract,withoutLearningDraftOutputs } from './evaluation-case.ts'
import { resourceAssetCatalog } from './resources.ts'
import type { CasDigestDomain } from './store.ts'

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

/** Default bound on host-visible Method edits for one local candidate. */
export const DEFAULT_REPLAY_EDIT_BUDGET = 16

/** Stable, deterministic best-effort closure used by the ordinary runner. */
const BEST_EFFORT_CLOSURE: ReplayClosure = {
  level: 'best-effort',
  workspace: 'fresh-cas-inputs',
  network: 'uncontrolled',
  hostFilesystem: 'uncontrolled',
  reasons: ['ordinary-runner-has-no-execution-proof'],
}

/** Minimal CAS surface used by replay capture; CommandService satisfies it. */
export interface ReplayStore {
  facts(): readonly Fact[]
  readObject(ref: Ref, domain?: CasDigestDomain): Promise<{ readonly bytes: Uint8Array }>
  putObject(id: string, bytes: Uint8Array, domain?: CasDigestDomain): Promise<Ref>
}

/** Reader-only subset for pure local contract construction and fidelity checks. */
export type ReplayReader = Pick<ReplayStore, 'readObject'>

/** Captured point plus the frozen utility-v1 feature projection. */
export interface CapturedReplayPoint {
  readonly point: ReplayPoint
  readonly pointRef: Ref
  readonly failed: boolean
  readonly leaf: boolean
  readonly retries: number
  readonly subtreeTokens: number
  readonly rootTokens: number
  readonly priorAttempts: number
  readonly qualityHeadroom: boolean
}

/** Replay anchor with independent Evidence contradicts its source trace. */
export class ReplayContractError extends Error {
  override readonly name = 'ReplayContractError'
}

export type BaselineDriftReason =
  | 'host-fingerprint'
  | 'source-case'
  | 'source-verdict'
  | 'source-metric'
  | 'baseline-verdict'
  | 'baseline-metric'

/** Business drift between the frozen source case and the fresh baseline. */
export class BaselineDriftError extends Error {
  override readonly name = 'BaselineDriftError'
  readonly reason: BaselineDriftReason

  constructor(reason: BaselineDriftReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.reason = reason
  }
}

export type ReplayScopeErrorCode =
  | 'METHOD_INVALID'
  | 'BOOTSTRAP_PATH'
  | 'BOOTSTRAP_TEMPLATE'
  | 'BOOTSTRAP_ENTRY'
  | 'SINGLE_TEMPLATE'
  | 'REMOVE_FORBIDDEN'
  | 'SET_ENTRY_FORBIDDEN'
  | 'ASSET_OVERWRITE'
  | 'ASSET_UNBOUND'
  | 'EDIT_BUDGET'
  | 'FANOUT_CHANGED'
  | 'EXPAND_CHILDREN'

/** Local candidate changes outside the frozen slice scope. */
export class ReplayScopeError extends Error {
  override readonly name = 'ReplayScopeError'
  readonly code: ReplayScopeErrorCode

  constructor(code: ReplayScopeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface CaptureReplayPointsRequest {
  readonly store: ReplayStore
  readonly trace: Ref
  readonly state: TaskRunState
  readonly base: MethodRevision
  readonly hostFingerprint: string
  /** Fresh absolute campaign deadline used by every local case. */
  readonly campaignDeadlineAt: number
  /** Relative tolerance frozen before candidates exist; defaults to exact. */
  readonly metricRelativeTolerance?: number
  /** Strict requires the source verdict to reproduce; fresh-paired records drift. */
  readonly baselinePolicy?: 'strict' | 'fresh-paired'
  /** Deployment-attested closure; omitted means ordinary best-effort. */
  readonly closure?: ReplayClosure
  /** Selector policy may reject every best-effort point. */
  readonly requireClosed?: boolean
  readonly priorAttempts?: (pointId: string) => number
}

interface TraceBody {
  readonly v: 1
  readonly kind: 'public-task-trace'
  readonly traceId: string
  readonly rootTask: { readonly id: string; readonly outcome: string; readonly method: Ref }
  readonly chapters: readonly { readonly id: string; readonly object: Ref }[]
  readonly digest: string
}

/**
 * Captures verified/failed Task anchors from one sealed trace. Invalid,
 * cancelled, no-submission, and non-independent-Evidence Tasks are not
 * anchors. Any contradiction inside a supposedly sealed source throws; host
 * CAS/read failures are never converted into skipped points.
 */
export async function captureReplayPoints(request: CaptureReplayPointsRequest): Promise<readonly CapturedReplayPoint[]> {
  const { store, state, base } = request
  if (!verifyMethodRevision(base)) throw new ReplayContractError('Replay base Method revision is not sealed')
  assertNonemptyString(request.hostFingerprint, 'hostFingerprint')
  assertSafeDeadline(request.campaignDeadlineAt, 'campaignDeadlineAt')
  if (request.metricRelativeTolerance !== undefined
    && (!Number.isFinite(request.metricRelativeTolerance) || request.metricRelativeTolerance < 0)) {
    throw new ReplayContractError('metricRelativeTolerance must be a nonnegative finite number')
  }
  const closure = request.closure === undefined
    ? BEST_EFFORT_CLOSURE
    : parseProtocolValue(replayClosureSchema, request.closure)
  if (request.requireClosed === true && closure.level !== 'closed') return []

  const trace = await readSealedTrace(store, request.trace)
  const baseRef = refOf(base)
  if (!sameRef(trace.rootTask.method, baseRef)) {
    throw new ReplayContractError('Sealed trace root Method differs from the replay base Method')
  }
  const rootTask = state.tasks.get(trace.rootTask.id)
  if (rootTask === undefined || rootTask.parentTaskId !== undefined) {
    throw new ReplayContractError('Sealed trace root Task is absent from the supplied Task run state')
  }
  if (!verifyTaskContract(rootTask.contract)) throw new ReplayContractError('Source root contract is not sealed')
  if (!sameRef(rootTask.contract.method, baseRef)) {
    throw new ReplayContractError('Source root contract Method differs from the replay base Method')
  }
  await assertTraceRootContract(store, trace, rootTask.contract)
  const traceChildren = await readTraceChildren(store, trace)
  const rootTokens = subtreeTokensOf(state, rootTask.taskId)
  const points: CapturedReplayPoint[] = []

  for (const task of [...state.tasks.values()].sort((left, right) => left.taskId.localeCompare(right.taskId))) {
    if (task.rootTaskId !== rootTask.taskId) continue
    if (task.phase !== 'closed' || task.closed === undefined) continue
    if (task.closed.source !== 'task/closed') continue
    if (task.closed.outcome !== 'verified' && task.closed.outcome !== 'failed') continue
    if (!verifyTaskContract(task.contract)) throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} contract is not sealed`)
    if (!sameRef(task.contract.method, baseRef)) {
      throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} uses a Method other than the replay base`)
    }
    const decisiveRunId = task.runIds.at(-1)
    if (decisiveRunId === undefined) continue
    const run = state.runs.get(decisiveRunId)
    if (run?.closed === undefined || run.closed.source !== 'run/closed') continue
    if (run.closed.classification !== task.closed.outcome) {
      throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} outcome differs from its decisive Run`)
    }
    const evidenceRef = run.closed.evidenceRef
    // A missing independent Evidence is a no-submission/execution-record closure.
    if (evidenceRef === undefined) continue

    const evidenceValue = await readJson(store, evidenceRef, 'evidence')
    const evidence = parseProtocolValue(evidenceSchema, evidenceValue)
    if (!verifyEvidence(evidence)) throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} Evidence digest is invalid`)
    const validatedEvidence = validateEvidence(evidence, {
      contract: task.contract,
      runId: run.runId,
      composition: run.opened.composition,
    })
    if (!validatedEvidence.valid) {
      throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} Evidence is inconsistent: ${validatedEvidence.reason}`)
    }
    if (run.closed.usage !== undefined && canonicalize(run.closed.usage) !== canonicalize(evidence.usage)) {
      throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} Evidence usage differs from its Run closure`)
    }
    const contractValue = await readJson(store, evidence.task, 'contract')
    const sourceContract = parseProtocolValue(taskContractSchema, contractValue)
    if (!verifyTaskContract(sourceContract) || canonicalize(sourceContract) !== canonicalize(task.contract)) {
      throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} contract CAS differs from the Task projection`)
    }
    const receipt = await readPublicReceipt(store, evidence)
    const receiptCheck = validatePublicReceipt(receipt, {
      provider: sourceContract.acceptance,
      operationId: evidence.verification.operationId,
      contractDigest: sourceContract.digest,
      inputDigests: evidence.inputs.map(value => value.digest),
      outputDigests: evidence.outputs.map(value => value.digest),
      requiredCriteria: sourceContract.spec.criteria.filter(criterion => criterion.required).map(criterion => criterion.id),
    })
    if (receiptCheck.verdict === 'invalid' || receiptCheck.verdict !== task.closed.outcome) {
      throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} public receipt does not match its Evidence outcome`)
    }
    assertTraceChild(traceChildren, task, run.runId, evidenceRef, sourceContract)

    const pointId = `${trace.traceId}:replay:${task.taskId}`
    const sourceCase = await freezeEvaluationCase(
      store,
      `${pointId}:case`,
      replayCaseFromContract(sourceContract, request.campaignDeadlineAt),
    )
    const metric = uniqueSourceMetric(receipt)
    const localMetric = metric === undefined ? undefined : {
      criterion: metric.criterion,
      name: metric.name,
      unit: metric.unit,
    }
    const pointValue = {
      v: 1 as const,
      id: pointId,
      sourceTrace: request.trace,
      sourceTaskId: task.taskId,
      sourceContract: evidence.task,
      sourceEvidence: evidenceRef,
      sourceCase,
      baseMethod: baseRef,
      templateId: sourceContract.template.id,
      bindingPath: bindingPathFromTask(state, task),
      outcome: task.closed.outcome,
      localCases: [sourceCase],
      ...(localMetric === undefined ? {} : {
        localMetric,
        replayTolerance: { relative: request.metricRelativeTolerance ?? 0 },
      }),
      closure,
      fanOut: replayFanOut(base, sourceContract.template.id),
      hostFingerprint: request.hostFingerprint,
      ...(request.baselinePolicy === undefined ? {} : { baselinePolicy: request.baselinePolicy }),
    }
    const point = parseProtocolValue(replayPointSchema, pointValue)
    const pointRef = await store.putObject(point.id, encoder.encode(canonicalize(point)))
    const subtreeTokens = subtreeTokensOf(state, task.taskId)
    points.push({
      point,
      pointRef,
      failed: task.closed.outcome === 'failed',
      leaf: ![...state.tasks.values()].some(candidate => candidate.parentTaskId === task.taskId),
      retries: Math.max(0, task.runIds.length - 1),
      subtreeTokens,
      rootTokens,
      priorAttempts: request.priorAttempts?.(point.id) ?? 0,
      qualityHeadroom: task.closed.outcome === 'failed'
        || (metric !== undefined && metric.value > 0),
    })
  }
  return points
}

/** Re-freezes a source contract as one local EvaluationCase with a new absolute deadline. */
export function replayCaseFromContract(contract: TaskContract, deadlineAt: number): EvaluationCase {
  if (!verifyTaskContract(contract)) throw new ReplayContractError('Replay source contract is not sealed')
  assertSafeDeadline(deadlineAt, 'deadlineAt')
  const source = evaluationCaseFromContract(contract)
  return parseProtocolValue(evaluationCaseSchema, {
    ...source,
    spec: withoutLearningDraftOutputs(source.spec),
    limits: { ...source.limits, deadlineAt },
  })
}

export interface LocalSlotContractRequest {
  readonly store: ReplayReader
  readonly point: ReplayPoint
  readonly base: MethodRevision
  readonly candidate?: MethodRevision
  readonly arm: 'baseline' | 'candidate'
  readonly taskId: string
  readonly requestRef: Ref
  /** Defaults to the Point's source case; must be one of its frozen local cases. */
  readonly caseRef?: Ref
}

/**
 * Builds one ordinary root evaluation contract for a local replay slot.
 *
 * The bootstrap baseline uses the platform exploration template; its candidate
 * uses the candidate entry template. Every other root/child point fixes the
 * source template id. Resources are always resolved from the frozen case plus
 * the arm's Method/template catalog.
 */
export async function contractForLocalSlot(request: LocalSlotContractRequest): Promise<TaskContract> {
  if (!verifyMethodRevision(request.base)) throw new ReplayContractError('Local base Method is not sealed')
  const baseRef = refOf(request.base)
  if (!sameRef(request.point.baseMethod, baseRef)) {
    throw new ReplayContractError('ReplayPoint base Method differs from the supplied base Method')
  }
  assertNonemptyString(request.taskId, 'taskId')
  const caseRef = request.caseRef ?? request.point.sourceCase
  if (!request.point.localCases.some(candidate => sameRef(candidate, caseRef))) {
    throw new ReplayContractError('Local slot case is not one of the frozen ReplayPoint cases')
  }
  const sourceCase = await readEvaluationCase(request.store, caseRef)
  const exploration: GlobalResourceSnapshot | undefined = sourceCase.exploration === undefined
    ? undefined
    : parseProtocolValue(globalResourceSnapshotSchema, await readJson(request.store, sourceCase.exploration))
  const bootstrap = isRootBootstrap(request.point)
  let method = request.base
  let templateId: string
  if (request.arm === 'baseline') {
    templateId = bootstrap ? EXPLORE_TEMPLATE_ID : request.point.templateId
  } else {
    if (request.candidate === undefined) throw new ReplayContractError('Candidate arm requires a candidate Method')
    if (!verifyMethodRevision(request.candidate)) throw new ReplayContractError('Local candidate Method is not sealed')
    if (request.candidate.parent !== undefined && !sameRef(request.candidate.parent, baseRef)) {
      throw new ReplayContractError('Local candidate Method does not descend from the replay base')
    }
    method = request.candidate
    templateId = bootstrap ? request.candidate.entryTemplateId ?? '' : request.point.templateId
    if (bootstrap && templateId === '') {
      throw new ReplayContractError('Bootstrap candidate has no entry template')
    }
  }
  const template = resolveTemplateView(method, templateId, exploration)
  if (template === undefined) {
    throw new ReplayContractError(`Local template ${JSON.stringify(templateId)} does not resolve in the ${request.arm} Method`)
  }
  const catalog = resourceAssetCatalog({
    method,
    ...(exploration === undefined ? {} : { exploration }),
  })
  const resources = {
    baseTools: [...sourceCase.baseTools],
    skills: template.skills.map(id => singleSkill(catalog.skills, id).bundle),
    mcpServers: template.tools.map(id => singleTool(catalog.tools, id).server.bundle),
    ...(sourceCase.exploration === undefined ? {} : { exploration: sourceCase.exploration }),
  }
  return admitRootTask({
    taskId: request.taskId,
    spec: withoutLearningDraftOutputs(sourceCase.spec),
    origin: { kind: 'root', purpose: 'evaluation', requestRef: request.requestRef },
    method: refOf(method),
    template: { id: template.id, digest: method.digest },
    resources,
    acceptance: sourceCase.acceptance,
    environment: sourceCase.environment,
    limits: sourceCase.limits,
  })
}

export interface ScopedCandidateRequest {
  readonly point: ReplayPoint
  readonly base: MethodRevision
  readonly candidate: MethodRevision
  readonly patch: Pick<MethodPatchDraft, 'changes'>
  readonly editBudget?: number
}

export interface ScopedCandidateResult {
  readonly kind: 'bootstrap-entry' | 'existing-template' | 'expand-template'
  readonly templateId: string
  readonly sharedTemplate: boolean
  readonly affectedTemplateIds: readonly string[]
  readonly fanOut: ReplayPoint['fanOut']
}

/**
 * Enforces the local candidate boundary before any local purchase. Bootstrap
 * points may add exactly one new template and entry; existing points may
 * replace the selected template, or expand it with one new child template and
 * one new binding, plus bound assets.
 */
export function assertScopedCandidate(request: ScopedCandidateRequest): ScopedCandidateResult {
  const { point, base, candidate, patch } = request
  if (!verifyMethodRevision(base)) throw new ReplayScopeError('METHOD_INVALID', 'Local base Method is not sealed')
  if (!verifyMethodRevision(candidate)) throw new ReplayScopeError('METHOD_INVALID', 'Local candidate Method is not sealed')
  if (!sameRef(point.baseMethod, refOf(base))) {
    throw new ReplayScopeError('METHOD_INVALID', 'ReplayPoint base Method differs from the supplied base')
  }
  if (candidate.parent === undefined || !sameRef(candidate.parent, refOf(base))) {
    throw new ReplayScopeError('METHOD_INVALID', 'Local candidate Method must descend from the replay base')
  }
  const budget = request.editBudget ?? DEFAULT_REPLAY_EDIT_BUDGET
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new ReplayScopeError('EDIT_BUDGET', 'Local edit budget must be a positive safe integer')
  }
  if (patch.changes.length > budget) {
    throw new ReplayScopeError('EDIT_BUDGET', `Local candidate uses ${String(patch.changes.length)} edits above the budget of ${String(budget)}`)
  }
  const removeOps = patch.changes.filter(change => change.op === 'remove-template'
    || change.op === 'remove-skill' || change.op === 'remove-mcp-server')
  if (removeOps.length > 0) throw new ReplayScopeError('REMOVE_FORBIDDEN', 'Local candidates cannot remove Method assets')

  if (base.templates.length === 0 && base.entryTemplateId !== undefined) {
    throw new ReplayScopeError('BOOTSTRAP_ENTRY', 'Bootstrap candidates require an empty base entry')
  }
  if (base.templates.length === 0 && point.templateId !== EXPLORE_TEMPLATE_ID) {
    throw new ReplayScopeError('BOOTSTRAP_TEMPLATE', 'Bootstrap candidates require the platform exploration template')
  }
  if (base.templates.length > 0 && point.templateId === EXPLORE_TEMPLATE_ID) {
    throw new ReplayScopeError('BOOTSTRAP_TEMPLATE', 'Only a root bootstrap point may target the platform exploration template')
  }
  if (point.templateId === EXPLORE_TEMPLATE_ID) return scopedBootstrap(point, base, candidate, patch)
  if (patch.changes.some(change => change.op === 'set-entry')) {
    throw new ReplayScopeError('SET_ENTRY_FORBIDDEN', 'Existing-template candidates cannot change the Method entry')
  }
  const selected = base.templates.find(template => template.id === point.templateId)
  if (selected === undefined) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', `Selected template ${JSON.stringify(point.templateId)} is absent from the base Method`)
  }
  const baseTemplates = new Map(base.templates.map(template => [template.id, template]))
  const candidateTemplates = new Map(candidate.templates.map(template => [template.id, template]))
  if (candidateTemplates.size !== candidate.templates.length) {
    throw new ReplayScopeError('METHOD_INVALID', 'Candidate template ids must be unique')
  }
  for (const id of baseTemplates.keys()) {
    if (!candidateTemplates.has(id)) throw new ReplayScopeError('REMOVE_FORBIDDEN', `Template ${JSON.stringify(id)} was removed`)
  }
  const changedTemplates = [...candidateTemplates.values()].filter(template => {
    const previous = baseTemplates.get(template.id)
    return previous === undefined || canonicalize(previous) !== canonicalize(template)
  })
  if (candidate.entryTemplateId !== base.entryTemplateId) {
    throw new ReplayScopeError('SET_ENTRY_FORBIDDEN', 'Local candidates cannot change the Method entry')
  }
  const putTemplates = patch.changes.filter(change => change.op === 'put-template')
  const addedTemplate = changedTemplates.find(template => !baseTemplates.has(template.id))
  const expanding = changedTemplates.some(template => template.id === selected.id) && addedTemplate !== undefined
  if (!expanding && (changedTemplates.length !== 1 || changedTemplates[0]?.id !== selected.id)) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', 'Local candidates replace or expand only the selected template')
  }
  if (expanding && (changedTemplates.length !== 2 || candidate.templates.length !== base.templates.length + 1
    || putTemplates.length !== 2)) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', 'Template expansion requires one new template and two put-template edits')
  }
  if (!expanding && putTemplates.length !== 1) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', 'Existing-template candidates require exactly one put-template')
  }
  const targetIds = expanding ? [selected.id, addedTemplate.id] : [selected.id]
  for (const change of putTemplates) {
    if (!targetIds.includes(change.template.id)) {
      throw new ReplayScopeError('SINGLE_TEMPLATE', 'put-template must target the selected template or its new child')
    }
  }
  if (putTemplates.length !== new Set(putTemplates.map(change => change.template.id)).size) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', 'put-template ids must be unique')
  }
  for (const change of patch.changes) {
    if (change.op === 'put-skill' && base.skills.some(skill => skill.id === change.skill.id)) {
      throw new ReplayScopeError('ASSET_OVERWRITE', `Skill ${JSON.stringify(change.skill.id)} already exists in the base Method`)
    }
    if (change.op === 'put-mcp-server' && base.tools.some(tool => tool.id === change.server.id)) {
      throw new ReplayScopeError('ASSET_OVERWRITE', `MCP server ${JSON.stringify(change.server.id)} already exists in the base Method`)
    }
  }
  assertCommonAssetsUnchanged(base, candidate)
  const addedSkills = candidate.skills.filter(skill => !base.skills.some(previous => previous.id === skill.id))
  const addedTools = candidate.tools.filter(tool => !base.tools.some(previous => previous.id === tool.id))
  for (const skill of addedSkills) {
    if (!patch.changes.some(change => change.op === 'put-skill' && change.skill.id === skill.id)) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New skill ${JSON.stringify(skill.id)} has no put-skill edit`)
    }
  }
  for (const tool of addedTools) {
    if (!patch.changes.some(change => change.op === 'put-mcp-server' && change.server.id === tool.id)) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New MCP server ${JSON.stringify(tool.id)} has no put-mcp-server edit`)
    }
  }
  const targets = targetIds.map(id => candidateTemplates.get(id) as (typeof candidate.templates)[number])
  for (const skill of addedSkills) {
    if (!targets.some(template => template.skills.includes(skill.id))) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New skill ${JSON.stringify(skill.id)} is not bound to a changed template`)
    }
  }
  for (const tool of addedTools) {
    if (!targets.some(template => template.tools.includes(tool.id))) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New MCP server ${JSON.stringify(tool.id)} is not bound to a changed template`)
    }
  }
  const changed = candidateTemplates.get(selected.id) as (typeof candidate.templates)[number]
  assertChildReferences(selected, changed, candidateTemplates)
  if (expanding) assertExpandedChildren(selected, changed, addedTemplate.id)
  const fanOut = replayFanOut(candidate, selected.id)
  if (fanOut.bindingReferences !== point.fanOut.bindingReferences || fanOut.shared !== point.fanOut.shared) {
    throw new ReplayScopeError('FANOUT_CHANGED', 'Local candidate changes the selected template fan-out')
  }
  return {
    kind: expanding ? 'expand-template' : 'existing-template',
    templateId: selected.id,
    sharedTemplate: point.fanOut.shared,
    affectedTemplateIds: expanding ? [selected.id, addedTemplate.id] : [selected.id],
    fanOut,
  }
}

/** New or changed child bindings must resolve to a candidate template or the platform fallback. */
function assertChildReferences(
  base: MethodRevision['templates'][number],
  candidate: MethodRevision['templates'][number],
  templates: ReadonlyMap<string, MethodRevision['templates'][number]>,
): void {
  const previous = new Map(base.children.map(binding => [binding.bindingId, binding]))
  for (const binding of candidate.children) {
    const old = previous.get(binding.bindingId)
    if (old !== undefined && canonicalize(old) === canonicalize(binding)) continue
    if (templates.has(binding.templateId) || binding.templateId.startsWith('platform:')) continue
    throw new ReplayScopeError('EXPAND_CHILDREN', `Child binding ${JSON.stringify(binding.bindingId)} does not resolve`)
  }
}

/** A single new child binding must be the only change to the selected children. */
function assertExpandedChildren(
  base: MethodRevision['templates'][number],
  candidate: MethodRevision['templates'][number],
  addedTemplateId: string,
): void {
  const previous = new Map(base.children.map(binding => [binding.bindingId, binding]))
  if (previous.size !== base.children.length) {
    throw new ReplayScopeError('METHOD_INVALID', 'Base child binding ids must be unique')
  }
  const current = new Map(candidate.children.map(binding => [binding.bindingId, binding]))
  if (current.size !== candidate.children.length) {
    throw new ReplayScopeError('METHOD_INVALID', 'Candidate child binding ids must be unique')
  }
  if (candidate.children.length !== base.children.length + 1) {
    throw new ReplayScopeError('EXPAND_CHILDREN', 'Template expansion requires exactly one new child binding')
  }
  for (const [id, binding] of previous) {
    const next = current.get(id)
    if (next === undefined || canonicalize(next) !== canonicalize(binding)) {
      throw new ReplayScopeError('EXPAND_CHILDREN', `Existing child binding ${JSON.stringify(id)} changed or disappeared`)
    }
  }
  const added = candidate.children.filter(binding => !previous.has(binding.bindingId))
  if (added.length !== 1 || added[0]?.templateId !== addedTemplateId) {
    throw new ReplayScopeError('EXPAND_CHILDREN', 'The new child binding must reference the new template exactly once')
  }
}

/** Exact or explicitly drifted baseline observation. */
export interface BaselineFidelityResult {
  readonly fidelity: 'exact' | 'verdict-drift'
  readonly sourceVerdict: 'verified' | 'failed'
  readonly baselineVerdict: 'verified' | 'failed'
}

/** Compares a fresh baseline observation with the frozen source case. */
export interface BaselineFidelityRequest {
  readonly store: ReplayReader
  readonly point: ReplayPoint
  readonly hostFingerprint: string
  readonly observation: {
    readonly caseRef: Ref
    readonly verdict: 'verified' | 'failed'
    readonly receipt: PublicReceipt
  }
}

/**
 * Business drift throws `BaselineDriftError`; CAS/parsing and other host
 * failures propagate unchanged. The source receipt is re-read from CAS rather
 * than trusted from a caller-supplied summary.
 */
export async function assertBaselineFidelity(request: BaselineFidelityRequest): Promise<BaselineFidelityResult> {
  const { point } = request
  assertNonemptyString(request.hostFingerprint, 'hostFingerprint')
  if (request.hostFingerprint !== point.hostFingerprint) {
    throw new BaselineDriftError('host-fingerprint', 'Baseline host fingerprint differs from the frozen ReplayPoint')
  }
  if (!sameRef(request.observation.caseRef, point.sourceCase)) {
    throw new BaselineDriftError('source-case', 'Baseline observation is not for the frozen source case')
  }
  const contractValue = await readJson(request.store, point.sourceContract, 'contract')
  const contract = parseProtocolValue(taskContractSchema, contractValue)
  if (!verifyTaskContract(contract)) throw new ReplayContractError('Replay source contract is not sealed')
  const sourceEvidenceValue = await readJson(request.store, point.sourceEvidence, 'evidence')
  const sourceEvidence = parseProtocolValue(evidenceSchema, sourceEvidenceValue)
  if (!verifyEvidence(sourceEvidence)) throw new ReplayContractError('Replay source Evidence digest is invalid')
  const sourceReceipt = await readPublicReceipt(request.store, sourceEvidence)
  const sourceCheck = validatePublicReceipt(sourceReceipt, {
    provider: contract.acceptance,
    operationId: sourceEvidence.verification.operationId,
    contractDigest: contract.digest,
    inputDigests: sourceEvidence.inputs.map(value => value.digest),
    outputDigests: sourceEvidence.outputs.map(value => value.digest),
    requiredCriteria: contract.spec.criteria.filter(criterion => criterion.required).map(criterion => criterion.id),
  })
  if (sourceCheck.verdict === 'invalid') {
    throw new ReplayContractError(`Replay source public receipt is invalid: ${sourceCheck.reason}`)
  }
  if (sourceCheck.verdict !== point.outcome) {
    throw new BaselineDriftError('source-verdict', 'Source public receipt verdict differs from the frozen ReplayPoint')
  }
  if (request.observation.verdict !== point.outcome) {
    if ((point.baselinePolicy ?? 'strict') === 'strict') {
      throw new BaselineDriftError('baseline-verdict', 'Fresh baseline verdict differs from the frozen source outcome')
    }
    return { fidelity: 'verdict-drift', sourceVerdict: point.outcome, baselineVerdict: request.observation.verdict }
  }
  if (point.localMetric === undefined) {
    return { fidelity: 'exact', sourceVerdict: point.outcome, baselineVerdict: request.observation.verdict }
  }

  const sourceMetric = uniqueMetric(sourceReceipt, point.localMetric, 'source')
  const baselineMetric = uniqueMetric(request.observation.receipt, point.localMetric, 'baseline')
  const tolerance = point.replayTolerance?.relative ?? 0
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ReplayContractError('ReplayPoint tolerance is not a nonnegative finite number')
  }
  if (sourceMetric.value === 0) {
    if (baselineMetric.value !== 0) {
      throw new BaselineDriftError('baseline-metric', 'Baseline metric differs from a zero source metric')
    }
    return { fidelity: 'exact', sourceVerdict: point.outcome, baselineVerdict: request.observation.verdict }
  }
  const relative = Math.abs(baselineMetric.value - sourceMetric.value) / Math.abs(sourceMetric.value)
  if (relative > tolerance) {
    throw new BaselineDriftError('baseline-metric',
      `Baseline metric drift ${String(relative)} exceeds the frozen relative tolerance ${String(tolerance)}`)
  }
  return { fidelity: 'exact', sourceVerdict: point.outcome, baselineVerdict: request.observation.verdict }
}

/** Counts binding sites that reference the template from any base template's children. */
export function replayFanOut(method: MethodRevision, templateId: string): ReplayPoint['fanOut'] {
  const bindingReferences = method.templates.reduce(
    (total, template) => total + template.children.filter(binding => binding.templateId === templateId).length,
    0,
  )
  return {
    bindingReferences,
    shared: bindingReferences > 1
      || (bindingReferences > 0 && method.entryTemplateId === templateId),
  }
}

/** Path of child binding ids from the source root down to (and including) the Task. */
export function bindingPathFromTask(state: TaskRunState, task: TaskState): readonly string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let current = task
  while (current.parentTaskId !== undefined) {
    if (current.bindingId === undefined) {
      throw new ReplayContractError(`Task ${JSON.stringify(current.taskId)} has no frozen binding id`)
    }
    if (seen.has(current.taskId)) throw new ReplayContractError('Task tree contains a cycle')
    seen.add(current.taskId)
    path.unshift(current.bindingId)
    const parent = state.tasks.get(current.parentTaskId)
    if (parent === undefined) throw new ReplayContractError(`Task ${JSON.stringify(current.taskId)} parent is missing`)
    current = parent
  }
  return path
}

function scopedBootstrap(
  point: ReplayPoint,
  base: MethodRevision,
  candidate: MethodRevision,
  patch: Pick<MethodPatchDraft, 'changes'>,
): ScopedCandidateResult {
  if (point.bindingPath.length !== 0) {
    throw new ReplayScopeError('BOOTSTRAP_PATH', 'Bootstrap candidates require a root Point')
  }
  if (point.templateId !== EXPLORE_TEMPLATE_ID) {
    throw new ReplayScopeError('BOOTSTRAP_TEMPLATE', 'Bootstrap candidates require the platform exploration template')
  }
  if (base.templates.length !== 0 || base.entryTemplateId !== undefined) {
    throw new ReplayScopeError('BOOTSTRAP_ENTRY', 'Bootstrap candidates require an empty base entry and template set')
  }
  if (patch.changes.some(change => change.op === 'remove-template'
    || change.op === 'remove-skill' || change.op === 'remove-mcp-server')) {
    throw new ReplayScopeError('REMOVE_FORBIDDEN', 'Bootstrap candidates cannot remove Method assets')
  }
  const putTemplates = patch.changes.filter(change => change.op === 'put-template')
  if (putTemplates.length !== 1) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', 'Bootstrap candidates require exactly one new template')
  }
  const putTemplate = putTemplates[0]
  if (candidate.templates.length !== 1 || candidate.templates[0]?.id !== putTemplate.template.id) {
    throw new ReplayScopeError('SINGLE_TEMPLATE', 'Bootstrap candidates may add exactly one template')
  }
  if (candidate.entryTemplateId === undefined || candidate.entryTemplateId !== putTemplate.template.id) {
    throw new ReplayScopeError('BOOTSTRAP_ENTRY', 'Bootstrap candidate entry must point to its new template')
  }
  const entries = patch.changes.filter(change => change.op === 'set-entry')
  if (entries.length !== 1 || entries[0].templateId !== putTemplate.template.id) {
    throw new ReplayScopeError('BOOTSTRAP_ENTRY', 'Bootstrap candidates require one set-entry pointing to the new template')
  }
  for (const change of patch.changes) {
    if (change.op === 'put-skill' && base.skills.some(skill => skill.id === change.skill.id)) {
      throw new ReplayScopeError('ASSET_OVERWRITE', `Skill ${JSON.stringify(change.skill.id)} already exists in the base Method`)
    }
    if (change.op === 'put-mcp-server' && base.tools.some(tool => tool.id === change.server.id)) {
      throw new ReplayScopeError('ASSET_OVERWRITE', `MCP server ${JSON.stringify(change.server.id)} already exists in the base Method`)
    }
  }
  const template = candidate.templates[0]
  assertCommonAssetsUnchanged(base, candidate)
  const addedSkills = candidate.skills.filter(skill => !base.skills.some(previous => previous.id === skill.id))
  const addedTools = candidate.tools.filter(tool => !base.tools.some(previous => previous.id === tool.id))
  for (const skill of addedSkills) {
    if (!patch.changes.some(change => change.op === 'put-skill' && change.skill.id === skill.id)) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New skill ${JSON.stringify(skill.id)} has no put-skill edit`)
    }
    if (!template.skills.includes(skill.id)) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New skill ${JSON.stringify(skill.id)} is not bound to the bootstrap template`)
    }
  }
  for (const tool of addedTools) {
    if (!patch.changes.some(change => change.op === 'put-mcp-server' && change.server.id === tool.id)) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New MCP server ${JSON.stringify(tool.id)} has no put-mcp-server edit`)
    }
    if (!template.tools.includes(tool.id)) {
      throw new ReplayScopeError('ASSET_UNBOUND', `New MCP server ${JSON.stringify(tool.id)} is not bound to the bootstrap template`)
    }
  }
  const fanOut = replayFanOut(candidate, template.id)
  return {
    kind: 'bootstrap-entry',
    templateId: template.id,
    sharedTemplate: fanOut.shared,
    affectedTemplateIds: [template.id],
    fanOut,
  }
}

function assertCommonAssetsUnchanged(base: MethodRevision, candidate: MethodRevision): void {
  const baseSkills = new Map(base.skills.map(skill => [skill.id, skill]))
  const candidateSkills = new Map(candidate.skills.map(skill => [skill.id, skill]))
  if (candidateSkills.size !== candidate.skills.length) {
    throw new ReplayScopeError('METHOD_INVALID', 'Candidate skill ids must be unique')
  }
  for (const [id, skill] of baseSkills) {
    const next = candidateSkills.get(id)
    if (next === undefined) throw new ReplayScopeError('REMOVE_FORBIDDEN', `Skill ${JSON.stringify(id)} was removed`)
    if (canonicalize(skill) !== canonicalize(next)) {
      throw new ReplayScopeError('ASSET_OVERWRITE', `Skill ${JSON.stringify(id)} was overwritten`)
    }
  }
  const baseTools = new Map(base.tools.map(tool => [tool.id, tool]))
  const candidateTools = new Map(candidate.tools.map(tool => [tool.id, tool]))
  if (candidateTools.size !== candidate.tools.length) {
    throw new ReplayScopeError('METHOD_INVALID', 'Candidate MCP server ids must be unique')
  }
  for (const [id, tool] of baseTools) {
    const next = candidateTools.get(id)
    if (next === undefined) throw new ReplayScopeError('REMOVE_FORBIDDEN', `MCP server ${JSON.stringify(id)} was removed`)
    if (canonicalize(tool) !== canonicalize(next)) {
      throw new ReplayScopeError('ASSET_OVERWRITE', `MCP server ${JSON.stringify(id)} was overwritten`)
    }
  }
}

function isRootBootstrap(point: ReplayPoint): boolean {
  return point.templateId === EXPLORE_TEMPLATE_ID && point.bindingPath.length === 0
}

function uniqueSourceMetric(receipt: PublicReceipt): { criterion: string; name: string; unit: string; value: number } | undefined {
  const metrics = receipt.criteria.filter(criterion => criterion.metric !== undefined)
  if (metrics.length !== 1) return undefined
  const metric = metrics[0].metric
  if (metric === undefined || !Number.isFinite(metric.value)) return undefined
  return { criterion: metrics[0].id, name: metric.name, unit: metric.unit, value: metric.value }
}

function uniqueMetric(
  receipt: PublicReceipt,
  expected: NonNullable<ReplayPoint['localMetric']>,
  label: 'source' | 'baseline',
): { value: number } {
  const metrics = receipt.criteria.filter(criterion => criterion.metric !== undefined)
  if (metrics.length !== 1) {
    throw new BaselineDriftError(
      label === 'source' ? 'source-metric' : 'baseline-metric',
      `${label} receipt must carry exactly one metric`,
    )
  }
  const metric = metrics[0].metric
  if (metric === undefined
    || metrics[0].id !== expected.criterion || metric.name !== expected.name || metric.unit !== expected.unit
    || !Number.isFinite(metric.value)) {
    throw new BaselineDriftError(
      label === 'source' ? 'source-metric' : 'baseline-metric',
      `${label} metric does not match the frozen local metric selector`,
    )
  }
  return { value: metric.value }
}

async function readSealedTrace(store: ReplayStore, trace: Ref): Promise<TraceBody> {
  const sealed = store.facts().some((fact): fact is Extract<Fact, { readonly type: 'rsi/trace-sealed' }> =>
    fact.type === 'rsi/trace-sealed' && sameRef(fact.data.trace, trace))
  if (!sealed) throw new ReplayContractError('ReplayPoint source trace is not sealed in this domain')
  const value = await readJson(store, trace)
  if (!isRecord(value) || value['v'] !== 1 || value['kind'] !== 'public-task-trace'
    || typeof value['traceId'] !== 'string' || !Array.isArray(value['chapters'])
    || !isRecord(value['rootTask']) || typeof value['rootTask']['id'] !== 'string'
    || typeof value['rootTask']['outcome'] !== 'string' || !isRef(value['rootTask']['method'])
    || typeof value['digest'] !== 'string' || value['digest'] !== trace.digest
    || !verifyDigest('object', value as never)) {
    throw new ReplayContractError('Sealed public trace is malformed')
  }
  const chapters = value['chapters'].flatMap(chapter => isRecord(chapter)
    && typeof chapter['id'] === 'string' && isRef(chapter['object'])
    ? [{ id: chapter['id'], object: chapter['object'] }] : [])
  return {
    v: 1,
    kind: 'public-task-trace',
    traceId: value['traceId'],
    rootTask: { id: value['rootTask']['id'], outcome: value['rootTask']['outcome'], method: value['rootTask']['method'] },
    chapters,
    digest: value['digest'],
  }
}

async function assertTraceRootContract(store: ReplayStore, trace: TraceBody, root: TaskContract): Promise<void> {
  const chapter = trace.chapters.find(candidate => candidate.id === 'contract')
  if (chapter === undefined) throw new ReplayContractError('Sealed trace has no contract chapter')
  // Trace chapters are public object-domain snapshots, not contract-domain refs.
  const value = await readJson(store, chapter.object)
  const contract = parseProtocolValue(taskContractSchema, value)
  if (!verifyTaskContract(contract) || contract.digest !== root.digest) {
    throw new ReplayContractError('Sealed trace root contract differs from the supplied Task state')
  }
}

async function readTraceChildren(store: ReplayStore, trace: TraceBody): Promise<readonly Record<string, unknown>[]> {
  const chapter = trace.chapters.find(candidate => candidate.id === 'children')
  if (chapter === undefined) throw new ReplayContractError('Sealed trace has no children chapter')
  const value = await readJson(store, chapter.object)
  if (!Array.isArray(value) || value.some(entry => !isRecord(entry))) {
    throw new ReplayContractError('Sealed trace children chapter is malformed')
  }
  return value as Record<string, unknown>[]
}

function assertTraceChild(
  children: readonly Record<string, unknown>[],
  task: TaskState,
  runId: string,
  evidenceRef: Ref,
  contract: TaskContract,
): void {
  const entry = children.find(candidate => candidate['kind'] !== 'contract-summary'
    && candidate['taskId'] === task.taskId && candidate['runId'] === runId)
  if (entry === undefined) {
    throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} decisive Run is absent from the sealed trace`)
  }
  const tracedContract = entry['contract']
  const result = entry['result']
  if (entry['outcome'] !== task.closed?.outcome
    || !isRecord(tracedContract) || tracedContract['digest'] !== contract.digest
    || !isRecord(result) || !isRef(result['evidenceRef']) || !sameRef(result['evidenceRef'], evidenceRef)) {
    throw new ReplayContractError(`Task ${JSON.stringify(task.taskId)} trace entry contradicts its Task/Evidence state`)
  }
}

async function readPublicReceipt(store: ReplayReader, evidence: Evidence): Promise<PublicReceipt> {
  const value = await readJson(store, evidence.verification.publicReceipt)
  const receipt = parseProtocolValue(publicReceiptSchema, value)
  // Parsing is not enough: a sealed object-domain digest must verify.
  if (receipt.digest !== evidence.verification.publicReceipt.digest) {
    throw new ReplayContractError('Public receipt CAS digest differs from its Evidence reference')
  }
  return receipt
}

async function readEvaluationCase(store: ReplayReader, ref: Ref): Promise<EvaluationCase> {
  return parseProtocolValue(evaluationCaseSchema, await readJson(store, ref))
}

async function freezeEvaluationCase(store: ReplayStore, id: string, value: EvaluationCase): Promise<Ref> {
  const parsed = parseProtocolValue(evaluationCaseSchema, value)
  return store.putObject(id, encoder.encode(canonicalize(parsed)))
}

function subtreeTokensOf(state: TaskRunState, taskId: string): number {
  const taskIds = new Set<string>([taskId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of state.tasks.values()) {
      if (task.parentTaskId !== undefined && taskIds.has(task.parentTaskId) && !taskIds.has(task.taskId)) {
        taskIds.add(task.taskId)
        changed = true
      }
    }
  }
  let total = 0
  for (const run of state.runs.values()) {
    if (taskIds.has(run.taskId)) total += usageTokens(run.closed?.usage)
  }
  return total
}

function usageTokens(usage: UsageRecord | undefined): number {
  if (usage === undefined) return 0
  return usage.inputTokens + usage.outputTokens + usageTokens(usage.summary)
}

async function readJson(store: ReplayReader, ref: Ref, domain: CasDigestDomain = 'object'): Promise<unknown> {
  const { bytes } = await store.readObject(ref, domain)
  return parseJsonText(strictUtf8.decode(bytes))
}

function singleSkill(
  skills: MethodRevision['skills'],
  id: string,
): MethodRevision['skills'][number] {
  const matches = skills.filter(skill => skill.id === id)
  if (matches.length !== 1) throw new ReplayContractError(`Template skill ${JSON.stringify(id)} must resolve exactly once`)
  return matches[0]
}

function singleTool(
  tools: MethodRevision['tools'],
  id: string,
): MethodRevision['tools'][number] {
  const matches = tools.filter(tool => tool.id === id)
  if (matches.length !== 1) throw new ReplayContractError(`Template MCP server ${JSON.stringify(id)} must resolve exactly once`)
  return matches[0]
}

function refOf(method: MethodRevision): Ref {
  return { id: method.id, digest: method.digest }
}

function sameRef(left: Ref, right: Ref): boolean {
  return left.id === right.id && left.digest === right.digest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRef(value: unknown): value is Ref {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['digest'] === 'string'
}

function assertNonemptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new ReplayContractError(`${label} must be a nonempty string`)
}

function assertSafeDeadline(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ReplayContractError(`${label} must be a positive safe integer`)
}
