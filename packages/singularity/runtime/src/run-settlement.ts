import type {
CommandScope,
Evidence,
ExecutionRecord,
Fact,
FactActor,
FactPayloadMap,
FactType,
JsonValue,
NormalizedCommand,
PublicReceipt,
Ref,
RetryDecision,
RunClosedPayload,
SubmissionManifest,
TaskContract,
TaskRunState,
UsageRecord,
} from '@singularity/protocol'
import { canonicalize,decideTaskRetryPolicy } from '@singularity/protocol'

import type { SessionSnapshot } from './agent.ts'
import { SingleRunError } from './errors.ts'
import type { ExecuteSingleRunRequest,ExecuteSingleRunResult,RuntimeContext } from './run.ts'
import type { CommandService } from './service.ts'
import type { CasDigestDomain } from './store.ts'
import { createSchedulerFeedback } from './task-feedback.ts'
import type { RunToolSnapshot } from './tools.ts'
import {
AGENT_ERROR_REASON,
NO_SUBMISSION_REASON,
buildEvidence,
buildExecutionRecord,
verifyRunSubmission,
} from './verification.ts'

const textEncoder = new TextEncoder()

export interface Settlement {
  readonly classification: RunClosedPayload['classification']
  readonly reason: string
  readonly runFact: Fact
  readonly manifest?: SubmissionManifest
  readonly manifestRef?: Ref
  readonly receipt?: PublicReceipt
  readonly receiptRef?: Ref
  readonly evidence?: Evidence
  readonly evidenceRef?: Ref
  readonly executionRecord?: ExecutionRecord
  readonly executionRecordRef?: Ref
}

