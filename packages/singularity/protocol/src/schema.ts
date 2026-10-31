import { z } from 'zod'

import type { JsonObject,JsonValue } from './json.ts'
import { canonicalize } from './json.ts'

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

/** Lexical workspace/bundle path, checked once at the input schema boundary. */
export const workspaceRelativePathSchema = z.string().min(1).refine(path =>
  !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
  && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
'relative POSIX path without empty or dot segments')

/** Creates a strict object schema; protocol payloads reject unknown fields. */
export function closedObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape)
}

/** Parse at the boundary; schema purity is checked by protocolJsonSchema tests. */
export function parseProtocolValue<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  return schema.parse(value)
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

function toJsonObject(payload: object): JsonObject {
  const record = payload as Record<string, JsonValue>
  const result: Record<string, JsonValue> = {}
  for (const key of Object.keys(record)) {
    result[key] = record[key]
  }
  return result
}
