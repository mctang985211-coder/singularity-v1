import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalize } from '../src/json.ts'

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

void test('canonical hashing refuses non-JSON data rather than silently stringifying it', () => {
  for (const value of [NaN, Infinity, undefined, 1n, () => 1, { value: undefined }, new Date()]) {
    assert.throws(() => canonicalize(value))
  }
  const shared = { z: 1 }
  assert.equal(canonicalize({ left: shared, right: shared }), '{"left":{"z":1},"right":{"z":1}}')
})
