import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent,SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Evidence,ExecutionRecord,FactActor,JsonValue,Ref,SessionCut,UsageRecord } from '@singularity/protocol'
import {
cancellationCutSchema,canonicalize,compositionSchema,contractSummarySchema,evidenceSchema,executionRecordSchema,methodRevisionSchema,
parseJsonText,parseProtocolValue,refSchema,seal,submissionManifestSchema,validatePublicReceipt,verifyDigest,
} from '@singularity/protocol'
import { DecomposeError } from './errors.ts'

import { snapshotSessionEvents } from './agent.ts'
import type { ContractSummaryService } from './contract-summary.ts'
import { parsePrepareEnvelope } from './decompose-preview.ts'
import { loadGlobalResources } from './global-resources.ts'
import { readTreeBundle } from './resource-bundle.ts'
import { commitFact } from './run-settlement.ts'
import type { CommandService } from './service.ts'
import { sameRef } from './skill-resources.ts'
import type { CasDigestDomain } from './store.ts'
import { publicVerificationOf } from './verification.ts'
import type { CasObjectReader } from './workspace.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const CHAPTERS = ['contract', 'timeline', 'children', 'evidence', 'tool-use', 'planning', 'feedback'] as const
const PAGE_CHARS = 3072

export interface PublicTrace {
  readonly v: 1
  readonly kind: 'public-task-trace'
  readonly traceId: string
  readonly rootTask: { readonly id: string; readonly outcome: string; readonly method: Ref }
  readonly sourceResourceSnapshot: Ref
  readonly chapters: readonly { readonly id: string; readonly object: Ref; readonly sizeClass: 'small' | 'paged'; readonly pages: number }[]
  readonly authorizedObjects: readonly { readonly ref: Ref; readonly domain: CasDigestDomain }[]
  readonly usage: UsageRecord
  readonly sessionCuts: readonly SessionCut[]
  readonly digest: string
}

export interface SealPublicTraceRequest {
  readonly service: CommandService
  readonly actor: FactActor
  readonly rootTaskId: string
  readonly ctx?: Context
  readonly readSessionEvents?: (cut: SessionCut) => Promise<readonly SessionEvent[]>
  readonly summaries?: Pick<ContractSummaryService, 'records' | 'executions'>
  /** Frozen domain RSI eligibility policy for a failed/invalid decisive ExecutionRecord. */
  readonly acceptsExecutionRecord?: (record: ExecutionRecord) => boolean
  readonly transientInvalidReasons?: readonly string[]
}