export async function settleSubmitted(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  tools: RunToolSnapshot,
): Promise<Settlement | undefined> {
  const frozen = tools.submission
  if (frozen === undefined) throw new SingleRunError('INVALID_ARGUMENT', 'submission snapshot is missing')
  let verification
  try {
    verification = await verifyRunSubmission({
      shell: request.ctx.shell,
      contract: runtime.contract,
      runId: request.runId,
      inputs: frozen.inputRefs,
      outputs: frozen.outputRefs,
      verifier: runtime.verifier,
      reader: service,
      writer: service,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, runtime.clock)
  } catch (error) {
    if (request.signal?.aborted === true && error === request.signal.reason) return undefined
    throw error
  }
  if (request.signal?.aborted === true) return undefined

  if (verification.verdict !== 'invalid') {
    const evidence = buildEvidence({
      contract: runtime.contract,
      runId: request.runId,
      composition: runtime.compositionRef,
      outputs: frozen.outputRefs,
      inputs: frozen.inputRefs,
      receipt: verification.receipt,
      receiptRef: verification.receiptRef,
      usage: snapshot.usage,
      sessionCut: snapshot.sessionCut,
      environmentMode: 'workspace',
    })
    const evidenceRef = await putSealed(service, `${request.runId}:evidence`, evidence, 'evidence')
    const runFact = await commitRunClosed(runtime, service, {
      runId: request.runId,
      classification: verification.verdict,
      reason: verification.reason,
      evidenceRef,
      usage: snapshot.usage,
      planningSketchRef: tools.planningSketchRef,
      feedbackRefs: tools.feedbackRefs,
    })
    return {
      classification: verification.verdict,
      reason: verification.reason,
      runFact,
      manifest: frozen.manifest,
      manifestRef: frozen.manifestRef,
      receipt: verification.receipt,
      receiptRef: verification.receiptRef,
      evidence,
      evidenceRef,
    }
  }

  const settlement = await settleRecord(
    runtime, request, service, snapshot, 'invalid', verification.code, verification.reason, tools,
  )
  return { ...settlement, manifest: frozen.manifest, manifestRef: frozen.manifestRef }
}

export async function settleExecutionRecord(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  tools: RunToolSnapshot,
  agentErrorCode: string | undefined,
  agentErrorDetail: string | undefined,
): Promise<Settlement> {
  let classification: 'failed' | 'invalid'
  let reason: string
  let recordReason: string
  if (agentErrorCode !== undefined || snapshot.failure !== undefined) {
    classification = 'invalid'
    reason = agentErrorCode ?? AGENT_ERROR_REASON
    const detail = agentErrorDetail ?? snapshot.failure
    recordReason = detail === undefined ? reason : `${reason}: ${detail}`
  } else if (tools.stopped !== undefined) {
    classification = 'failed'
    reason = `stop:${tools.stopped.reason}: ${tools.stopped.message}`
    recordReason = reason
  } else {
    classification = 'failed'
    reason = NO_SUBMISSION_REASON
    recordReason = NO_SUBMISSION_REASON
  }
  return settleRecord(runtime, request, service, snapshot, classification, reason, recordReason, tools)
}

async function settleRecord(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  snapshot: SessionSnapshot,
  classification: 'failed' | 'invalid',
  reason: string,
  recordReason: string,
  tools: RunToolSnapshot,
): Promise<Settlement> {
  const executionRecord = buildExecutionRecord({
    contract: runtime.contract,
    runId: request.runId,
    composition: runtime.compositionRef,
    usage: snapshot.usage,
    sessionCut: snapshot.sessionCut,
    reason: recordReason,
    ...(tools.submission === undefined ? {} : { outputs: tools.submission.outputRefs }),
  })
  const executionRecordRef = await putSealed(
    service,
    `${request.runId}:execution-record`,
    executionRecord,
    'object',
  )
  const runFact = await commitRunClosed(runtime, service, {
    runId: request.runId,
    classification,
    reason,
    executionRecordRef,
    usage: snapshot.usage,
    planningSketchRef: tools.planningSketchRef,
    feedbackRefs: tools.feedbackRefs,
  })
  return {
    classification,
    reason,
    runFact,
    executionRecord,
    executionRecordRef,
  }
}

interface CommitClosedEvidence {
  readonly runId: string
  readonly classification: 'verified' | 'failed'
  readonly reason: string
  readonly evidenceRef: Ref
  readonly usage: UsageRecord
  readonly planningSketchRef?: Ref
  readonly feedbackRefs?: readonly Ref[]
}

interface CommitClosedRecord {
  readonly runId: string
  readonly classification: 'failed' | 'invalid' | 'cancelled'
  readonly reason: string
  readonly executionRecordRef: Ref
  readonly usage: UsageRecord
  readonly planningSketchRef?: Ref
  readonly feedbackRefs?: readonly Ref[]
}

async function commitRunClosed(
  runtime: RuntimeContext,
  service: CommandService,
  closure: CommitClosedEvidence | CommitClosedRecord,
): Promise<Fact> {
  const feedbackRefs = [...(closure.feedbackRefs ?? [])]
  if (runtime.contract.origin.kind === 'child' && closure.classification !== 'verified') {
    const state = await service.taskRunState(runtime.transientInvalidReasons)
    const task = state.tasks.get(runtime.contract.taskId)
    const runs = new Map(state.runs)
    const run = runs.get(closure.runId)
    if (run !== undefined) runs.set(closure.runId, {
      ...run,
      phase: 'closed',
      closed: { ...closure, source: 'run/closed', factDigest: runtime.contract.digest },
    })
    const retry = decideTaskRetryPolicy({ ...state, runs }, runtime.contract.taskId,
      closure.runId, runtime.transientInvalidReasons, runtime.clock())
    if (closure.reason === NO_SUBMISSION_REASON || closure.classification === 'invalid'
      || (task?.join === 'required' && !retry.allowed)) {
      feedbackRefs.push(await createSchedulerFeedback({
        contract: runtime.contract,
        runId: closure.runId,
        reason: closure.reason,
        resultRef: 'evidenceRef' in closure ? closure.evidenceRef : closure.executionRecordRef,
        createdAt: runtime.clock(),
        writer: service,
      }))
    }
  }
  const base = {
    runId: closure.runId,
    reason: closure.reason,
    usage: closure.usage,
    ...(closure.planningSketchRef === undefined
      ? {}
      : { planningSketchRef: closure.planningSketchRef }),
    feedbackRefs,
  }
  const payload: RunClosedPayload = 'evidenceRef' in closure
    ? { ...base, classification: closure.classification, evidenceRef: closure.evidenceRef }
    : { ...base, classification: closure.classification, executionRecordRef: closure.executionRecordRef }
  return commitFact(
    service,
    runtime.actor,
    `run:${closure.runId}:closed`,
    'run.closed',
    { runId: closure.runId, taskId: runtime.contract.taskId },
    {
      runId: closure.runId,
      classification: closure.classification,
    } as unknown as JsonValue,
    'run/closed',
    payload,
    runtime.transientInvalidReasons,
  )
}

export async function commitTaskClosed(
  runtime: RuntimeContext,
  service: CommandService,
  settlement: Settlement,
  runId: string,
  outcome: 'verified' | 'failed' | 'invalid' | 'cancelled',
): Promise<Fact> {
  const evidenceRefs = settlement.evidenceRef === undefined ? [] : [settlement.evidenceRef]
  return commitFact(
    service,
    runtime.actor,
    `task:${runtime.contract.taskId}:closed`,
    'task.closed',
    { taskId: runtime.contract.taskId },
    { taskId: runtime.contract.taskId, outcome },
    'task/closed',
    {
      taskId: runtime.contract.taskId,
      outcome,
      reason: settlement.reason,
      decisiveRunId: runId,
      evidenceRefs,
    },
    runtime.transientInvalidReasons,
  )
}

export async function finalizeSettlement(
  runtime: RuntimeContext,
  request: ExecuteSingleRunRequest,
  service: CommandService,
  settlement: Settlement,
): Promise<{ readonly taskFact?: Fact; readonly retry: RetryDecision }> {
  const retry = retryDecisionForRun(
    await service.taskRunState(runtime.transientInvalidReasons),
    runtime.contract,
    settlement.runFact,
    runtime.transientInvalidReasons,
    runtime.clock(),
  )
  let taskFact: Fact | undefined
  if (settlement.classification === 'verified') {
    taskFact = await commitTaskClosed(runtime, service, settlement, request.runId, 'verified')
  } else if (!retry.allowed
    && (settlement.classification === 'failed' || settlement.classification === 'invalid')) {
    taskFact = await commitTaskClosed(
      runtime,
      service,
      settlement,
      request.runId,
      settlement.classification,
    )
  }
  return {
    ...(taskFact === undefined ? {} : { taskFact }),
    retry,
  }
}

export function buildExecutionResult(
  request: ExecuteSingleRunRequest,
  runtime: RuntimeContext,
  settlement: Settlement,
  taskFact: Fact | undefined,
  retry: RetryDecision,
  snapshot: SessionSnapshot,
  facts: readonly Fact[],
): ExecuteSingleRunResult {
  return {
    kind: 'settled',
    taskId: runtime.contract.taskId,
    runId: request.runId,
    sessionId: request.sessionId,
    classification: settlement.classification,
    ...(settlement.manifest === undefined ? {} : { manifest: settlement.manifest }),
    ...(settlement.manifestRef === undefined ? {} : { manifestRef: settlement.manifestRef }),
    ...(settlement.receipt === undefined ? {} : { receipt: settlement.receipt }),
    ...(settlement.receiptRef === undefined ? {} : { receiptRef: settlement.receiptRef }),
    ...(settlement.evidence === undefined ? {} : { evidence: settlement.evidence }),
    ...(settlement.evidenceRef === undefined ? {} : { evidenceRef: settlement.evidenceRef }),
    ...(settlement.executionRecord === undefined ? {} : { executionRecord: settlement.executionRecord }),
    ...(settlement.executionRecordRef === undefined
      ? {}
      : { executionRecordRef: settlement.executionRecordRef }),
    runFact: settlement.runFact,
    ...(taskFact === undefined ? {} : { taskFact }),
    usage: snapshot.usage,
    sessionCut: snapshot.sessionCut,
    retry,
    facts,
  }
}

/**
 * Applies the fixed retry policy from docs/framework.md §9.2 to one closed Run.
 * Runtime retry and the reducer share the same pure decision.
 */
export function retryDecisionForRun(
  state: TaskRunState,
  contract: TaskContract,
  runFact: Fact,
  transientInvalidReasons: readonly string[],
  now: number,
): RetryDecision {
  if (runFact.type !== 'run/closed') return { allowed: false, reason: 'Run closure fact missing' }
  return decideTaskRetryPolicy(state, contract.taskId, runFact.data.runId, transientInvalidReasons, now)
}

/** The same frozen Task subtree contributes to retry eligibility and reservation. */
export function closedSubtreeUsage(state: TaskRunState, taskId: string): { readonly tokens: number; readonly unknown: boolean } {
  const records: UsageRecord[] = []
  const pending = [taskId]
  for (const id of pending) {
    const task = state.tasks.get(id)
    if (task === undefined) continue
    for (const runId of task.runIds) {
      const usage = state.runs.get(runId)?.closed?.usage
      if (usage !== undefined) records.push(usage)
    }
    pending.push(...task.childIds)
  }
  return usageCost(records)
}

export function usageCost(records: readonly UsageRecord[]): { readonly tokens: number; readonly unknown: boolean } {
  let tokens = 0
  let unknown = false
  for (const usage of records) {
    tokens += usage.inputTokens + usage.outputTokens + (usage.summary?.inputTokens ?? 0) + (usage.summary?.outputTokens ?? 0)
    unknown ||= usage.unknownRequests > 0 || (usage.summary?.unknownRequests ?? 0) > 0
  }
  return { tokens, unknown }
}

export async function putSealed(
  service: CommandService,
  id: string,
  value: JsonValue,
  domain: CasDigestDomain,
): Promise<Ref> {
  const ref = await service.putObject(id, textEncoder.encode(canonicalize(value)), domain)
  const digest = recordField(value, 'digest')
  if (typeof digest === 'string' && digest !== ref.digest) {
    throw new SingleRunError(
      'INVALID_ARGUMENT',
      `CAS ${domain} digest for ${JSON.stringify(id)} does not match its seal`,
    )
  }
  return ref
}

export async function commitFact<Type extends FactType>(
  service: CommandService,
  actor: FactActor,
  commandId: string,
  tool: string,
  scope: CommandScope,
  input: JsonValue,
  type: Type,
  data: FactPayloadMap[Type],
  transientInvalidReasons: readonly string[],
  canOpenRun?: () => boolean,
): Promise<Fact> {
  const command: NormalizedCommand = {
    v: 1,
    commandId,
    tool,
    toolVersion: 1,
    actor,
    scope,
    input,
  }
  return service.commit({ command, type, data }, transientInvalidReasons, canOpenRun)
}

function recordField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}
