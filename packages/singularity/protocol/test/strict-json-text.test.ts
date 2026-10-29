import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJsonErrorCode } from '../src/errors.ts'
import { CanonicalJsonError } from '../src/errors.ts'
import type { JsonObject, JsonValue } from '../src/json.ts'
import { parseJsonText } from '../src/json.ts'

function expectJsonError(
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

function objectPrototypePolluted(): unknown {
  return (Object.prototype as { readonly polluted?: unknown }).polluted
}

void test('parses the complete JSON value grammar', () => {
  assert.equal(parseJsonText('null'), null)
  assert.equal(parseJsonText(' true '), true)
  assert.equal(parseJsonText('\r\n\t false \n'), false)
  assert.equal(parseJsonText('"hello"'), 'hello')
  assert.equal(parseJsonText('0'), 0)
  assert.equal(parseJsonText('-0'), -0)
  assert.equal(parseJsonText('1.5'), 1.5)
  assert.equal(parseJsonText('1e2'), 100)
  assert.equal(parseJsonText('1E+2'), 100)
  assert.equal(parseJsonText('1e-2'), 0.01)
  assert.equal(parseJsonText('9007199254740991'), Number.MAX_SAFE_INTEGER)
  assert.equal(parseJsonText('-9007199254740991'), -Number.MAX_SAFE_INTEGER)
  const parsed = parseJsonText('{"a":[1,true,null,"x",{"b":2}]}')
  assert.ok(isJsonObject(parsed))
  const array = parsed.a
  assert.ok(Array.isArray(array))
  assert.deepEqual(array.slice(0, 4), [1, true, null, 'x'])
  const nested = array[4]
  assert.ok(isJsonObject(nested))
  assert.equal(nested.b, 2)
})

void test('parses strings with escapes, Unicode, and surrogate pairs', () => {
  assert.equal(parseJsonText('"\\"\\\\\\/\\b\\f\\n\\r\\t"'), '"\\/\b\f\n\r\t')
  assert.equal(parseJsonText('"\\u0000\\u001f\\u00e9\\u20ac"'), '\u0000\u001f\u00e9\u20ac')
  assert.equal(parseJsonText('"\\ud83d\\ude00"'), '😀')
  assert.equal(parseJsonText('"😀"'), '😀')
  assert.equal(parseJsonText('"e\\u0301"'), 'e\u0301')
  assert.equal(parseJsonText('"\\u0061"'), 'a')
})

void test('returns null-prototype objects at every object depth', () => {
  const parsed = parseJsonText('{"outer":{"inner":{"value":1}},"items":[{"x":2}]}')
  assert.ok(isJsonObject(parsed))
  assert.equal(Object.getPrototypeOf(parsed), null)
  const outer = parsed.outer
  assert.ok(isJsonObject(outer))
  assert.equal(Object.getPrototypeOf(outer), null)
  const inner = outer.inner
  assert.ok(isJsonObject(inner))
  assert.equal(Object.getPrototypeOf(inner), null)
  const items = parsed.items
  assert.ok(Array.isArray(items))
  const first = items[0]
  assert.ok(isJsonObject(first))
  assert.equal(Object.getPrototypeOf(first), null)
})

void test('stores __proto__ and constructor as own data keys without prototype pollution', () => {
  const parsed = parseJsonText('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')
  assert.ok(isJsonObject(parsed))
  assert.equal(Object.getPrototypeOf(parsed), null)
  const protoDescriptor = Object.getOwnPropertyDescriptor(parsed, '__proto__')
  assert.ok(protoDescriptor !== undefined)
  assert.equal(protoDescriptor.enumerable, true)
  assert.equal(protoDescriptor.writable, true)
  const protoValue: unknown = protoDescriptor.value
  assert.ok(isJsonObject(protoValue))
  assert.equal(protoValue.polluted, true)
  assert.equal(objectPrototypePolluted(), undefined)
  const constructorDescriptor = Object.getOwnPropertyDescriptor(parsed, 'constructor')
  assert.ok(constructorDescriptor !== undefined)
  assert.equal(constructorDescriptor.enumerable, true)
  assert.equal(objectPrototypePolluted(), undefined)
})

void test('rejects duplicate keys after escape decoding, including nested keys and __proto__', () => {
  expectJsonError(() => parseJsonText('{"a":1,"a":2}'), { code: 'DUPLICATE_KEY', path: '$["a"]' })
  expectJsonError(() => parseJsonText('{"a":1,"\\u0061":2}'), { code: 'DUPLICATE_KEY', path: '$["a"]' })
  expectJsonError(() => parseJsonText('{"\\u0061":1,"a":2}'), { code: 'DUPLICATE_KEY', path: '$["a"]' })
  expectJsonError(() => parseJsonText('{"outer":{"a":1,"a":2}}'), {
    code: 'DUPLICATE_KEY',
    path: '$["outer"]["a"]',
  })
  expectJsonError(() => parseJsonText('{"__proto__":1,"__proto__":2}'), {
    code: 'DUPLICATE_KEY',
    path: '$["__proto__"]',
  })
  expectJsonError(() => parseJsonText('[{"x":[{"a":1,"a":2}]}]'), {
    code: 'DUPLICATE_KEY',
    path: '$[0]["x"][0]["a"]',
  })
})

void test('rejects plain integers outside the safe integer range', () => {
  expectJsonError(() => parseJsonText('9007199254740992'), { code: 'UNSAFE_INTEGER', path: '$' })
  expectJsonError(() => parseJsonText('-9007199254740992'), { code: 'UNSAFE_INTEGER', path: '$' })
  expectJsonError(() => parseJsonText('{"n":9007199254740993}'), {
    code: 'UNSAFE_INTEGER',
    path: '$["n"]',
  })
  expectJsonError(() => parseJsonText('999999999999999999999999999999999999'), {
    code: 'UNSAFE_INTEGER',
    path: '$',
  })
  const error = expectJsonError(() => parseJsonText('[9007199254740992]'), {
    code: 'UNSAFE_INTEGER',
    path: '$[0]',
  })
  assert.equal(error.detail.literal, '9007199254740992')
})

void test('rejects numbers that are lexically invalid or non-finite', () => {
  for (const text of ['01', '+1', '1.', '.1', '1e', '1e+', '--1', '1_0', '0x10', '-']) {
    expectJsonError(() => parseJsonText(text), { code: 'INVALID_NUMBER', path: '$' })
  }
  for (const text of ['1e400', '-1e400', '1e999999999']) {
    expectJsonError(() => parseJsonText(text), { code: 'NON_FINITE_NUMBER', path: '$' })
  }
  expectJsonError(() => parseJsonText('{"n":1e400}'), {
    code: 'NON_FINITE_NUMBER',
    path: '$["n"]',
  })
})

void test('rejects structural JSON syntax violations', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['', '$'],
    ['   ', '$'],
    ['{', '$'],
    ['[', '$[0]'],
    ['{"a"}', '$'],
    ['{"a":}', '$["a"]'],
    ['{"a" 1}', '$'],
    ['{a:1}', '$'],
    ["{'a':1}", '$'],
    ['[1,]', '$'],
    ['{"a":1,}', '$'],
    ['[,1]', '$[0]'],
    ['[,]', '$[0]'],
    ['[1 2]', '$'],
    ['{"a":1 "b":2}', '$'],
    ['tru', '$'],
    ['nul', '$'],
    ['Infinity', '$'],
    ['NaN', '$'],
  ]
  for (const [text, path] of cases) {
    expectJsonError(() => parseJsonText(text), { code: 'INVALID_JSON_SYNTAX', path })
  }
})

