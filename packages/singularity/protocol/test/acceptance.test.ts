import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, digestSchema, verifyDigest } from '../src/digest.ts'
import * as protocol from '../src/index.ts'
import {
  publicCriterionResultSchema,
  publicExitStatusSchema,
  publicReceiptPayloadSchema,
  publicReceiptSchema,
  sealPublicReceipt,
  validatePublicReceipt,
  verifyPublicReceipt,
} from '../src/acceptance.ts'
import type {
  PublicCriterionResult,
  PublicReceipt,
  PublicReceiptExpectation,
  PublicReceiptPayload,
} from '../src/acceptance.ts'
import { parseProtocolValue } from '../src/schema.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`
const digestE = `sha256:${'e'.repeat(64)}`

const provider = { id: 'acceptance-provider', digest: digestA }

const expectation: PublicReceiptExpectation = {
  provider,
  operationId: 'run-1:verify',
  contractDigest: digestB,
  inputDigests: [digestC, digestD],
  outputDigests: [digestE],
  requiredCriteria: ['criterion-a', 'criterion-b'],
}

const passingCriteria: PublicCriterionResult[] = [
  {
    id: 'criterion-a',
    verdict: 'pass',
    reason: 'The public result satisfies the declared criterion.',
    metric: { name: 'accuracy', unit: 'ratio', value: 1 },
    score: 1,
  },
  {
    id: 'criterion-b',
    verdict: 'pass',
    reason: 'The public result is reproducible.',
    metric: { name: 'duration', unit: 'ms', value: 12 },
  },
]

function receiptPayload(overrides: Partial<PublicReceiptPayload> = {}): PublicReceiptPayload {
  return {
    v: 1,
    provider,
    operationId: 'run-1:verify',
    contractDigest: digestB,
    inputDigests: [digestC, digestD],
    outputDigests: [digestE],
    criteria: passingCriteria,
    exit: { code: 0, signal: null },
    timedOut: false,
    ...overrides,
  }
}

