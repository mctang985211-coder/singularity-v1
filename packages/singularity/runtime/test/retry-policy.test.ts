import assert from 'node:assert/strict'
import test from 'node:test'

import { decideRetryPolicy } from '@singularity/protocol'
import type { RetryPolicyInput } from '@singularity/protocol'

const base: RetryPolicyInput = {
  runPhase: 'closed',
  closure: {
    classification: 'failed',
    reason: 'no-submission',
    source: 'run/closed',
    factDigest: `sha256:${'a'.repeat(64)}`,
    usage: { inputTokens: 10, outputTokens: 5, steps: 1, unknownRequests: 0 },
  },
  runCount: 1,
  maxRuns: 2,
  maxTokens: 1000,
  deadlineAt: 10_000,
  now: 1000,
  usageTokens: 15,
  usageUnknown: false,
}

void test('failed Runs retry only within maxRuns, deadline, and known token budget', () => {
  assert.equal(decideRetryPolicy(base, []).allowed, true)
  assert.equal(decideRetryPolicy({ ...base, runCount: 2 }, []).allowed, false)
  assert.equal(decideRetryPolicy({ ...base, now: 10_000 }, []).allowed, false)
  assert.equal(decideRetryPolicy({ ...base, usageUnknown: true }, []).allowed, false)
  assert.equal(decideRetryPolicy({ ...base, usageTokens: 1000 }, []).allowed, false)
})

void test('invalid Runs require a pre-listed transient reason; verified and cancelled never retry', () => {
  const invalid: RetryPolicyInput = {
    ...base,
    closure: {
      classification: 'invalid',
      reason: 'verifier-timeout',
      source: 'run/closed',
      factDigest: `sha256:${'b'.repeat(64)}`,
      usage: { inputTokens: 1, outputTokens: 0, steps: 1, unknownRequests: 0 },
    },
  }
  assert.equal(decideRetryPolicy(invalid, []).allowed, false)
  assert.equal(decideRetryPolicy(invalid, ['verifier-timeout']).allowed, true)

  for (const classification of ['verified', 'cancelled'] as const) {
    const decision = decideRetryPolicy({
      ...base,
      closure: {
        classification,
        reason: classification,
        source: 'run/closed',
        factDigest: base.closure?.factDigest ?? `sha256:${'c'.repeat(64)}`,
        usage: { inputTokens: 1, outputTokens: 0, steps: 1, unknownRequests: 0 },
      },
    }, ['verifier-timeout'])
    assert.equal(decision.allowed, false)
  }

  assert.equal(decideRetryPolicy({
    ...base,
    closure: {
      classification: 'failed',
      reason: 'subtree',
      source: 'subtree-cancellation',
      factDigest: `sha256:${'d'.repeat(64)}`,
    },
  }, []).allowed, false)
})