/** Seal only closed Task trees with final persisted DSH cuts and readable public artifacts. */
export async function sealPublicTrace(request: SealPublicTraceRequest): Promise<{ readonly trace: Ref; readonly body: PublicTrace }> {
  const { service, rootTaskId } = request
  const previous = service.facts().find(fact => fact.type === 'rsi/trace-sealed' && fact.data.rootTaskId === rootTaskId)
  if (previous?.type === 'rsi/trace-sealed') return { trace: previous.data.trace, body: await readPublicTrace(service, previous.data.trace) }
  const state = await service.taskRunState(request.transientInvalidReasons ?? [])
  const root = state.tasks.get(rootTaskId)
  if (root === undefined || root.parentTaskId !== undefined || root.phase !== 'closed') throw new Error('Trace source must be a terminal root Task')
  const tasks = [...state.tasks.values()].filter(task => task.rootTaskId === rootTaskId)
  if (tasks.some(task => task.phase !== 'closed')) throw new Error('Every descendant Task must be terminal before trace sealing')
  const taskIds = new Set(tasks.map(task => task.taskId))
  const runs = [...state.runs.values()].filter(run => taskIds.has(run.taskId))
  if (runs.length === 0 || runs.some(run => run.phase !== 'closed')) throw new Error('Every admitted Run must be closed before trace sealing')
  const rootClose = service.facts().find(fact => fact.type === 'task/closed' && fact.data.taskId === rootTaskId)
  const decisive = rootClose?.type === 'task/closed' && rootClose.data.decisiveRunId !== undefined
    ? state.runs.get(rootClose.data.decisiveRunId)
    : rootClose?.type === 'task/closed' && rootClose.data.scope === 'subtree' ? state.runs.get(root.runIds.at(-1) ?? '') : undefined
  if (decisive?.closed === undefined) throw new Error('Trace source requires a decisive closed Run')
  const authorized = new Map<string, { ref: Ref; domain: CasDigestDomain }>()
  const authorize = async (ref: Ref, domain: CasDigestDomain = 'object') => {
    await service.readObject(ref, domain)
    authorized.set(refKey(ref), { ref, domain })
  }
  const cancellationResults = new Map<string, Ref>()
  for (const fact of service.facts()) {
    if (fact.type !== 'task/closed' || fact.data.scope !== 'subtree' || !taskIds.has(fact.data.taskId)
      || fact.data.cancellationCutRef === undefined) continue
    const cut = parseProtocolValue(cancellationCutSchema, await readJson(service, fact.data.cancellationCutRef))
    if (!verifyDigest('object', cut) || cut.targetTaskId !== fact.data.taskId) throw new Error('CancellationCut identity or digest differs from its closure')
    await authorize(fact.data.cancellationCutRef)
    for (const affected of cut.affected) {
      if (!taskIds.has(affected.taskId)) throw new Error('CancellationCut includes a Task outside the source tree')
      if (affected.runId === undefined) continue
      const run = state.runs.get(affected.runId)
      if (run?.taskId !== affected.taskId || run.closed?.source !== 'subtree-cancellation'
        || run.closed.factDigest !== fact.digest || affected.executionRecordRef === undefined
        || cancellationResults.has(affected.runId)) throw new Error('CancellationCut final Run record does not match the source closure')
      cancellationResults.set(affected.runId, affected.executionRecordRef)
    }
  }
  const evidence: unknown[] = []
  const children: unknown[] = []
  const toolUse: unknown[] = []
  const sessionCuts: SessionCut[] = []
  const planning: { runId: string; ref: Ref }[] = []
  const feedback: { runId: string; ref: Ref }[] = []
  const usage: UsageRecord = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0, unknownRequests: 0 }
  const totals = { ...usage }
  const method = parseProtocolValue(methodRevisionSchema, await readJson(service, root.contract.method, 'method'))
  await authorize(root.contract.acceptance)
  await authorize(root.contract.method, 'method')
  for (const template of method.templates) {
    await authorize(template.guidance)
    await authorize(template.example)
    await authorize(template.acceptancePolicy)
  }
  for (const skill of method.skills) await authorizeTree(service, skill.bundle, authorize)
  for (const tool of method.tools) {
    await authorizeTree(service, tool.server.bundle, authorize)
    await authorizeTree(service, tool.server.sourceFiles, authorize)
    await authorize(tool.server.manifest)
    await authorize(tool.server.config)
  }
  const exploration = root.contract.resources.exploration
  if (exploration !== undefined) {
    const resources = await loadGlobalResources(service, exploration)
    await authorize(exploration)
    for (const document of resources.documents) await authorize(document.object)
    for (const ref of [...resources.baseTools, resources.fallbackAcceptance]) await authorize(ref)
    for (const skill of resources.skills) await authorizeTree(service, skill.bundle, authorize)
    for (const tool of resources.tools) {
      await authorizeTree(service, tool.server.bundle, authorize)
      await authorizeTree(service, tool.server.sourceFiles, authorize)
      await authorize(tool.server.manifest)
      await authorize(tool.server.config)
    }
  }
  let sourceResourceSnapshot: Ref | undefined
  for (const run of runs) {
    const task = state.tasks.get(run.taskId)
    if (task === undefined || !sameRef(task.contract.method, root.contract.method)) throw new Error('Source tree Method revision differs from root')
    const close = run.closed
    if (close === undefined) throw new Error('Source Run is missing its terminal closure')
    const executionRecordRef = close.executionRecordRef ?? cancellationResults.get(run.runId)
    let result: Evidence | ExecutionRecord
    if (close.evidenceRef !== undefined) {
      const original = parseProtocolValue(evidenceSchema, await readJson(service, close.evidenceRef, 'evidence'))
      if (!verifyDigest('evidence', original)) throw new Error('Evidence digest is invalid')
      const publicReceipt = await readJson(service, original.verification.publicReceipt)
      const receipt = validatePublicReceipt(publicReceipt, {
        provider: original.verification.provider, operationId: original.verification.operationId,
        contractDigest: task.contract.digest, inputDigests: original.inputs.map(ref => ref.digest),
        outputDigests: original.outputs.map(ref => ref.digest), requiredCriteria: task.contract.spec.criteria.filter(criterion => criterion.required).map(criterion => criterion.id),
      })
      if (receipt.verdict === 'invalid' || receipt.verdict !== close.classification) throw new Error('Run public receipt does not match its terminal classification')
      await authorize(original.verification.publicReceipt)
      // The original Evidence remains operator/evaluator scoped; expose its public projection.
      evidence.push({ evidenceRef: close.evidenceRef, evidence: {
        v: original.v, task: original.task, runId: original.runId, contractDigest: original.contractDigest,
        method: original.method, inputs: original.inputs, outputs: original.outputs, composition: original.composition,
        verification: publicVerificationOf(original.verification),
        usage: original.usage, sessionCut: original.sessionCut, environment: original.environment,
      }, publicReceipt })
      result = original
    } else if (executionRecordRef !== undefined) {
      result = parseProtocolValue(executionRecordSchema, await readJson(service, executionRecordRef))
      if (!verifyDigest('object', result)) throw new Error('ExecutionRecord digest is invalid')
      await authorize(executionRecordRef)
      evidence.push({ executionRecordRef, record: result })
      if (run.runId === decisive.runId && request.acceptsExecutionRecord?.(result) !== true) {
        throw new Error('Decisive ExecutionRecord is not accepted by the frozen RSI eligibility policy')
      }
    } else {
      throw new Error('Closed Run is missing its final result reference')
    }
    if (result.runId !== run.runId || result.contractDigest !== task.contract.digest
      || !sameRef(result.method, task.contract.method) || result.sessionCut.sessionId !== run.opened.sessionId
      || (close.usage !== undefined && canonicalize(result.usage) !== canonicalize(close.usage))
      || (close.source === 'subtree-cancellation' && ('reason' in result ? result.reason !== close.reason : true))) {
      throw new Error('Run result identity or final usage differs from its closure')
    }
    const events = await (request.readSessionEvents?.(result.sessionCut) ?? readPersistedEvents(request.ctx, result.sessionCut))
    if (events.length !== result.sessionCut.to || result.sessionCut.from !== 0) throw new Error('Persisted session does not match the final Run cut')
    const observed = snapshotSessionEvents(run.opened.sessionId, events)
    const runUsage: UsageRecord = {
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      ...(result.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: result.usage.cacheReadTokens }),
      ...(result.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: result.usage.cacheWriteTokens }),
      steps: result.usage.steps, unknownRequests: result.usage.unknownRequests,
    }
    if (canonicalize(observed.usage) !== canonicalize(runUsage)) throw new Error('Persisted session usage differs from the recorded final usage')
    sessionCuts.push(result.sessionCut)
    addUsage(totals, result.usage)
    const transcript = publicSessionEvents(events)
    const sourceReceipts = await authorizeSessionReceipts(events, authorize)
    planning.push(...sourceReceipts.planning.map(ref => ({ runId: run.runId, ref })))
    feedback.push(...sourceReceipts.feedback.map(ref => ({ runId: run.runId, ref })))
    const transcriptRef = await putJson(service, `trace:${rootTaskId}:run:${run.runId}`, { v: 1, runId: run.runId, sessionCut: result.sessionCut, events: transcript })
    await authorize(transcriptRef)
    const composition = parseProtocolValue(compositionSchema, await readJson(service, run.opened.composition, 'composition'))
    await authorize(composition.resources)
    if (run.taskId === rootTaskId && sourceResourceSnapshot === undefined) sourceResourceSnapshot = exploration ?? composition.resources
    for (const input of result.inputs) await authorize(input)
    for (const output of result.outputs ?? []) await authorize(output)
    if (run.submitted !== undefined) {
      const submitted = run.submitted
      const manifest = parseProtocolValue(submissionManifestSchema, await readJson(service, submitted.outputs))
      await authorize(submitted.outputs)
      for (const output of [...manifest.outputs, ...manifest.learningDrafts]) {
        if (output.object !== undefined) {
          if (output.kind === 'tree') await authorizeTree(service, output.object, authorize)
          else await authorize(output.object)
        }
      }
      for (const ref of [...submitted.previewReceipts, ...submitted.readReceipts, submitted.planningSketchRef, ...submitted.feedbackRefs]) await authorize(ref)
    }
    const closedFact = service.facts().find(fact => fact.type === 'run/closed' && fact.data.runId === run.runId)
    if (closedFact?.type === 'run/closed') {
      if (closedFact.data.planningSketchRef !== undefined) await authorize(closedFact.data.planningSketchRef)
      for (const ref of closedFact.data.feedbackRefs) await authorize(ref)
    }
    children.push({ taskId: task.taskId, contract: task.contract, runId: run.runId, attempt: run.attempt,
      outcome: close.classification, transcript: transcriptRef, receipts: sourceReceipts, result: evidence.at(-1) })
    toolUse.push({ taskId: task.taskId, runId: run.runId, transcript: transcriptRef,
      events: transcript.filter(event => event.type === 'tool/call' || event.type === 'tool/result') })
    const executions = request.summaries?.executions().filter(execution => execution.ownerTaskId === task.taskId && execution.runId === run.runId) ?? []
    const summaryUsage = { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 0 }
    for (const execution of executions) {
      const events = await (request.readSessionEvents?.(execution.sessionCut) ?? readPersistedEvents(request.ctx, execution.sessionCut))
      if (execution.sessionCut.from !== 0 || events.length !== execution.sessionCut.to
        || canonicalize(snapshotSessionEvents(execution.sessionCut.sessionId, events).usage) !== canonicalize(execution.usage)) {
        throw new Error('Persisted Summary session differs from its final cut or usage')
      }
      sessionCuts.push(execution.sessionCut)
      addUsage(summaryUsage, execution.usage)
      const record = request.summaries?.records().find(record => record.ownerTaskId === task.taskId && record.runId === run.runId
        && canonicalize(record.sessionCut) === canonicalize(execution.sessionCut))
      if (record !== undefined) {
        const summary = parseProtocolValue(contractSummarySchema, await readJson(service, record.ref.object))
        if (summary.sourceContract !== task.contract.digest || record.ref.sourceContract !== task.contract.digest
          || canonicalize(summary) !== canonicalize(record.summary) || execution.failure !== undefined) {
          throw new Error('Summary object does not match its owning contract or completed execution')
        }
        await authorize(record.ref.object)
      }
      const transcript = publicSessionEvents(events)
      const transcriptRef = await putJson(service, `trace:${rootTaskId}:summary:${execution.sessionCut.sessionId}`, {
        v: 1, taskId: task.taskId, runId: run.runId, sessionCut: execution.sessionCut, events: transcript,
      })
      await authorize(transcriptRef)
      children.push({ kind: 'contract-summary', taskId: task.taskId, runId: run.runId, sessionCut: execution.sessionCut,
        status: execution.failure !== undefined ? 'failed' : record === undefined ? 'no-summary' : 'summarized',
        transcript: transcriptRef, ...(record === undefined ? {} : { summary: record.ref }),
        ...(execution.failure === undefined ? {} : { failure: execution.failure }) })
      toolUse.push({ kind: 'contract-summary', taskId: task.taskId, runId: run.runId, transcript: transcriptRef,
        events: transcript.filter(event => event.type === 'tool/call' || event.type === 'tool/result') })
    }
    const recordedSummary = result.usage.summary
    if (recordedSummary !== undefined) {
      const { ownerTaskId, sourceContract, ...recordedUsage } = recordedSummary
      if (executions.length === 0 || ownerTaskId !== task.taskId || sourceContract !== task.contract.digest
        || canonicalize(recordedUsage) !== canonicalize(summaryUsage)) {
        throw new Error('Summary execution metadata differs from the owning Run closure usage')
      }
    } else if (executions.length > 0) {
      throw new Error('Summary execution is missing from the owning Run closure usage')
    }
  }
  if (sourceResourceSnapshot === undefined) throw new Error('Root source resource snapshot is missing')
  const facts = service.facts().filter(fact => {
    if (fact.type === 'task/admitted' || fact.type === 'task/closed') return taskIds.has(fact.data.taskId)
    if (fact.type === 'run/opened') return taskIds.has(fact.data.taskId)
    if (fact.type === 'run/submitted' || fact.type === 'run/closed') return runs.some(run => run.runId === fact.data.runId)
    return fact.type === 'task/children-admitted' && runs.some(run => run.runId === fact.data.parentRunId)
  })
  const chapterData = {
    contract: root.contract, timeline: facts, children, evidence, 'tool-use': toolUse,
    planning, feedback,
  }
  const chapters = []
  for (const id of CHAPTERS) {
    const text = canonicalize(chapterData[id])
    const object = await putJson(service, `trace:${rootTaskId}:${id}`, chapterData[id])
    chapters.push({ id, object, sizeClass: text.length <= PAGE_CHARS ? 'small' as const : 'paged' as const,
      pages: Math.max(1, Math.ceil(text.length / PAGE_CHARS)) })
  }
  const body = seal('object', {
    v: 1, kind: 'public-task-trace', traceId: `trace:${rootTaskId}`,
    rootTask: { id: rootTaskId, outcome: root.closed?.outcome ?? '', method: root.contract.method },
    sourceResourceSnapshot, chapters, authorizedObjects: [...authorized.values()],
    usage: totals, sessionCuts,
  }) as PublicTrace
  const trace = await putJson(service, body.traceId, body)
  await commitFact(service, request.actor, `trace:${rootTaskId}:sealed`, 'rsi_seal_trace', { taskId: rootTaskId },
    { rootTaskId }, 'rsi/trace-sealed', { rootTaskId, trace, usage: totals, sessionCuts }, request.transientInvalidReasons ?? [])
  return { trace, body }
}