function sealedReceipt(overrides: Partial<PublicReceiptPayload> = {}): PublicReceipt {
  return sealPublicReceipt(receiptPayload(overrides))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

void test('protocol index exports the acceptance schema and validators', () => {
  assert.equal(protocol.sealPublicReceipt, sealPublicReceipt)
  assert.equal(protocol.verifyPublicReceipt, verifyPublicReceipt)
  assert.equal(protocol.validatePublicReceipt, validatePublicReceipt)
  assert.equal(protocol.publicReceiptPayloadSchema, publicReceiptPayloadSchema)
  assert.equal(protocol.publicReceiptSchema, publicReceiptSchema)
  assert.equal(protocol.publicCriterionResultSchema, publicCriterionResultSchema)
  assert.equal(protocol.publicExitStatusSchema, publicExitStatusSchema)
})

void test('sealPublicReceipt seals the strict receipt in the object domain', () => {
  const payload = receiptPayload()
  const receipt = sealPublicReceipt(payload)

  assert.equal(receipt.digest, computeDigest('object', payload))
  assert.equal(digestSchema.safeParse(receipt.digest).success, true)
  assert.equal(verifyPublicReceipt(receipt), true)
  assert.equal(verifyDigest('object', receipt), true)
  assert.equal(verifyDigest('evidence', receipt), false)
  assert.deepEqual(publicReceiptPayloadSchema.parse(payload), payload)
  assert.deepEqual(publicReceiptSchema.parse(receipt), receipt)
  assert.equal(sealPublicReceipt(payload).digest, receipt.digest)
})

void test('validatePublicReceipt verifies a fully matching receipt', () => {
  const result = validatePublicReceipt(sealedReceipt(), expectation)

  assert.equal(result.verdict, 'verified')
  assert.equal(verifyPublicReceipt(result.receipt), true)
})

void test('required criteria may arrive in any order but must match the required set', () => {
  const criteria = [...passingCriteria].reverse()
  const result = validatePublicReceipt(sealedReceipt({ criteria }), expectation)
  assert.equal(result.verdict, 'verified')
})

void test('exit code zero is necessary but not sufficient for verified', () => {
  const missingRequired = validatePublicReceipt(
    sealedReceipt({ criteria: [passingCriteria[0]] }),
    expectation,
  )
  assert.equal(missingRequired.verdict, 'invalid')

  const duplicateRequired = validatePublicReceipt(
    sealPublicReceipt(
      receiptPayload({
        criteria: [passingCriteria[0], passingCriteria[0]],
      }),
    ),
    expectation,
  )
  assert.equal(duplicateRequired.verdict, 'invalid')

  const extraCriterion = validatePublicReceipt(
    sealedReceipt({
      criteria: [
        ...passingCriteria,
        { id: 'local-guidance', verdict: 'pass', reason: 'Not a required acceptance criterion.' },
      ],
    }),
    expectation,
  )
  assert.equal(extraCriterion.verdict, 'invalid')

  const timedOut = validatePublicReceipt(sealedReceipt({ timedOut: true }), expectation)
  assert.equal(timedOut.verdict, 'invalid')

  const signalled = validatePublicReceipt(
    sealedReceipt({ exit: { code: null, signal: 'SIGKILL' } }),
    expectation,
  )
  assert.equal(signalled.verdict, 'invalid')

  const nonzeroAllPass = validatePublicReceipt(
    sealedReceipt({ exit: { code: 7, signal: null } }),
    expectation,
  )
  assert.equal(nonzeroAllPass.verdict, 'invalid')
})

void test('a criterion fail is failed even with exit zero or a non-zero exit code', () => {
  const failingCriteria: PublicCriterionResult[] = [
    { id: 'criterion-a', verdict: 'fail', reason: 'The public result misses the threshold.' },
    passingCriteria[1],
  ]

  const exitZero = validatePublicReceipt(sealedReceipt({ criteria: failingCriteria }), expectation)
  assert.equal(exitZero.verdict, 'failed')

  const exitNonzero = validatePublicReceipt(
    sealedReceipt({ criteria: failingCriteria, exit: { code: 7, signal: null } }),
    expectation,
  )
  assert.equal(exitNonzero.verdict, 'failed')
})

void test('an invalid criterion, timeout, or signal always wins as invalid', () => {
  const invalidCriterion: PublicCriterionResult[] = [
    { id: 'criterion-a', verdict: 'invalid', reason: 'The public fixture could not run.' },
    passingCriteria[1],
  ]

  const withInvalid = validatePublicReceipt(sealedReceipt({ criteria: invalidCriterion }), expectation)
  assert.equal(withInvalid.verdict, 'invalid')

  const withFailAndTimeout = validatePublicReceipt(
    sealedReceipt({
      criteria: [{ id: 'criterion-a', verdict: 'fail', reason: 'The public result misses.' }, passingCriteria[1]],
      timedOut: true,
    }),
    expectation,
  )
  assert.equal(withFailAndTimeout.verdict, 'invalid')

  const withFailAndSignal = validatePublicReceipt(
    sealedReceipt({
      criteria: [{ id: 'criterion-a', verdict: 'fail', reason: 'The public result misses.' }, passingCriteria[1]],
      exit: { code: null, signal: 'SIGTERM' },
    }),
    expectation,
  )
  assert.equal(withFailAndSignal.verdict, 'invalid')
})

void test('provider, operationId, contract, input, and output identity must match exactly', () => {
  assert.equal(
    validatePublicReceipt(sealedReceipt({ provider: { id: 'other', digest: digestA } }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ provider: { id: provider.id, digest: digestB } }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ operationId: 'run-2:verify' }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ contractDigest: digestC }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ inputDigests: [digestD, digestC] }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ inputDigests: [digestC] }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ outputDigests: [digestD] }), expectation).verdict,
    'invalid',
  )
  assert.equal(
    validatePublicReceipt(sealedReceipt({ outputDigests: [digestE, digestD] }), expectation).verdict,
    'invalid',
  )
})

void test('a receipt sealed in the wrong digest domain or tampered after sealing is invalid', () => {
  const payload = receiptPayload()
  const wrongDomain = { ...payload, digest: computeDigest('evidence', payload) }
  assert.equal(validatePublicReceipt(wrongDomain, expectation).verdict, 'invalid')

  const tampered = clone(sealedReceipt())
  ;(tampered.criteria[0] as { reason: string }).reason = 'tampered after sealing'
  assert.equal(validatePublicReceipt(tampered, expectation).verdict, 'invalid')
})

