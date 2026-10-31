import { canonicalize as canonicalizeJson } from 'json-canonicalize'
import { z } from 'zod'

/** JSON data at public boundaries; domain schemas constrain counters and IDs. */
export const jsonValueSchema = z.json()
export type JsonValue = z.infer<typeof jsonValueSchema>
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)
export type JsonObject = z.infer<typeof jsonObjectSchema>

/** Standard JSON parsing. Tool arguments are already parsed by DSH. */
export function parseJsonText(text: string): JsonValue {
  const value: unknown = JSON.parse(text)
  jsonValueSchema.parse(value)
  return value as JsonValue
}

/** Canonical serialization for supported JSON artifact identities, using the library codec. */
export function canonicalize(value: unknown): string {
  jsonValueSchema.parse(value)
  return canonicalizeJson(value)
}
