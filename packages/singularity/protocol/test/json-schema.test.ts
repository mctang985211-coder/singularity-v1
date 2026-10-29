import assert from 'node:assert/strict'
import test from 'node:test'

import { z } from 'zod'

import { canonicalize } from '../src/json.ts'
import { ProtocolSchemaError, closedObject, protocolJsonSchema } from '../src/schema.ts'

void test('protocolJsonSchema returns a pure, canonical input JSON schema', () => {
  const schema = closedObject({
    id: z.string(),
    labels: z.record(z.string(), z.string()),
  })
  const jsonSchema = protocolJsonSchema(schema)

  assert.equal(jsonSchema['$schema'], 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(jsonSchema.type, 'object')
  assert.deepEqual(jsonSchema.required, ['id', 'labels'])
  assert.equal(jsonSchema.additionalProperties, false)
  assert.ok(Object.getOwnPropertyNames(jsonSchema).includes('properties'))
  assert.equal(Object.getOwnPropertyNames(jsonSchema).includes('~standard'), false)
  assert.equal(canonicalize(jsonSchema), canonicalize(protocolJsonSchema(schema)))
})

void test('protocolJsonSchema does not enforce a DSH-only JSON schema subset', () => {
  const schema = z.union([
    closedObject({ kind: z.literal('one'), values: z.array(z.number()) }),
    closedObject({ kind: z.literal('two'), mapping: z.record(z.string(), z.number()) }),
  ])
  const jsonSchema = protocolJsonSchema(schema)

  assert.ok(Array.isArray(jsonSchema.anyOf))
  assert.doesNotThrow(() => canonicalize(jsonSchema))
})

void test('protocolJsonSchema rejects default-driven input/output divergence', () => {
  const schema = closedObject({ value: z.string().default('fallback') })
  assert.throws(
    () => protocolJsonSchema(schema),
    (error: unknown) => error instanceof ProtocolSchemaError && error.code === 'SCHEMA_IO_MISMATCH',
  )
})

void test('protocolJsonSchema rejects schemas that are unrepresentable as JSON Schema', () => {
  assert.throws(
    () => protocolJsonSchema(z.date()),
    (error: unknown) => error instanceof ProtocolSchemaError && error.code === 'UNREPRESENTABLE_JSON_SCHEMA',
  )
  assert.throws(
    () => protocolJsonSchema(z.string().transform(value => value.length)),
    (error: unknown) => error instanceof ProtocolSchemaError && error.code === 'UNREPRESENTABLE_JSON_SCHEMA',
  )
})
