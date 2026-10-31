import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { JsonObject,JsonValue } from './json.ts';

export type InstanceSchemaValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string }

// Standard draft 2020-12, without mutation, remote schema loading, or defaults.
// Strict keywords catch misspellings; type/required lint rules are optional in
// JSON Schema and would reject existing valid composition-only constraints.
const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false,
  allowUnionTypes: true, ownProperties: true, addUsedSchema: false })
const validators = new WeakMap<JsonObject, ValidateFunction>()

/** Compile each frozen Method schema once and use Ajv for every proposal. */
export function validateInstanceSchema(schema: JsonObject, value: JsonValue): InstanceSchemaValidation {
  try {
    if (schema['$async'] === true) return { valid: false, reason: 'instanceSchema must validate synchronously' }
    let validate = validators.get(schema)
    if (validate === undefined) {
      validate = ajv.compile(schema)
      validators.set(schema, validate)
    }
    return validate(value) ? { valid: true }
      : { valid: false, reason: ajv.errorsText(validate.errors) }
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
