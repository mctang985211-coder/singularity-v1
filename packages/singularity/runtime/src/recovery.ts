import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

import {
  compositionPayloadSchema,
  parseProtocolValue,
  refSchema,
} from '@singularity/protocol'
import type {
  BudgetReservation,
  CompositionPayload,
  Fact,
  FactActor,
  RetryDecision,
} from '@singularity/protocol'

import {
  SingleRunError,
  closeOpenedRunInvalid,
  compareCompositionPayload,
  completeSubmittedRun,
  compositionPayloadOf,
  continueOpenedRun,
  executeSingleRun,
  readRunJournalView,
  reconcileClosedRun,
  retryDecisionForRun,
} from './run.ts'
import type {
  ExecuteSingleRunRequest,
  ExecuteSingleRunResult,
  RunJournalView,
  SingleRunAdmission,
} from './run.ts'
import { CommandService } from './service.ts'
import { DomainStore } from './store.ts'
import type { RunVerifier } from './verification.ts'
import type { WakeDeliveryOutcome } from './wake.ts'

/** Host request for a fresh attempt of the same Task. */
export interface RetrySingleRunRequest {
  readonly ctx: Context
  readonly journalRoot: string
  /** New workspace for the fresh attempt; must not be the previous workspace. */
  readonly workspace: string
  /** Latest closed Run of the Task. */
  readonly previousRunId: string
  readonly runId: string
  readonly sessionId: string
  readonly agentOptions: AgentOptions
  readonly maxOutputBytes: number
  readonly verifier: RunVerifier
  readonly transientInvalidReasons?: readonly string[]
  /** Optional host-assembled Composition; when present it must equal the frozen one. */
  readonly composition?: CompositionPayload
  readonly actor?: FactActor
  readonly clock?: () => number
  readonly templateBrief?: string
  readonly environmentMode?: string
}

/** Fresh attempt result plus the preflight policy decision. */
export interface RetrySingleRunResult extends ExecuteSingleRunResult {
  readonly previousRunId: string
  readonly attempt: number
  readonly retryPolicy: RetryDecision
}

/** Host request to resume or recover one known Run. */
export interface ResumeSingleRunRequest {
  readonly ctx: Context
  readonly journalRoot: string
  readonly workspace: string
  readonly runId: string
  /** Composition actually assembled by the host; compared in full before any Agent. */
  readonly composition: CompositionPayload
  readonly agentOptions: AgentOptions
  readonly maxOutputBytes: number
  readonly verifier: RunVerifier
  readonly transientInvalidReasons?: readonly string[]
  readonly actor?: FactActor
  readonly clock?: () => number
  readonly templateBrief?: string
  readonly environmentMode?: string
}

/** Resume result; exactly one recovery path ran. */
export interface ResumeSingleRunResult extends ExecuteSingleRunResult {
  readonly compositionMatched: boolean
  readonly sessionAction: 'none' | 'created' | 'resumed'
  readonly wakeOutcome?: WakeDeliveryOutcome
  readonly recoveredSubmission: boolean
}

const defaultActor: FactActor = { kind: 'runtime', id: 'singularity-runtime' }

/**
 * Creates a fresh attempt for one Task by reading the previous contract,
 * Method, Composition, usage, and retry policy from the journal. It never
 * accepts a second contract authority, never reuses a receipt/manifest, and
 * requires a new Run id, session id, and workspace.
 */