/** A trace is readable by the proposer only after the unique journal seal exists. */
export async function readPublicTrace(service: CommandService, ref: Ref): Promise<PublicTrace> {
  if (!service.facts().some(fact => fact.type === 'rsi/trace-sealed' && sameRef(fact.data.trace, ref))) throw new Error('Trace is not sealed in this domain')
  const value = await readJson(service, ref)
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value['v'] !== 1 || value['kind'] !== 'public-task-trace' || !verifyDigest('object', value)
    || value['digest'] !== ref.digest || !Array.isArray(value['chapters']) || !Array.isArray(value['authorizedObjects'])) {
    throw new Error('Sealed public trace is malformed')
  }
  return value as unknown as PublicTrace
}

/** Reads bounded JSON text pages without granting arbitrary CAS access. */
export async function readTracePage(service: CommandService, trace: PublicTrace, chapterId: string, page = 0): Promise<{
  readonly data: { readonly format: 'json'; readonly text: string; readonly page: number }
  readonly objectRef: Ref
  readonly nextCursor?: string
}> {
  const chapter = trace.chapters.find(entry => entry.id === chapterId)
  if (chapter === undefined || !Number.isSafeInteger(page) || page < 0 || page >= chapter.pages) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'Trace chapter/page is outside the sealed read policy')
  const bytes = (await service.readObject(chapter.object)).bytes
  const text = decoder.decode(bytes)
  return {
    data: { format: 'json', text: text.slice(page * PAGE_CHARS, (page + 1) * PAGE_CHARS), page },
    objectRef: chapter.object, ...(page + 1 < chapter.pages ? { nextCursor: String(page + 1) } : {}),
  }
}

