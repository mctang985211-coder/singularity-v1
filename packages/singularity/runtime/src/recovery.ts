import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

import { compositionPayloadSchema, parseProtocolValue } from '@singularity/protocol'
import type {
  BudgetReservation,
  CompositionPayload,
  FactActor,
  RetryDecision,
} from '@singularity/protocol'

import { SingleRunError } from './errors.ts'
import {
  closeOpenedRunInvalid,
  compareCompositionPayload,
  completeSubmittedRun,
  compositionPayloadOf,
  continueOpenedRun,
  readRunJournalView,
  reconcileClosedRun,
} from './recovery-execution.ts'
import type { RunJournalView } from './recovery-execution.ts'
import { executeSingleRun, validateHostRequest } from './run.ts'
import { retryDecisionForRun } from './run-settlement.ts'
import type {
  ExecuteSingleRunRequest,
  ExecuteSingleRunResult,
  SingleRunAdmission,
} from './run.ts'
import { CommandService } from './service.ts'
import type { RunVerifier } from './verification.ts'
import type { WakeDeliveryOutcome } from './wake.ts'

/** Host request for a fresh attempt of the same Task. */
export interface RetrySingleRunRequest {
  readonly ctx: Context
  readonly journalRoot: string
  /** New workspace, distinct from every earlier attempt of this Task. */
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

  const store = await CommandService.open({ root: request.journalRoot, actor, clock })
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
    await assertFreshRetryWorkspace(
      request.ctx,
      facts.flatMap(fact => fact.type === 'run/opened' && fact.data.taskId === view.taskId
        ? [fact.data.sessionId] : []),
      request.workspace,
    )
    const reservation = retryReservation(view)
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
  // The preflight writer is closed before the shared create path opens
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
  })
}

/**
 * DSH SessionHeader.cwd records each earlier Agent's actual workspace; the
 * domain journal supplies its session identity. A fresh attempt checks every
 * historical Run of the Task, including missing cwd and canonical aliases.
 */
async function assertFreshRetryWorkspace(
  ctx: Context,
  previousSessionIds: readonly string[],
  workspace: string,
): Promise<void> {
  const persistence: unknown = ctx.get('sessionPersistence', false)
  if (!isSessionPersistenceReader(persistence)) {
    throw new SingleRunError(
      'INVALID_ARGUMENT',
      'retry cannot verify workspace freshness: DSH session persistence is unavailable',
    )
  }
  const nextPath = await canonicalWorkspacePath(workspace)
  for (const previousSessionId of previousSessionIds) {
    let previousCwd: string | undefined
    try {
      previousCwd = (await persistence.stat(previousSessionId))?.header.cwd
    } catch (error) {
      throw new SingleRunError(
        'INVALID_ARGUMENT',
        `retry cannot read previous Run session ${JSON.stringify(previousSessionId)}`,
        { cause: error },
      )
    }
    if (previousCwd === undefined || previousCwd.length === 0) {
      throw new SingleRunError(
        'INVALID_ARGUMENT',
        'retry cannot verify workspace freshness: previous Run session has no persisted cwd',
      )
    }
    if (!isAbsolute(previousCwd)) {
      throw new SingleRunError(
        'INVALID_ARGUMENT',
        'retry cannot verify workspace freshness: previous Run persisted cwd is not absolute',
      )
    }
    if (await canonicalWorkspacePath(previousCwd) === nextPath) {
      throw new SingleRunError(
        'INVALID_ARGUMENT',
        `retry workspace must differ from the previous Run workspace ${JSON.stringify(previousCwd)}`,
      )
    }
  }
}

interface SessionPersistenceReader {
  stat(sessionId: string): Promise<{
    readonly header: { readonly cwd?: string }
  } | undefined>
}

function isSessionPersistenceReader(value: unknown): value is SessionPersistenceReader {
  return typeof value === 'object' && value !== null
    && 'stat' in value && typeof value.stat === 'function'
}

/** Resolves symlinks through the nearest existing ancestor of a new path. */
async function canonicalWorkspacePath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      const existing = await realpath(current)
      return missing.length === 0 ? existing : join(existing, ...missing.reverse())
    } catch (error) {
      if (!isMissingPath(error)) {
        throw new SingleRunError(
          'INVALID_ARGUMENT',
          `cannot canonicalize workspace path ${JSON.stringify(path)}`,
          { cause: error },
        )
      }
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
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
    const view = await readRunJournalView(service, request.runId, request.transientInvalidReasons ?? [])
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
  }
}

function retryReservation(
  view: RunJournalView,
): BudgetReservation {
  let used = 0
  for (const runId of view.runIds) {
    const usage = view.state.runs.get(runId)?.closed?.usage
    if (usage === undefined) continue
    used += usage.inputTokens + usage.outputTokens
    const summary = usage.summary
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

function validateResumeRequest(
  request: ResumeSingleRunRequest,
  actor: FactActor,
  clock: () => number,
): void {
  validateHostRequest(request, actor, clock)
  try {
    parseProtocolValue(compositionPayloadSchema, request.composition)
  } catch (error) {
    throw new SingleRunError(
      'COMPOSITION_MISMATCH',
      'resume composition is not a strict CompositionPayload',
      { cause: error },
    )
  }
}