export async function retrySingleRun(
  request: RetrySingleRunRequest,
): Promise<RetrySingleRunResult> {
  const actor = request.actor ?? defaultActor
  const clock = request.clock ?? Date.now
  validateRetryRequest(request, actor, clock)

  const store = await DomainStore.open({ root: request.journalRoot })
  let view: RunJournalView
  let admission: SingleRunAdmission
  let composition: CompositionPayload
  let retryPolicy: RetryDecision
  try {
    view = await readRunJournalView(store, request.previousRunId)
    const facts = store.facts()
    if (view.runClosed === undefined) {
      throw new SingleRunError(
        'RUN_NOT_CLOSED',
        `Previous Run ${JSON.stringify(request.previousRunId)} has no run/closed fact`,
      )
    }
    if (view.taskClosed !== undefined) {
      throw new SingleRunError(
        'TASK_ALREADY_CLOSED',
        `Task ${JSON.stringify(view.taskId)} is already closed`,
      )
    }
    if (view.runIds.at(-1) !== request.previousRunId) {
      throw new SingleRunError(
        'INVALID_ARGUMENT',
        'previousRunId must be the latest Run of the Task',
      )
    }
    for (const runId of view.runIds) {
      if (!facts.some(fact => fact.type === 'run/closed' && fact.data.runId === runId)) {
        throw new SingleRunError(
          'RUN_NOT_CLOSED',
          `Run ${JSON.stringify(runId)} is still open; retry requires one closed previous Run`,
        )
      }
    }
    retryPolicy = retryDecisionForRun(
      facts,
      view.contract,
      view.runClosed,
      request.transientInvalidReasons ?? [],
      clock(),
    )
    if (!retryPolicy.allowed) {
      throw new SingleRunError(
        'RETRY_NOT_ALLOWED',
        `fixed retry policy refused a fresh attempt: ${retryPolicy.reason}`,
      )
    }
    if (request.runId === request.previousRunId || view.runIds.includes(request.runId)) {
      throw new SingleRunError('INVALID_ARGUMENT', 'runId must be fresh for this Task')
    }
    if (request.sessionId === view.runOpened.data.sessionId
      || facts.some(fact => fact.type === 'run/opened' && fact.data.sessionId === request.sessionId)) {
      throw new SingleRunError('INVALID_ARGUMENT', 'sessionId must be fresh for this Task')
    }
    if (request.composition !== undefined
      && !compareCompositionPayload(view.composition, request.composition)) {
      throw new SingleRunError(
        'COMPOSITION_MISMATCH',
        'retry cannot change the frozen Composition, contract, Method, or seed',
      )
    }
    const reservation = retryReservation(view, facts)
    admission = {
      contract: view.contract,
      attempt: view.runIds.length + 1,
      budgetReservation: reservation,
      workspaceKey: request.runId,
    }
    composition = compositionPayloadOf(view.composition)
  } finally {
    await store.close()
  }

  const result = await executeRetryAttempt(request, actor, clock, admission, composition)
  return {
    ...result,
    previousRunId: request.previousRunId,
    attempt: admission.attempt,
    retryPolicy,
  }
}

async function executeRetryAttempt(
  request: RetrySingleRunRequest,
  actor: FactActor,
  clock: () => number,
  admission: SingleRunAdmission,
  composition: CompositionPayload,
): Promise<ExecuteSingleRunResult> {
  // The read-only preflight store is closed before the shared create path opens
  // the one CommandService writer for the fresh attempt.
  return executeSingleRun({
    ctx: request.ctx,
    journalRoot: request.journalRoot,
    workspace: request.workspace,
    sessionId: request.sessionId,
    runId: request.runId,
    admission,
    composition,
    agentOptions: request.agentOptions,
    maxOutputBytes: request.maxOutputBytes,
    verifier: request.verifier,
    transientInvalidReasons: request.transientInvalidReasons ?? [],
    actor,
    clock,
    ...(request.templateBrief === undefined ? {} : { templateBrief: request.templateBrief }),
    ...(request.environmentMode === undefined ? {} : { environmentMode: request.environmentMode }),
  })
}

/**
 * Resumes or recovers one Run. The frozen Composition is compared in full
 * before any Agent or verifier call. A mismatch writes an invalid
 * ExecutionRecord/run-close with zero model requests; a match reuses the
 * original session and fixed verification `operationId`.
 */
export async function resumeSingleRun(
  request: ResumeSingleRunRequest,
): Promise<ResumeSingleRunResult> {
  const actor = request.actor ?? defaultActor
  const clock = request.clock ?? Date.now
  validateResumeRequest(request, actor, clock)

  const service = await CommandService.open({
    root: request.journalRoot,
    actor,
    clock,
  })
  try {
    const view = await readRunJournalView(service, request.runId)
    const internal = toExecuteRequest(request, view, actor, clock)
    const compositionMatched = compareCompositionPayload(view.composition, request.composition)

    if (view.runClosed !== undefined) {
      const result = await reconcileClosedRun(internal, service)
      return {
        ...result,
        compositionMatched,
        sessionAction: 'none',
        recoveredSubmission: false,
      }
    }
    if (!compositionMatched) {
      const result = await closeOpenedRunInvalid(internal, service, 'composition-mismatch')
      return {
        ...result,
        compositionMatched: false,
        sessionAction: 'none',
        recoveredSubmission: false,
      }
    }
    if (view.runSubmitted !== undefined) {
      const result = await completeSubmittedRun(internal, service)
      return {
        ...result,
        compositionMatched: true,
        sessionAction: 'none',
        recoveredSubmission: true,
      }
    }
    const result = await continueOpenedRun(internal, service, 'resume')
    return {
      ...result,
      compositionMatched: true,
      recoveredSubmission: false,
    }
  } finally {
    await service.close()
  }
}

