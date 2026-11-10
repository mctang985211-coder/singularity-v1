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
}

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

void test('explicit blocked handback ends retries; ordinary unsolved work still retries', () => {
  assert.ok(base.closure?.source === 'run/closed')
  assert.equal(decideRetryPolicy({ ...base, closure: { ...base.closure, reason: 'blocked' } }, []).allowed, false)
  assert.equal(decideRetryPolicy({ ...base, closure: { ...base.closure, reason: 'unsolved' } }, []).allowed, true)
})