void test('rejects trailing data and a byte order mark', () => {
  expectJsonError(() => parseJsonText('null null'), { code: 'TRAILING_DATA', path: '$' })
  expectJsonError(() => parseJsonText('{}x'), { code: 'TRAILING_DATA', path: '$' })
  expectJsonError(() => parseJsonText('\uFEFF{}'), { code: 'UNEXPECTED_BOM', path: '$' })
  expectJsonError(() => parseJsonText(' \n\uFEFF{}'), { code: 'UNEXPECTED_BOM', path: '$' })
})

void test('rejects raw control characters and malformed string escapes', () => {
  expectJsonError(() => parseJsonText('"line\nbreak"'), { code: 'CONTROL_CHARACTER', path: '$' })
  expectJsonError(() => parseJsonText('"tab\there"'), { code: 'CONTROL_CHARACTER', path: '$' })
  expectJsonError(() => parseJsonText(`"${String.fromCharCode(0x01)}"`), {
    code: 'CONTROL_CHARACTER',
    path: '$',
  })
  expectJsonError(() => parseJsonText('"\\x"'), { code: 'INVALID_JSON_ESCAPE', path: '$' })
  expectJsonError(() => parseJsonText('"\\u12"'), { code: 'INVALID_JSON_ESCAPE', path: '$' })
  expectJsonError(() => parseJsonText('"\\uZZZZ"'), { code: 'INVALID_JSON_ESCAPE', path: '$' })
  expectJsonError(() => parseJsonText('"abc'), { code: 'UNTERMINATED_STRING', path: '$' })
  expectJsonError(() => parseJsonText('"abc\\'), { code: 'UNTERMINATED_STRING', path: '$' })
})

void test('rejects lone surrogate code units in raw and escaped strings', () => {
  const high = String.fromCharCode(0xd800)
  const low = String.fromCharCode(0xdc00)
  expectJsonError(() => parseJsonText(`"${high}"`), { code: 'LONE_SURROGATE', path: '$' })
  expectJsonError(() => parseJsonText(`"${low}"`), { code: 'LONE_SURROGATE', path: '$' })
  expectJsonError(() => parseJsonText('"\\ud800"'), { code: 'LONE_SURROGATE', path: '$' })
  expectJsonError(() => parseJsonText('"\\udc00"'), { code: 'LONE_SURROGATE', path: '$' })
  expectJsonError(() => parseJsonText('"\\ud800\\ud800"'), { code: 'LONE_SURROGATE', path: '$' })
  expectJsonError(() => parseJsonText(`{"${high}":1}`), { code: 'LONE_SURROGATE', path: '$' })
})

void test('reports stable codes, paths, and source locations', () => {
  const duplicate = expectJsonError(() => parseJsonText('{"a":1,"a":2}'), {
    code: 'DUPLICATE_KEY',
    path: '$["a"]',
  })
  assert.equal(duplicate.name, 'CanonicalJsonError')
  assert.equal(duplicate.detail.key, 'a')
  assert.equal(duplicate.detail.offset, 7)
  assert.equal(duplicate.detail.line, 1)
  assert.equal(duplicate.detail.column, 8)

  const nested = expectJsonError(() => parseJsonText('{\n  "a": 1e400\n}'), {
    code: 'NON_FINITE_NUMBER',
    path: '$["a"]',
  })
  assert.equal(nested.detail.line, 2)
  assert.equal(nested.detail.column, 8)
})

void test('parsed values are canonicalizable JSON values', () => {
  const parsed: JsonValue = parseJsonText('{"b":[1,{"d":4}],"a":"\\u00e9"}')
  assert.equal(typeof parsed, 'object')
  assert.ok(isJsonObject(parsed))
  assert.deepEqual(Object.keys(parsed), ['b', 'a'])
})

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
