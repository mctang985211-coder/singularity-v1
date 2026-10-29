/**
 * Stable error codes shared by strict JSON text parsing and JCS canonicalization.
 * Consumers may branch on these values; messages are diagnostics only.
 */
export type CanonicalJsonErrorCode =
  | 'INVALID_JSON_TEXT'
  | 'INVALID_JSON_SYNTAX'
  | 'INVALID_JSON_ESCAPE'
  | 'INVALID_NUMBER'
  | 'UNSAFE_INTEGER'
  | 'NON_FINITE_NUMBER'
  | 'CONTROL_CHARACTER'
  | 'UNTERMINATED_STRING'
  | 'LONE_SURROGATE'
  | 'DUPLICATE_KEY'
  | 'TRAILING_DATA'
  | 'UNEXPECTED_BOM'
  | 'UNSUPPORTED_VALUE'
  | 'UNSUPPORTED_OBJECT'
  | 'CYCLIC_REFERENCE'
  | 'ACCESSOR_PROPERTY'
  | 'SYMBOL_KEY'
  | 'NON_ENUMERABLE_PROPERTY'
  | 'SPARSE_ARRAY'
  | 'ARRAY_EXTRA_PROPERTY'

/** Diagnostics that make a canonical JSON failure actionable without parsing messages. */
export interface CanonicalJsonErrorDetail {
  /** Zero-based UTF-16 offset into the rejected JSON text. */
  readonly offset?: number
  /** One-based line in the rejected JSON text. */
  readonly line?: number
  /** One-based UTF-16 column in the rejected JSON text. */
  readonly column?: number
  /** Object key involved in the failure. */
  readonly key?: string
  /** Invalid number literal, when available. */
  readonly literal?: string
  /** JavaScript type or object kind that is not representable as JSON. */
  readonly valueType?: string
  /** Constructor name for unsupported non-plain objects. */
  readonly constructorName?: string
}

/** A strict JSON or JCS failure with a stable code and JSONPath-like location. */
export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError'
  readonly code: CanonicalJsonErrorCode
  /** JSONPath-like location, using `$`, `["key"]`, and `[index]` segments. */
  readonly path: string
  readonly detail: CanonicalJsonErrorDetail

  constructor(
    code: CanonicalJsonErrorCode,
    path: string,
    message: string,
    detail: CanonicalJsonErrorDetail = {},
  ) {
    super(message)
    this.code = code
    this.path = path
    this.detail = Object.freeze({ ...detail })
  }
}