/** This function never resolves a guessed hash or follows references embedded in model text. */
export async function readTraceAsset(service: CommandService, trace: PublicTrace, value: unknown, page = 0): Promise<{
  readonly data: { readonly format: 'utf8'; readonly text: string; readonly page: number }
  readonly objectRef: Ref
  readonly nextCursor?: string
}> {
  const ref = parseProtocolValue(refSchema, value)
  const authorized = trace.authorizedObjects.find(entry => sameRef(entry.ref, ref))
  if (authorized === undefined) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'Object is outside the sealed source read authorization')
  if (!Number.isSafeInteger(page) || page < 0) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'Asset page must be a nonnegative safe integer')
  const text = decoder.decode((await service.readObject(ref, authorized.domain)).bytes)
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS))
  if (page >= pages) throw new DecomposeError('INPUT_NOT_AUTHORIZED', 'Asset page is out of range')
  return {
    data: { format: 'utf8', text: text.slice(page * PAGE_CHARS, (page + 1) * PAGE_CHARS), page }, objectRef: ref,
    ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}),
  }
}

async function authorizeTree(service: CommandService, ref: Ref, authorize: (ref: Ref) => Promise<void>): Promise<void> {
  const bundle = await readTreeBundle(service, ref, Number.MAX_SAFE_INTEGER)
  await authorize(ref)
  for (const file of bundle.manifest.files) await authorize(file.object)
}

