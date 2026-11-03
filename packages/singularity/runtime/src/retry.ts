import { mkdir } from 'node:fs/promises'
import { dirname,resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

import type {
BudgetReservation,
CompositionPayload,
FactActor,
RetryDecision,
} from '@singularity/protocol'
import { compositionPayloadSchema,parseProtocolValue } from '@singularity/protocol'

import type { ContractSummaryService } from './contract-summary.ts'
import { SingleRunError } from './errors.ts'
import type { RunJournalView } from './retry-view.ts'
import {
compareCompositionPayload,
compositionPayloadOf,
readRunJournalView,
} from './retry-view.ts'
import { closedSubtreeUsage,retryDecisionForRun } from './run-settlement.ts'
import type {
RunAttemptResult,
SingleRunAdmission,
} from './run.ts'
import { executeSingleRun,validateHostRequest } from './run.ts'
import { CommandService } from './service.ts'
import type { RunVerifier } from './verification.ts'

/** Host request for a fresh attempt of the same Task. */
export interface RetrySingleRunRequest {
  readonly ctx: Context
  readonly journalRoot: string
  /** Unused workspace path; the runtime creates it exclusively for this attempt. */
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
  readonly summaries?: ContractSummaryService
  readonly checkReportedBudget?: (reported?: { readonly tokens: number }) => boolean
  readonly canOpenRun?: () => boolean
  readonly signal?: AbortSignal
  readonly onBudgetExhausted?: () => void
}

/** Fresh attempt result plus the preflight policy decision. */
export type RetrySingleRunResult = RunAttemptResult & {
  readonly previousRunId: string
  readonly attempt: number
  readonly retryPolicy: RetryDecision
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
  sharedWriter?: CommandService,
): Promise<RetrySingleRunResult> {
  request = { ...request, transientInvalidReasons: sharedWriter?.retryPolicy(request.transientInvalidReasons) ?? request.transientInvalidReasons ?? [] }
  const actor = request.actor ?? defaultActor
  const clock = request.clock ?? Date.now
  validateRetryRequest(request, actor, clock)

  const store = sharedWriter ?? await CommandService.open({ root: request.journalRoot, actor, clock, transientInvalidReasons: request.transientInvalidReasons })
  let view: RunJournalView
  let admission: SingleRunAdmission
  let composition: CompositionPayload
  let retryPolicy: RetryDecision
  try {
    view = await readRunJournalView(store, request.previousRunId, request.transientInvalidReasons ?? [])
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
    retryPolicy = retryDecisionForRun(
      view.state,
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
    const reservation = retryReservation(view)
    await mkdir(dirname(resolve(request.workspace)), { recursive: true })
    await mkdir(request.workspace)
    admission = {
      contract: view.contract,
      attempt: view.runIds.length + 1,
      budgetReservation: reservation,
      workspaceKey: request.runId,
    }
    composition = compositionPayloadOf(view.composition)
  } finally {
    if (sharedWriter === undefined) await store.close()
  }

  const result = await executeRetryAttempt(request, actor, clock, admission, composition, sharedWriter)
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
  sharedWriter?: CommandService,
): Promise<RunAttemptResult> {
  // A domain-owned writer stays shared across retry preflight and execution.
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
    ...(request.summaries === undefined ? {} : { summaries: request.summaries }),
    ...(request.checkReportedBudget === undefined ? {} : { checkReportedBudget: request.checkReportedBudget }),
    ...(request.canOpenRun === undefined ? {} : { canOpenRun: request.canOpenRun }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onBudgetExhausted === undefined ? {} : { onBudgetExhausted: request.onBudgetExhausted }),
  }, sharedWriter)
}

function retryReservation(
  view: RunJournalView,
): BudgetReservation {
  const tokens = view.contract.limits.maxTokens - closedSubtreeUsage(view.state, view.taskId).tokens
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new SingleRunError(
      'RETRY_NOT_ALLOWED',
      'the Task subtree token budget is exhausted; no fresh attempt can be reserved',
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
  validateHostRequest(request, actor, clock)
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
}
