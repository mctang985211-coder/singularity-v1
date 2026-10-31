import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJsonText } from '../src/json.ts'
import { refSchema } from '../src/refs.ts'
import { parseProtocolValue } from '../src/schema.ts'

void test('JSON text uses standard parser semantics and typed boundaries reject malformed values', () => {
  assert.deepEqual(parseJsonText('{"nested":[1,true,null,"雪"]}'), { nested: [1, true, null, '雪'] })
  assert.deepEqual(parseJsonText('{"x":1,"x":2}'), { x: 2 })
  assert.throws(() => parseJsonText('{"x":}'), SyntaxError)
  assert.throws(() => parseJsonText('true false'), SyntaxError)
  assert.throws(() => parseJsonText('1e999'))
  assert.throws(() => parseProtocolValue(refSchema, parseJsonText('{"id":1,"digest":"wrong"}')))
})

void test('standard parsing preserves own __proto__ data without polluting prototypes', () => {
  const parsed = parseJsonText('{"__proto__":{"polluted":true},"constructor":1}')
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
  assert.equal(Object.hasOwn(parsed, '__proto__'), true)
  assert.equal(parsed['constructor'], 1)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})