async function authorizeSessionReceipts(
  events: readonly SessionEvent[], authorize: (ref: Ref, domain?: CasDigestDomain) => Promise<void>,
): Promise<{ readonly previews: readonly Ref[]; readonly planning: readonly Ref[]; readonly feedback: readonly Ref[] }> {
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [String(event.data.callId), event.data.name]))
  const previews: Ref[] = [], planning: Ref[] = [], feedback: Ref[] = []
  for (const event of events) {
    if (event.type !== 'tool/result' || event.data.message.isError === true) continue
    const name = calls.get(String(event.data.message.toolCallId))
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    if (name === 'singularity_decompose') {
      const preview = parsePrepareEnvelope(text)
      if (preview !== undefined) {
        await authorize(preview.previewRef, 'preview')
        await authorize(preview.deliveryReceiptRef)
        previews.push(preview.previewRef, preview.deliveryReceiptRef)
      }
    }
    if (name !== 'singularity_plan' && name !== 'singularity_feedback') continue
    const value = parseJsonText(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Committed Task receipt is malformed')
    const ref = parseProtocolValue(refSchema, value[name === 'singularity_plan' ? 'planningSketchRef' : 'feedbackRef'])
    await authorize(ref)
    const refs = name === 'singularity_plan' ? planning : feedback
    refs.push(ref)
  }
  return { previews, planning, feedback }
}

