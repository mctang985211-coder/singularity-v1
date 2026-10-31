import assert from 'node:assert/strict'
import test from 'node:test'

import type { DigestDomain } from '../src/digest.ts'
import {
DIGEST_DOMAINS,
computeDigest,
computeDigestBytes,
digestDomainSchema,
digestSchema,
seal,
verifyDigest,
} from '../src/digest.ts'
import * as protocol from '../src/index.ts'

const FACT_UNICODE_VECTOR = 'sha256:7f0c429ff97bae40c7df0bb88064b1956602dd7810d26a5c0343b2a83d921243'
const RAW_BYTES_VECTOR = 'sha256:14066eba9938ece0885c01078961c83f1df89af4aa4e251494d77bc93ea7d6cc'
const EMPTY_ROUND_PLAN_VECTOR = 'sha256:977b8124b92c16ffb3b5705245a581f52c6b676b583e7b8979b1cf9e7392c5ac'
const COMMAND_UNICODE_VECTOR = 'sha256:e052acb8d65c307a4f5609371b10b5b1891f141c22f6a23b87b03b93c9062802'
const EMPTY_COMMAND_VECTOR = 'sha256:52c8df06a34cb59a72da1f67ff1b21c5e95ca4699ab3f7d0b42840df1ecca4c5'

void test('the nine digest domains are frozen with command appended last', () => {
  assert.deepEqual([...DIGEST_DOMAINS], [
    'fact',
    'contract',
    'method',
    'object',
    'composition',
    'evidence',
    'preview',
    'round-plan',
    'command',
  ])
  assert.equal(DIGEST_DOMAINS.at(-1), 'command')
  for (const domain of DIGEST_DOMAINS) {
    assert.equal(digestDomainSchema.parse(domain), domain)
  }
  assert.equal(digestDomainSchema.safeParse('Fact').success, false)
  assert.equal(digestDomainSchema.safeParse('round_plan').success, false)
})

