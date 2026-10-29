import assert from 'node:assert/strict'
import test from 'node:test'

import { z } from 'zod'

import { digestSchema } from '../src/digest.ts'
import { CanonicalJsonError } from '../src/errors.ts'
import { refSchema } from '../src/refs.ts'
import type { Ref } from '../src/refs.ts'
import { ProtocolSchemaError, closedObject, parseProtocolValue } from '../src/schema.ts'

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

void test('parseProtocolValue canonicalizes input, parses, and canonicalizes output', () => {
  const schema = closedObject({
    nested: closedObject({ b: z.string(), a: z.number() }),
    list: z.array(z.string()),
  })
  const value = { nested: { b: 'é', a: 1 }, list: ['雪', '😀'] }

  assert.deepEqual(parseProtocolValue(schema, value), value)
})

void test('parseProtocolValue rejects accessors, undefined, and non-JSON input', () => {
  const schema = closedObject({ value: z.string() })
  const inputs: unknown[] = [
    { get value(): string { return 'x' } },
    { value: 'x', missing: undefined },
    { value: 1n },
    { value: new Date(0) },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: Symbol('x') },
    { value: () => 'x' },
  ]

  for (const input of inputs) {
    assert.throws(
      () => parseProtocolValue(schema, input),
      (error: unknown) => error instanceof CanonicalJsonError,
    )
  }
})

void test('parseProtocolValue rejects schemas that transform or default the JSON value', () => {
  const transformed = z.string().transform(value => value.toUpperCase())
  assert.throws(
    () => parseProtocolValue(transformed, 'abc'),
    (error: unknown) => error instanceof ProtocolSchemaError && error.code === 'TRANSFORM_OUTPUT',
  )

  const defaulted = closedObject({ value: z.string().default('fallback') })
  assert.throws(
    () => parseProtocolValue(defaulted, {}),
    (error: unknown) => error instanceof ProtocolSchemaError && error.code === 'TRANSFORM_OUTPUT',
  )

  const coerced = z.coerce.number()
  assert.throws(
    () => parseProtocolValue(coerced, '1'),
    (error: unknown) => error instanceof ProtocolSchemaError && error.code === 'TRANSFORM_OUTPUT',
  )
})

void test('parseProtocolValue propagates ordinary schema failures', () => {
  const schema = closedObject({ value: z.number() })
  assert.throws(() => parseProtocolValue(schema, { value: 'not-a-number' }), z.ZodError)
})
