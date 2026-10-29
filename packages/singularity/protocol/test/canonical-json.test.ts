import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonErrorCode } from '../src/errors.ts'
import { CanonicalJsonError } from '../src/errors.ts'
import { canonicalize, jsonObjectSchema, jsonValueSchema, parseJsonText } from '../src/json.ts'

function expectCanonicalError(
  action: () => unknown,
  expected: { readonly code: CanonicalJsonErrorCode; readonly path?: string },
): CanonicalJsonError {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError, `expected CanonicalJsonError, got ${String(error)}`)
    assert.equal(error.code, expected.code)
    if (expected.path !== undefined) assert.equal(error.path, expected.path)
    return error
  }
  assert.fail(`expected ${expected.code}`)
}

void test('serializes JSON primitives with JCS scalar semantics', () => {
  assert.equal(canonicalize(null), 'null')
  assert.equal(canonicalize(true), 'true')
  assert.equal(canonicalize(false), 'false')
  assert.equal(canonicalize('text'), '"text"')
  assert.equal(canonicalize(-0), '0')
  assert.equal(canonicalize(1), '1')
  assert.equal(canonicalize(1.5), '1.5')
})

void test('uses ECMAScript number serialization required by RFC 8785', () => {
  const cases: readonly (readonly [number, string])[] = [
    [0, '0'],
    [-0, '0'],
    [1e20, '100000000000000000000'],
    [1e21, '1e+21'],
    [1e30, '1e+30'],
    [1e-6, '0.000001'],
    [1e-7, '1e-7'],
    [2e-3, '0.002'],
    [4.5, '4.5'],
    // RFC 8785 test vector: the source literal rounds to the same double as 333333333.3333333.
    // eslint-disable-next-line no-loss-of-precision
    [333333333.33333329, '333333333.3333333'],
    [1e-27, '1e-27'],
    [2.2250738585072014e-308, '2.2250738585072014e-308'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
    [Number.MIN_VALUE, '5e-324'],
  ]
  for (const [value, expected] of cases) {
    assert.equal(canonicalize(value), expected, String(value))
  }
})

void test('escapes strings without normalization or unnecessary escaping', () => {
  assert.equal(canonicalize('"\\/\b\f\n\r\t'), '"\\"\\\\/\\b\\f\\n\\r\\t"')
  assert.equal(canonicalize('\u0000\u0001\u001f'), '"\\u0000\\u0001\\u001f"')
  assert.equal(canonicalize('é'), '"é"')
  assert.equal(canonicalize('e\u0301'), '"e\u0301"')
  assert.notEqual(canonicalize('é'), canonicalize('e\u0301'))
  assert.equal(canonicalize('€😀'), '"€😀"')
  assert.equal(canonicalize('/'), '"/"')
})

void test('sorts object keys by UTF-16 code units and preserves array order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalize({ 10: 'ten', 2: 'two', a: 'a' }), '{"10":"ten","2":"two","a":"a"}')
  assert.equal(
    canonicalize({
      '\u20ac': 'Euro Sign',
      '\n': 'Newline',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      1: 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }),
    '{"\\n":"Newline","\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
  )
  assert.equal(canonicalize([3, { b: 1, a: 2 }, 1]), '[3,{"a":2,"b":1},1]')
  assert.equal(canonicalize({ z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"z":{"a":2,"b":1}}')
})

void test('allows null-prototype, frozen, and shared-reference JSON objects', () => {
  const nullPrototype = Object.create(null) as Record<string, unknown>
  nullPrototype.b = 1
  nullPrototype.a = 2
  assert.equal(canonicalize(nullPrototype), '{"a":2,"b":1}')
  assert.equal(canonicalize(Object.freeze({ b: 1, a: 2 })), '{"a":2,"b":1}')
  assert.equal(canonicalize(Object.freeze([1, 2])), '[1,2]')
  const shared = { z: 1 }
  assert.equal(canonicalize({ left: shared, right: shared }), '{"left":{"z":1},"right":{"z":1}}')
  const protoKey = Object.create(null) as Record<string, unknown>
  Object.defineProperty(protoKey, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true,
  })
  assert.equal(canonicalize(protoKey), '{"__proto__":{"polluted":true}}')
})

void test('rejects non-finite numbers and non-JSON primitive values', () => {
  expectCanonicalError(() => canonicalize(Infinity), { code: 'NON_FINITE_NUMBER', path: '$' })
  expectCanonicalError(() => canonicalize(-Infinity), { code: 'NON_FINITE_NUMBER', path: '$' })
  expectCanonicalError(() => canonicalize(NaN), { code: 'NON_FINITE_NUMBER', path: '$' })
  expectCanonicalError(() => canonicalize({ a: [1, Infinity] }), {
    code: 'NON_FINITE_NUMBER',
    path: '$["a"][1]',
  })
  expectCanonicalError(() => canonicalize(undefined), { code: 'UNSUPPORTED_VALUE', path: '$' })
  expectCanonicalError(() => canonicalize({ a: undefined }), { code: 'UNSUPPORTED_VALUE', path: '$["a"]' })
  expectCanonicalError(() => canonicalize([undefined]), { code: 'UNSUPPORTED_VALUE', path: '$[0]' })
  expectCanonicalError(() => canonicalize(() => 1), { code: 'UNSUPPORTED_VALUE', path: '$' })
  expectCanonicalError(() => canonicalize(Symbol('x')), { code: 'UNSUPPORTED_VALUE', path: '$' })
  expectCanonicalError(() => canonicalize(1n), { code: 'UNSUPPORTED_VALUE', path: '$' })
  expectCanonicalError(() => canonicalize({ f: () => 1 }), { code: 'UNSUPPORTED_VALUE', path: '$["f"]' })
})

void test('rejects objects outside the plain JSON object model', () => {
  class Example {
    readonly value = 1
  }
  const inherited = Object.create({ inherited: true }) as Record<string, unknown>
  inherited.value = 1
  for (const value of [
    new Date(0),
    new Map([['a', 1]]),
    new Set([1]),
    /x/u,
    new Example(),
    inherited,
    new Number(1),
    new String('x'),
    new Boolean(true),
    new Uint8Array([1]),
    new Error('boom'),
  ]) {
    expectCanonicalError(() => canonicalize(value), { code: 'UNSUPPORTED_OBJECT', path: '$' })
  }
  const nested = { nested: new Date(0) }
  const error = expectCanonicalError(() => canonicalize(nested), {
    code: 'UNSUPPORTED_OBJECT',
    path: '$["nested"]',
  })
  assert.equal(error.detail.constructorName, 'Date')
})

void test('rejects accessors without invoking them', () => {
  let read = false
  const getter = {}
  Object.defineProperty(getter, 'x', {
    enumerable: true,
    get() {
      read = true
      return 1
    },
  })
  expectCanonicalError(() => canonicalize(getter), { code: 'ACCESSOR_PROPERTY', path: '$["x"]' })
  assert.equal(read, false)

  const setter = {}
  Object.defineProperty(setter, 'x', {
    enumerable: true,
    set() {
      read = true
    },
  })
  expectCanonicalError(() => canonicalize(setter), { code: 'ACCESSOR_PROPERTY', path: '$["x"]' })
  assert.equal(read, false)
})

void test('rejects symbol keys and non-enumerable properties', () => {
  const symbolKey = Symbol('secret')
  const symbolized: Record<PropertyKey, unknown> = { visible: 1 }
  symbolized[symbolKey] = 2
  const symbolError = expectCanonicalError(() => canonicalize(symbolized), { code: 'SYMBOL_KEY', path: '$' })
  assert.equal(symbolError.detail.key, 'Symbol(secret)')

  const hidden = { visible: 1 }
  Object.defineProperty(hidden, 'secret', { value: 2, enumerable: false })
  expectCanonicalError(() => canonicalize(hidden), { code: 'NON_ENUMERABLE_PROPERTY', path: '$["secret"]' })

  const hiddenArray = [1]
  Object.defineProperty(hiddenArray, '0', { value: 1, enumerable: false })
  expectCanonicalError(() => canonicalize(hiddenArray), {
    code: 'NON_ENUMERABLE_PROPERTY',
    path: '$[0]',
  })
})

void test('rejects sparse arrays, array extras, and array subclasses', () => {
  const sparse = new Array<number>(3)
  sparse[0] = 1
  sparse[2] = 3
  expectCanonicalError(() => canonicalize(sparse), { code: 'SPARSE_ARRAY', path: '$[1]' })

  const extra = [1, 2]
  Object.defineProperty(extra, 'extra', { value: 3, enumerable: true })
  expectCanonicalError(() => canonicalize(extra), { code: 'ARRAY_EXTRA_PROPERTY', path: '$["extra"]' })

  const leadingZero = [1]
  Object.defineProperty(leadingZero, '01', { value: 2, enumerable: true })
  expectCanonicalError(() => canonicalize(leadingZero), {
    code: 'ARRAY_EXTRA_PROPERTY',
    path: '$["01"]',
  })

  class ExampleArray extends Array<number> {}
  expectCanonicalError(() => canonicalize(new ExampleArray(1, 2)), {
    code: 'UNSUPPORTED_OBJECT',
    path: '$',
  })

  const accessor = [1]
  Object.defineProperty(accessor, '1', {
    enumerable: true,
    get() {
      return 2
    },
  })
  accessor.length = 2
  expectCanonicalError(() => canonicalize(accessor), { code: 'ACCESSOR_PROPERTY', path: '$[1]' })
})

void test('rejects cycles while permitting shared references', () => {
  const direct: Record<string, unknown> = {}
  direct.self = direct
  expectCanonicalError(() => canonicalize(direct), { code: 'CYCLIC_REFERENCE', path: '$["self"]' })

  const root: Record<string, unknown> = {}
  const child: Record<string, unknown> = {}
  root.child = child
  child.parent = root
  expectCanonicalError(() => canonicalize(root), {
    code: 'CYCLIC_REFERENCE',
    path: '$["child"]["parent"]',
  })

  const arrayCycle: unknown[] = []
  arrayCycle.push(arrayCycle)
  expectCanonicalError(() => canonicalize(arrayCycle), { code: 'CYCLIC_REFERENCE', path: '$[0]' })
})

void test('rejects lone surrogate strings and object keys', () => {
  const high = String.fromCharCode(0xd800)
  const low = String.fromCharCode(0xdc00)
  expectCanonicalError(() => canonicalize(high), { code: 'LONE_SURROGATE', path: '$' })
  expectCanonicalError(() => canonicalize(low), { code: 'LONE_SURROGATE', path: '$' })
  expectCanonicalError(() => canonicalize({ value: `${high}x` }), {
    code: 'LONE_SURROGATE',
    path: '$["value"]',
  })
  const keyed = Object.create(null) as Record<string, string>
  keyed[low] = 'value'
  const keyError = expectCanonicalError(() => canonicalize(keyed), {
    code: 'LONE_SURROGATE',
    path: '$["\\udc00"]',
  })
  assert.equal(keyError.detail.key, low)
})

void test('round-trips parser output through canonicalization', () => {
  const text = '{"b":[1,true,null,"x"],"a":{"d":4,"c":3},"n":-0}'
  const canonical = canonicalize(parseJsonText(text))
  assert.equal(canonical, '{"a":{"c":3,"d":4},"b":[1,true,null,"x"],"n":0}')
  assert.equal(canonicalize(parseJsonText(canonical)), canonical)
})

void test('exposes structural zod schemas without treating them as canonical validation', () => {
  assert.equal(jsonValueSchema.safeParse({ a: [1, true, null, 'x'] }).success, true)
  assert.equal(jsonValueSchema.safeParse(() => 1).success, false)
  assert.equal(jsonObjectSchema.safeParse({ a: 1 }).success, true)
  assert.equal(jsonObjectSchema.safeParse([1]).success, false)
  const nullPrototype = Object.create(null) as Record<string, unknown>
  nullPrototype.a = 1
  assert.equal(jsonObjectSchema.safeParse(nullPrototype).success, true)
})
