/** Stable request/flow rejection shared by Run and retry modules. */
export type SingleRunErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CONTRACT_INVALID'
  | 'COMPOSITION_MISMATCH'
  | 'UNSUPPORTED_RESOURCES'
  | 'TOOL_UNAVAILABLE'
  | 'RUN_ALREADY_OPENED'
  | 'RUN_ALREADY_CLOSED'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_CLOSED'
  | 'RUN_NOT_SUBMITTED'
  | 'TASK_ALREADY_CLOSED'
  | 'TASK_CONTRACT_MISMATCH'
  | 'RETRY_NOT_ALLOWED'
  | 'SESSION_ALREADY_LIVE'
  | 'SESSION_MISMATCH'

export class SingleRunError extends Error {
  override readonly name = 'SingleRunError'
  readonly code: SingleRunErrorCode

  constructor(code: SingleRunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Invalid frozen resource or host composition; reject before further execution. */
export class MethodResourceError extends SingleRunError {
  readonly resource: 'method' | 'composition'

  constructor(
    resource: 'method' | 'composition',
    code: 'COMPOSITION_MISMATCH' | 'CONTRACT_INVALID' | 'UNSUPPORTED_RESOURCES',
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options)
    this.resource = resource
  }
}

/** Existing tool-facing rejection used by decompose prepare/commit. */
export type DecomposeErrorCode =
  | 'INVALID_ARGUMENT'
  | 'BINDING_FIXED'
  | 'LIMIT_EXCEEDED'
  | 'PREVIEW_REQUIRED'
  | 'PREVIEW_STALE'
  | 'NEXT_STEP_REQUIRED'
  | 'CHILD_BATCH_ACTIVE'
  | 'REQUIRED_FEEDBACK_REPLAN'
  | 'INPUT_NOT_AUTHORIZED'
  | 'IDEMPOTENCY_CONFLICT'

/** Internal decompose rejection; maps to an existing protocol tool code. */
export class DecomposeError extends Error {
  override readonly name = 'DecomposeError'
  readonly code: DecomposeErrorCode

  constructor(code: DecomposeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** Finish native cleanup while retaining the original failure and any cleanup failures. */
export function throwCollectedErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) {
    const error = errors[0]
    throw error instanceof Error ? error : new Error(String(error), { cause: error })
  }
  if (errors.length > 1) throw new AggregateError(errors, 'Execution and lifecycle cleanup failed')
}
