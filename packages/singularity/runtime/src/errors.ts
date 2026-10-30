/** Stable request/flow rejection shared by Run and recovery modules. */
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

/** Explicit frozen-resource failure; recovery closes these as invalid. */
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