void test('Digest accepts only lowercase sha256 with 64 hex characters', () => {
  const valid = `sha256:${'a'.repeat(64)}`
  assert.equal(digestSchema.parse(valid), valid)
  for (const invalid of [
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'a'.repeat(65)}`,
    `sha256:${'g'.repeat(64)}`,
    `SHA256:${'a'.repeat(64)}`,
    'sha256:',
    `md5:${'a'.repeat(32)}`,
    `sha256:${'0'.repeat(64)}:extra`,
  ]) {
    assert.equal(digestSchema.safeParse(invalid).success, false, invalid)
  }
})

void test('computeDigest matches an independently calculated static vector', () => {
  assert.equal(computeDigest('fact', { b: 'é', a: 1 }), FACT_UNICODE_VECTOR)
  assert.equal(computeDigest('fact', { a: 1, b: 'é' }), FACT_UNICODE_VECTOR)
  assert.notEqual(computeDigest('contract', { a: 1, b: 'é' }), FACT_UNICODE_VECTOR)
})

void test('computeDigest sorts object keys but preserves array order', () => {
  const first = computeDigest('composition', { z: 1, nested: { b: 2, a: 1 }, list: ['b', 'a'] })
  const second = computeDigest('composition', { list: ['b', 'a'], nested: { a: 1, b: 2 }, z: 1 })
  const reorderedArray = computeDigest('composition', { z: 1, nested: { b: 2, a: 1 }, list: ['a', 'b'] })
  assert.equal(first, second)
  assert.notEqual(first, reorderedArray)
})

void test('Unicode is UTF-8 encoded without normalization', () => {
  const composed = computeDigest('object', { text: 'é' })
  const decomposed = computeDigest('object', { text: 'e\u0301' })
  const expectedBytes = new TextEncoder().encode('{"text":"é"}')
  assert.equal(composed, computeDigestBytes('object', expectedBytes))
  assert.notEqual(composed, decomposed)
})

void test('computeDigestBytes hashes raw bytes after the domain prefix', () => {
  assert.equal(
    computeDigestBytes('object', new Uint8Array([0x00, 0xff, 0x01])),
    RAW_BYTES_VECTOR,
  )
  assert.equal(computeDigestBytes('round-plan', new Uint8Array()), EMPTY_ROUND_PLAN_VECTOR)
})

void test('the command domain hashes normalized commands independently of other domains', () => {
  assert.equal(computeDigest('command', { b: 'é', a: 1 }), COMMAND_UNICODE_VECTOR)
  assert.equal(computeDigest('command', { a: 1, b: 'é' }), COMMAND_UNICODE_VECTOR)
  assert.equal(computeDigestBytes('command', new Uint8Array()), EMPTY_COMMAND_VECTOR)
  assert.notEqual(computeDigest('command', { a: 1 }), computeDigest('fact', { a: 1 }))
  assert.notEqual(computeDigest('command', { a: 1 }), computeDigest('contract', { a: 1 }))
})

void test('computeDigestBytes rejects a domain outside the frozen set', () => {
  assert.throws(() => computeDigestBytes('unknown' as DigestDomain, new Uint8Array()))
})

void test('seal removes only the outermost digest and keeps nested digests', () => {
  const child = seal('object', { id: 'child' })
  const payload = { child, note: 'retain nested digest' }
  const parent = seal('fact', payload)

  assert.deepEqual(payload, { child, note: 'retain nested digest' })
  assert.equal('digest' in payload, false)
  assert.equal(parent.child, child)
  assert.equal(parent.child.digest, child.digest)
  assert.equal(parent.digest, computeDigest('fact', payload))
  assert.equal(computeDigest('fact', parent), parent.digest)
  assert.equal(verifyDigest('object', parent.child), true)
  assert.equal(verifyDigest('fact', parent), true)
})

void test('resealing replaces the outermost digest without changing nested digests', () => {
  const nested = seal('evidence', { runId: 'run-1' })
  const first = seal('preview', { nested, counter: 1 })
  const second = seal('preview', first)

  assert.equal(second.nested, nested)
  assert.equal(second.nested.digest, nested.digest)
  assert.equal(second.digest, first.digest)
  assert.equal(verifyDigest('preview', second), true)
})

void test('verifyDigest rejects tampering, extra fields, malformed digests, and the wrong domain', () => {
  const sealed = seal('fact', { goal: 'ship', nested: seal('object', { id: 'asset' }) })

  assert.equal(verifyDigest('fact', sealed), true)
  assert.equal(verifyDigest('contract', sealed), false)
  assert.equal(verifyDigest('fact', { ...sealed, goal: 'changed' }), false)
  assert.equal(verifyDigest('fact', { ...sealed, extra: true }), false)
  assert.equal(verifyDigest('fact', { ...sealed, digest: `sha256:${'0'.repeat(64)}` }), false)
  assert.equal(verifyDigest('fact', { ...sealed, digest: sealed.digest.toUpperCase() }), false)
  assert.equal(verifyDigest('fact', { ...sealed, digest: 1 }), false)
  assert.equal(verifyDigest('fact', null), false)
  assert.equal(verifyDigest('fact', sealed.nested), false)
})

void test('verifyDigest returns false when the sealed value cannot be canonicalized', () => {
  const sealed = seal('fact', { goal: 'ship' })
  assert.equal(verifyDigest('fact', { ...sealed, goal: Number.NaN }), false)
})

void test('index exports errors, json, digest, schema, and refs', () => {
  assert.equal(typeof protocol.canonicalize, 'function')
  assert.equal(typeof protocol.parseJsonText, 'function')
  assert.equal(typeof protocol.computeDigest, 'function')
  assert.equal(typeof protocol.closedObject, 'function')
  assert.equal(typeof protocol.parseProtocolValue, 'function')
  assert.equal(typeof protocol.protocolJsonSchema, 'function')
  assert.equal(typeof protocol.refSchema.parse, 'function')
})
