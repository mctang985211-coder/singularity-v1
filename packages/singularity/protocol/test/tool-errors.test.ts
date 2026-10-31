import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemainingBudgetPct,ToolError,ToolErrorCode } from '../src/errors.ts'
import {
TOOL_ERROR_CODES,
remainingBudgetPctSchema,
toolErrorCodeSchema,
toolErrorSchema,
} from '../src/errors.ts'
import * as protocol from '../src/index.ts'
import { parseProtocolValue } from '../src/schema.ts'

const EXPECTED_TOOL_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'READ_SELF_FIRST',
  'PLAN_FIRST',
  'PREVIEW_REQUIRED',
  'PREVIEW_STALE',
  'NEXT_STEP_REQUIRED',
  'CHILD_BATCH_ACTIVE',
  'REQUIRED_FEEDBACK_REPLAN',
  'INPUT_NOT_AUTHORIZED',
  'BINDING_FIXED',
  'LIMIT_EXCEEDED',
  'ALREADY_SUBMITTED',
  'RUN_CLOSED',
  'COMPOSITION_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
] as const

const budget: RemainingBudgetPct = {
  tokensPct: null,
  stepsPct: 100,
  wallClockPct: 0,
  depthPct: 42.5,
  taskSlotsPct: 7,
}

const toolError: ToolError = {
  code: 'INVALID_ARGUMENT',
  nextAction: 'Start with singularity_read(kind="self"), then retry with the documented fields.',
  remainingBudgetPct: budget,
}

void test('tool error codes match the declared set', () => {
  assert.equal(new Set(TOOL_ERROR_CODES).size, EXPECTED_TOOL_ERROR_CODES.length)
  assert.deepEqual([...TOOL_ERROR_CODES].sort(), [...EXPECTED_TOOL_ERROR_CODES].sort())

  for (const code of EXPECTED_TOOL_ERROR_CODES) {
    const parsed: ToolErrorCode = toolErrorCodeSchema.parse(code)
    assert.equal(parsed, code)
  }

  for (const invalid of ['ACTIVE_JOB', 'invalid_argument', 'INVALID-ARGUMENT', 'UNKNOWN', '']) {
    assert.equal(toolErrorCodeSchema.safeParse(invalid).success, false, invalid)
  }
})

void test('RemainingBudgetPct accepts nullable tokens and bounded percentages', () => {
  assert.deepEqual(remainingBudgetPctSchema.parse(budget), budget)
  assert.deepEqual(remainingBudgetPctSchema.parse({ ...budget, tokensPct: 0 }), {
    ...budget,
    tokensPct: 0,
  })
  assert.deepEqual(remainingBudgetPctSchema.parse({ ...budget, tokensPct: 100 }), {
    ...budget,
    tokensPct: 100,
  })
})

void test('remaining budget percentages reject values outside 0 through 100', () => {
  for (const invalid of [-1, 100.1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, stepsPct: invalid }))
    assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, tokensPct: invalid }))
    assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, wallClockPct: invalid }))
    assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, depthPct: invalid }))
    assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, taskSlotsPct: invalid }))
  }

  assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, tokensPct: '10' }))
  assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, stepsPct: null }))
  assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, wallClockPct: null }))
  assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, depthPct: null }))
  assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, taskSlotsPct: null }))
  assert.throws(() => remainingBudgetPctSchema.parse({ ...budget, extra: true }))
})

void test('the strict tool error schema carries code, nextAction, and remaining budget', () => {
  assert.deepEqual(toolErrorSchema.parse(toolError), toolError)
  assert.deepEqual(parseProtocolValue(toolErrorSchema, toolError), toolError)
  assert.equal(toolErrorSchema.parse(toolError).code, 'INVALID_ARGUMENT')
  assert.deepEqual(toolErrorSchema.parse(toolError).remainingBudgetPct, budget)
})

void test('tool errors reject unknown codes, unknown fields, and missing fields', () => {
  assert.throws(() => toolErrorSchema.parse({ ...toolError, code: 'INVALID' }))
  assert.throws(() => toolErrorSchema.parse({ ...toolError, code: 'invalid_argument' }))
  assert.throws(() => toolErrorSchema.parse({ ...toolError, extra: true }))
  assert.throws(() =>
    toolErrorSchema.parse({
      ...toolError,
      remainingBudgetPct: { ...budget, extra: true },
    }),
  )
  assert.throws(() =>
    toolErrorSchema.parse({
      code: 'INVALID_ARGUMENT',
      remainingBudgetPct: budget,
    }),
  )
  assert.throws(() =>
    toolErrorSchema.parse({
      code: 'INVALID_ARGUMENT',
      nextAction: 'Retry with the documented fields.',
    }),
  )
  assert.throws(() => toolErrorSchema.parse({ nextAction: 'Retry.', remainingBudgetPct: budget }))
  assert.throws(() =>
    toolErrorSchema.parse({
      code: 'INVALID_ARGUMENT',
      nextAction: 1,
      remainingBudgetPct: budget,
    }),
  )
})

void test('index preserves the existing surface and exposes the tool error contract', () => {
  const existing = [
    'canonicalize',
    'parseJsonText',
    'jsonValueSchema',
    'jsonObjectSchema',
    'DIGEST_DOMAINS',
    'digestDomainSchema',
    'digestSchema',
    'computeDigestBytes',
    'computeDigest',
    'seal',
    'verifyDigest',
    'closedObject',
    'parseProtocolValue',
    'protocolJsonSchema',
    'ProtocolSchemaError',
    'refSchema',
  ] as const

  for (const name of existing) {
    assert.ok(Object.hasOwn(protocol, name), `${name} must remain exported from the protocol index`)
  }

  assert.equal(protocol.TOOL_ERROR_CODES, TOOL_ERROR_CODES)
  assert.equal(protocol.remainingBudgetPctSchema, remainingBudgetPctSchema)
  assert.equal(protocol.toolErrorCodeSchema, toolErrorCodeSchema)
  assert.equal(protocol.toolErrorSchema, toolErrorSchema)
})
