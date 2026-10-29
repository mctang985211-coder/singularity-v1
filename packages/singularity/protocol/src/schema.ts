import { z } from 'zod'

import { canonicalize, parseJsonText } from './json.ts'
import type { JsonObject, JsonValue } from './json.ts'

export type ProtocolSchemaErrorCode =
  | 'SCHEMA_IO_MISMATCH'
  | 'TRANSFORM_OUTPUT'
  | 'UNREPRESENTABLE_JSON_SCHEMA'

export class ProtocolSchemaError extends Error {
  readonly code: ProtocolSchemaErrorCode

  constructor(code: ProtocolSchemaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProtocolSchemaError'
    this.code = code
  }
}

/** Creates a strict object schema; protocol payloads reject unknown fields. */
export function closedObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape)
}

/**
 * Parses a protocol value through canonical JSON and rejects schemas that
 * transform or default the input value.
 */
export function parseProtocolValue<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const canonicalInput = canonicalize(value)
  const parsed = schema.parse(parseJsonText(canonicalInput))
  const canonicalOutput = canonicalizeOutput(parsed)
  if (canonicalOutput !== canonicalInput) {
    throw new ProtocolSchemaError(
      'TRANSFORM_OUTPUT',
      'Protocol schemas must not transform or default values',
    )
  }
  return parsed
}

/** Converts a protocol schema to JSON Schema only when input and output agree. */
export function protocolJsonSchema(schema: z.ZodType): JsonObject {
  let input: JsonObject
  let output: JsonObject
  try {
    input = toJsonObject(z.toJSONSchema(schema, { io: 'input' }))
    output = toJsonObject(z.toJSONSchema(schema, { io: 'output' }))
  } catch (error) {
    throw new ProtocolSchemaError(
      'UNREPRESENTABLE_JSON_SCHEMA',
      'Protocol schema cannot be represented as JSON Schema',
      { cause: error },
    )
  }
  if (canonicalize(input) !== canonicalize(output)) {
    throw new ProtocolSchemaError(
      'SCHEMA_IO_MISMATCH',
      'Protocol schema input and output JSON schemas must match',
    )
  }
  return input
}

function canonicalizeOutput(value: unknown): string {
  try {
    return canonicalize(value)
  } catch (error) {
    throw new ProtocolSchemaError(
      'TRANSFORM_OUTPUT',
      'Protocol schema output must remain JSON',
      { cause: error },
    )
  }
}

function toJsonObject(payload: object): JsonObject {
  const record = payload as Record<string, JsonValue>
  const result: Record<string, JsonValue> = {}
  for (const key of Object.keys(record)) {
    result[key] = record[key]
  }
  return result
}