async function readPersistedEvents(ctx: Context | undefined, cut: SessionCut): Promise<readonly SessionEvent[]> {
  const persistence: SessionPersistence | undefined = ctx?.get('sessionPersistence', false)
  if (persistence === undefined) throw new Error('Trace sealing requires the persisted DSH session reader')
  const handle = await persistence.open(cut.sessionId as SessionId, 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}

function publicSessionEvents(events: readonly SessionEvent[]): { readonly seq: number; readonly type: string; readonly data: unknown }[] {
  const result = []
  for (const event of events) {
    if (event.type === 'tool/call') result.push({ seq: Number(event.seq), type: event.type, data: event.data })
    if (event.type === 'user/message') result.push({ seq: Number(event.seq), type: event.type, data: publicMessage(event.data) })
    if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message' || event.type === 'developer/message') {
      result.push({ seq: Number(event.seq), type: event.type, data: publicMessage(event.data.message) })
    }
  }
  return result
}

function publicMessage(message: Message): unknown {
  return { id: message.id, role: message.role, content: message.content,
    ...(message.role === 'tool' ? { toolCallId: message.toolCallId, isError: message.isError === true } : {}) }
}

type MutableUsageRecord = { -readonly [Key in keyof UsageRecord]: UsageRecord[Key] }

function addUsage(totals: MutableUsageRecord, usage: UsageRecord): void {
  for (const part of [usage, ...(usage.summary === undefined ? [] : [usage.summary])]) {
    totals.inputTokens += part.inputTokens
    totals.outputTokens += part.outputTokens
    totals.steps += part.steps
    totals.unknownRequests += part.unknownRequests
    if (totals.cacheReadTokens === undefined || totals.cacheWriteTokens === undefined
      || part.cacheReadTokens === undefined || part.cacheWriteTokens === undefined) {
      delete totals.cacheReadTokens
      delete totals.cacheWriteTokens
    } else {
      totals.cacheReadTokens += part.cacheReadTokens
      totals.cacheWriteTokens += part.cacheWriteTokens
    }
  }
}

function refKey(ref: Ref): string { return `${ref.id}\u0000${ref.digest}` }
function putJson(service: CommandService, id: string, value: unknown): Promise<Ref> {
  return service.putObject(id, encoder.encode(canonicalize(value)))
}
async function readJson(reader: CasObjectReader, ref: Ref, domain: CasDigestDomain = 'object'): Promise<JsonValue> {
  return parseJsonText(decoder.decode((await reader.readObject(ref, domain)).bytes))
}