void test('metric and score are finite, only on pass/fail, and score requires metric', () => {
  assert.throws(() =>
    sealPublicReceipt(
      receiptPayload({
        criteria: [
          {
            id: 'criterion-a',
            verdict: 'pass',
            reason: 'Non-finite public metric.',
            metric: { name: 'accuracy', unit: 'ratio', value: Number.NaN },
          },
          passingCriteria[1],
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealPublicReceipt(
      receiptPayload({
        criteria: [
          {
            id: 'criterion-a',
            verdict: 'pass',
            reason: 'Infinite public metric.',
            metric: { name: 'accuracy', unit: 'ratio', value: Number.POSITIVE_INFINITY },
          },
          passingCriteria[1],
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealPublicReceipt(
      receiptPayload({
        criteria: [
          { id: 'criterion-a', verdict: 'pass', reason: 'Score without a metric.', score: 1 },
          passingCriteria[1],
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealPublicReceipt(
      receiptPayload({
        criteria: [
          {
            id: 'criterion-a',
            verdict: 'invalid',
            reason: 'Invalid criteria must not carry public scores.',
            metric: { name: 'accuracy', unit: 'ratio', value: 0 },
            score: 0,
          },
          passingCriteria[1],
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealPublicReceipt(
      receiptPayload({
        criteria: [
          {
            id: 'criterion-a',
            verdict: 'pass',
            reason: 'Empty metric identity.',
            metric: { name: '', unit: '', value: 1 },
          },
          passingCriteria[1],
        ],
      }),
    ),
  )
  assert.throws(() =>
    sealPublicReceipt(
      receiptPayload({
        criteria: [
          { id: 'criterion-a', verdict: 'pass' } as PublicCriterionResult,
          passingCriteria[1],
        ],
      }),
    ),
  )
})

void test('non-finite numbers are rejected by the validator as invalid even when hand-crafted', () => {
  const payload = receiptPayload()
  const malformed = {
    ...payload,
    criteria: [
      {
        id: 'criterion-a',
        verdict: 'pass',
        reason: 'Non-finite public metric.',
        metric: { name: 'accuracy', unit: 'ratio', value: Number.NaN },
      },
      passingCriteria[1],
    ],
    digest: digestA,
  }
  assert.equal(validatePublicReceipt(malformed, expectation).verdict, 'invalid')
})

void test('a missing or duplicated required criterion and unknown criterion are invalid', () => {
  const missing = validatePublicReceipt(
    sealedReceipt({ criteria: [passingCriteria[1]] }),
    expectation,
  )
  assert.equal(missing.verdict, 'invalid')

  const duplicated = validatePublicReceipt(
    {
      ...receiptPayload({
        criteria: [passingCriteria[0], passingCriteria[0]],
      }),
      digest: digestA,
    },
    expectation,
  )
  assert.equal(duplicated.verdict, 'invalid')

  const unknown = validatePublicReceipt(
    sealedReceipt({
      criteria: [
        ...passingCriteria,
        { id: 'criterion-unknown', verdict: 'pass', reason: 'Unknown public criterion.' },
      ],
    }),
    expectation,
  )
  assert.equal(unknown.verdict, 'invalid')
})

void test('receipt strictness rejects unknown fields, bad versions, and malformed exits', () => {
  const withVerdict = { ...receiptPayload(), verdict: 'verified' }
  assert.throws(() => sealPublicReceipt(withVerdict))

  const withExtra = { ...receiptPayload(), at: 1 }
  assert.throws(() => sealPublicReceipt(withExtra))

  const wrongVersion = { ...receiptPayload(), v: 2 }
  assert.throws(() => sealPublicReceipt(wrongVersion))

  assert.throws(() => sealPublicReceipt(receiptPayload({ exit: { code: null, signal: null } })))

  assert.throws(() => sealPublicReceipt(receiptPayload({ exit: { code: 0, signal: 'SIGTERM' } })))
})

void test('parseProtocolValue keeps receipt input and output canonical', () => {
  const receipt = parseProtocolValue(publicReceiptSchema, sealedReceipt())
  assert.equal(receipt.digest, sealedReceipt().digest)
})
