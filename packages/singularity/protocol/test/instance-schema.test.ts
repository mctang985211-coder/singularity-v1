import assert from 'node:assert/strict'
import test from 'node:test'

import { validateInstanceSchema } from '../src/instance-schema.ts'
import type { JsonObject,JsonValue } from '../src/json.ts'

function valid(schema: JsonObject, value: JsonValue): void {
  const result = validateInstanceSchema(schema, value)
  assert.equal(result.valid, true, JSON.stringify(result))
}

function invalid(schema: JsonObject, value: JsonValue): void {
  const result = validateInstanceSchema(schema, value)
  assert.equal(result.valid, false)
}

void test('instanceSchema accepts boolean schemas and the documented supported subset', () => {
  valid({}, null)
  valid(Object.freeze({}) as JsonObject, { nested: [1, 'two', false] })
  valid({ type: 'object', properties: {}, additionalProperties: true }, { any: 'value' })
  valid({ type: ['string', 'null'] }, null)
  valid({ enum: ['red', 'blue'] }, 'blue')
  valid({ const: null }, null)
  valid({
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 3, pattern: '^[a-z]+$' } },
    additionalProperties: false,
  }, { name: 'abc' })
  valid({
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 3 },
    minItems: 1,
    maxItems: 3,
  }, [1, 2])
  valid({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 4)
  valid({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'four')
  valid({ allOf: [{ type: 'number' }, { minimum: 2 }] }, 2)
  valid({ not: { type: 'null' } }, 'present')
  valid({
    type: 'object',
    properties: { key: { type: 'string' } },
    additionalProperties: { type: 'integer' },
  }, { key: 'ok', other: 2 })
  valid({
    type: 'object',
    additionalProperties: false,
  }, {})
  valid({
    title: 'annotation',
    description: 'ignored',
    default: { anything: true },
    examples: [1, 2],
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:example:schema',
  } as JsonObject, 'value')
})

void test('instanceSchema rejects values outside type, const, enum, and composition constraints', () => {
  invalid({ type: 'object' }, [])
  invalid({ type: 'array' }, {})
  invalid({ type: 'string' }, 1)
  invalid({ type: 'number' }, Number.NaN)
  invalid({ type: 'integer' }, 1.5)
  invalid({ type: 'boolean' }, 'true')
  invalid({ type: 'null' }, 0)
  invalid({ const: null }, false)
  invalid({ const: 3 }, '3')
  invalid({ enum: ['red'] }, 'blue')
  invalid({ anyOf: [{ type: 'string' }] }, 1)
  invalid({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 2)
  invalid({ allOf: [{ type: 'number' }, { minimum: 5 }] }, 4)
  invalid({ not: { type: 'string' } }, 'blocked')
})

void test('instanceSchema enforces object, array, string, and number constraints', () => {
  invalid({
    type: 'object', required: ['name'],
  }, {})
  invalid({
    type: 'object', required: ['toString'],
  }, {})
  invalid({
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  }, { name: 'ok', extra: true })
  invalid({
    type: 'object',
    additionalProperties: false,
  }, { extra: true })
  invalid({
    type: 'object',
    additionalProperties: { type: 'integer' },
  }, { extra: 'not-integer' })
  invalid({ type: 'array', items: { type: 'string' } }, ['ok', 2])
  invalid({ type: 'array', minItems: 2 }, [1])
  invalid({ type: 'array', maxItems: 1 }, [1, 2])
  invalid({ type: 'string', minLength: 2 }, 'a')
  invalid({ type: 'string', maxLength: 1 }, 'ab')
  invalid({ type: 'string', pattern: '^[a-z]+$' }, 'ABC')
  invalid({ type: 'number', minimum: 2 }, 1)
  invalid({ type: 'number', maximum: 2 }, 3)
})

void test('instanceSchema rejects unsupported keywords and malformed schemas even when unused', () => {
  const cases: readonly JsonObject[] = [
    { $ref: '#/$defs/x' },
    { $async: true, type: 'string' },
    { format: 'email' },
    { type: 'unknown' },
    { type: [] },
    { enum: [] },
    { anyOf: [] },
    { oneOf: [true, 1] },
    { allOf: {} },
    { not: null },
    { properties: [] },
    { properties: { unused: { unsupportedNested: true } } },
    { required: 'name' },
    { required: [1] },
    { additionalProperties: 'yes' },
    { items: [{ type: 'string' }] },
    { items: { type: 'string', format: 'email' } },
    { minItems: -1 },
    { maxItems: 1.5 },
    { minLength: '1' },
    { maxLength: -1 },
    { minimum: '0' },
    { maximum: Infinity },
    { pattern: '[' },
    { properties: { unused: { type: 'string', pattern: '[' } } },
    { type: 'object', properties: { unused: { type: 'string' } }, additionalProperties: null },
    { type: 'object', properties: { unused: { type: 'string' } }, required: [null] },
  ] as unknown as JsonObject[]

  for (const schema of cases) {
    const result = validateInstanceSchema(schema, { unused: 'value' })
    assert.equal(result.valid, false, `expected rejection for ${JSON.stringify(schema)}`)
  }
})

void test('instanceSchema rejects non-schema roots and false subschemas', () => {
  for (const schema of [null, 1, 'schema', []] as unknown as JsonObject[]) {
    assert.equal(validateInstanceSchema(schema, null).valid, false)
  }
  invalid({ type: 'object', properties: { blocked: false } }, { blocked: 1 })
  valid({ type: 'object', properties: { blocked: false } }, {})
  invalid({ items: false, type: 'array' }, [1])
  valid({ items: false, type: 'array' }, [])
})

void test('instanceSchema measures string length in Unicode code points', () => {
  valid({ type: 'string', minLength: 1, maxLength: 1 }, '😀')
  invalid({ type: 'string', minLength: 2 }, '😀')
  valid({ type: 'string', minLength: 2, maxLength: 2 }, '😀界')
})

void test('Ajv supports standard references, patternProperties and uniqueItems without a second interpreter', () => {
  valid({ $defs: { positive: { type: 'number', exclusiveMinimum: 0 } }, $ref: '#/$defs/positive' }, 1)
  invalid({ $defs: { positive: { type: 'number', exclusiveMinimum: 0 } }, $ref: '#/$defs/positive' }, 0)
  valid({ type: 'object', patternProperties: { '^x': { type: 'integer' } }, additionalProperties: false }, { x1: 1 })
  invalid({ type: 'array', uniqueItems: true }, [1, 1])
  const schema = { type: 'object', properties: { x: { type: 'integer', default: 1 } } }
  const value = {}
  valid(schema, value)
  assert.deepEqual(value, {})
})
