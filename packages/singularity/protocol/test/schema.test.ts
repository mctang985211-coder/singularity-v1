import assert from 'node:assert/strict'
import test from 'node:test'

import { z } from 'zod'

import { digestSchema } from '../src/digest.ts'
import type { Ref } from '../src/refs.ts'
import { refSchema } from '../src/refs.ts'
import { ProtocolSchemaError,closedObject,parseProtocolValue,protocolJsonSchema } from '../src/schema.ts'

const digest = `sha256:${'a'.repeat(64)}`

void test('closedObject rejects unknown fields in nested objects and union variants', () => {
  const leaf = closedObject({ value: z.string() })
  const variantA = closedObject({ kind: z.literal('a'), text: z.string() })
  const variantB = closedObject({ kind: z.literal('b'), count: z.number() })
  const document = closedObject({
    leaf,
    variants: z.array(z.union([variantA, variantB])),
  })

  const valid = {
    leaf: { value: 'ok' },
    variants: [
      { kind: 'a', text: 'one' },
      { kind: 'b', count: 2 },
    ],
  }
  assert.deepEqual(parseProtocolValue(document, valid), valid)

  for (const invalid of [
    { leaf: { value: 'ok', extra: true }, variants: [] },
    { leaf: { value: 'ok' }, variants: [{ kind: 'a', text: 'one', extra: true }] },
    { leaf: { value: 'ok' }, variants: [{ kind: 'b', count: 2, extra: true }] },
    { leaf: { value: 'ok' }, variants: [{ kind: 'c', text: 'one' }] },
    { leaf: { value: 'ok' }, variants: [], extra: true },
  ]) {
    assert.throws(() => parseProtocolValue(document, invalid))
  }
})

void test('Ref schema derives the Ref type from { id, digest }', () => {
  const value: Ref = { id: 'asset-1', digest }
  const parsed: Ref = parseProtocolValue(refSchema, value)

  assert.deepEqual(parsed, value)
  assert.equal(parsed.id, 'asset-1')
  assert.equal(digestSchema.parse(parsed.digest), digest)
  assert.throws(() => refSchema.parse({ id: 'asset-1' }))
  assert.throws(() => refSchema.parse({ id: 'asset-1', digest, extra: true }))
  assert.throws(() => refSchema.parse({ id: 'asset-1', digest: digest.toUpperCase() }))
})

void test('parseProtocolValue uses the declared schema without serialization round trips', () => {
  const schema = closedObject({
    nested: closedObject({ b: z.string(), a: z.number() }),
    list: z.array(z.string()),
  })
  const value = { nested: { b: 'é', a: 1 }, list: ['雪', '😀'] }

  assert.deepEqual(parseProtocolValue(schema, value), value)
})

void test('schema transforms and defaults are rejected when publishing the schema', () => {
  for (const schema of [z.string().transform(value => value.toUpperCase()), closedObject({ value: z.string().default('fallback') })]) {
    assert.throws(() => protocolJsonSchema(schema), ProtocolSchemaError)
  }
})

void test('parseProtocolValue propagates ordinary schema failures', () => {
  const schema = closedObject({ value: z.number() })
  assert.throws(() => parseProtocolValue(schema, { value: 'not-a-number' }), z.ZodError)
})