function toExecuteRequest(
  request: ResumeSingleRunRequest,
  view: RunJournalView,
  actor: FactActor,
  clock: () => number,
): ExecuteSingleRunRequest {
  return {
    ctx: request.ctx,
    journalRoot: request.journalRoot,
    workspace: request.workspace,
    sessionId: view.runOpened.data.sessionId,
    runId: request.runId,
    admission: {
      contract: view.contract,
      attempt: view.runOpened.data.attempt,
      budgetReservation: view.runOpened.data.budgetReservation,
    },
    composition: request.composition,
    agentOptions: request.agentOptions,
    maxOutputBytes: request.maxOutputBytes,
    verifier: request.verifier,
    transientInvalidReasons: request.transientInvalidReasons ?? [],
    actor,
    clock,
    ...(request.templateBrief === undefined ? {} : { templateBrief: request.templateBrief }),
    ...(request.environmentMode === undefined ? {} : { environmentMode: request.environmentMode }),
  }
}

function retryReservation(
  view: RunJournalView,
  facts: readonly Fact[],
): BudgetReservation {
  let used = 0
  for (const fact of facts) {
    if (fact.type !== 'run/closed') continue
    if (!view.runIds.includes(fact.data.runId)) continue
    used += fact.data.usage.inputTokens + fact.data.usage.outputTokens
    const summary = fact.data.usage.summary
    if (summary !== undefined) used += summary.inputTokens + summary.outputTokens
  }
  const tokens = view.contract.limits.maxTokens - used
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new SingleRunError(
      'RETRY_NOT_ALLOWED',
      'the root token budget is exhausted; no fresh attempt can be reserved',
    )
  }
  return {
    tokens,
    steps: view.contract.limits.maxStepsPerRun,
    deadlineAt: view.contract.limits.deadlineAt,
  }
}

function validateRetryRequest(
  request: RetrySingleRunRequest,
  actor: FactActor,
  clock: () => number,
): void {
  validateCommon(
    request.journalRoot,
    request.workspace,
    request.runId,
    request.sessionId,
    request.maxOutputBytes,
    request.agentOptions,
    request.verifier,
    actor,
    clock,
  )
  if (typeof request.previousRunId !== 'string' || request.previousRunId.length === 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'previousRunId must be a non-empty string')
  }
  if (request.previousRunId === request.runId) {
    throw new SingleRunError('INVALID_ARGUMENT', 'retry requires a fresh runId')
  }
  if (request.composition !== undefined) {
    try {
      parseProtocolValue(compositionPayloadSchema, request.composition)
    } catch (error) {
      throw new SingleRunError(
        'COMPOSITION_MISMATCH',
        'retry composition is not a strict CompositionPayload',
        { cause: error },
      )
    }
  }
  for (const reason of request.transientInvalidReasons ?? []) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new SingleRunError('INVALID_ARGUMENT', 'transientInvalidReasons must be non-empty strings')
    }
  }
}

function validateResumeRequest(
  request: ResumeSingleRunRequest,
  actor: FactActor,
  clock: () => number,
): void {
  validateCommon(
    request.journalRoot,
    request.workspace,
    request.runId,
    undefined,
    request.maxOutputBytes,
    request.agentOptions,
    request.verifier,
    actor,
    clock,
  )
  try {
    parseProtocolValue(compositionPayloadSchema, request.composition)
  } catch (error) {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      'resume composition is not a strict CompositionPayload',
      { cause: error },
    )
  }
  for (const reason of request.transientInvalidReasons ?? []) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new SingleRunError('INVALID_ARGUMENT', 'transientInvalidReasons must be non-empty strings')
    }
  }
}

function validateCommon(
  journalRoot: string,
  workspace: string,
  runId: string,
  sessionId: string | undefined,
  maxOutputBytes: number,
  agentOptions: AgentOptions,
  verifier: RunVerifier,
  actor: FactActor,
  clock: () => number,
): void {
  const required: readonly (readonly [string, string])[] = [
    ['journalRoot', journalRoot],
    ['workspace', workspace],
    ['runId', runId],
    ...(sessionId === undefined ? [] : [['sessionId', sessionId] as const]),
  ]
  for (const [label, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new SingleRunError('INVALID_ARGUMENT', `${label} must be a non-empty string`)
    }
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'maxOutputBytes must be a positive safe integer')
  }
  if (typeof agentOptions.provider !== 'string' || agentOptions.provider.length === 0
    || typeof agentOptions.model !== 'string' || agentOptions.model.length === 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'agentOptions.provider and agentOptions.model are required')
  }
  try {
    parseProtocolValue(refSchema, verifier.provider)
  } catch (error) {
    throw new SingleRunError('INVALID_ARGUMENT', 'verifier.provider is not a valid ref', { cause: error })
  }
  if (actor.id.length === 0) {
    throw new SingleRunError('INVALID_ARGUMENT', 'actor.id must be non-empty')
  }
  if (typeof clock() !== 'number') {
    throw new SingleRunError('INVALID_ARGUMENT', 'clock must return a number')
  }
}
