import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, parseMethodPatch } from '../src/index.ts'

const patch = {
  v: 1, base: { id: 'method:base', digest: computeDigest('method', {}) },
  hypothesis: 'Keep the reusable result in a skill.',
  changes: [{ op: 'put-skill', skill: {
    id: 'skill:review', name: 'review', description: 'Review a bounded output.',
    files: { 'SKILL.md': '# Review\n\nRead the criteria and check the output.' },
  } }],
  predictedRisks: [], transferPlan: 'Evaluate on the frozen cases.',
}

void test('C-15 MethodPatch accepts only the defined reusable asset operations', () => {
  assert.deepEqual(parseMethodPatch(patch), patch)
  for (const op of ['edit-live-task', 'set-verifier', 'set-scorer', 'set-input', 'set-model', 'set-platform-prompt', 'run-evaluation', 'activate']) {
    assert.throws(() => parseMethodPatch({ ...patch, changes: [{ op, id: 'forbidden' }] }))
  }
  assert.throws(() => parseMethodPatch({ ...patch, score: 1 }))
  assert.throws(() => parseMethodPatch({ ...patch, changes: [{ ...patch.changes[0], digest: patch.base.digest }] }))
})

void test('MethodPatch caps operations and canonical UTF-8 bytes', () => {
  assert.throws(() => parseMethodPatch({ ...patch, changes: Array.from({ length: 65 }, () => ({ op: 'set-entry', templateId: null })) }))
  assert.throws(() => parseMethodPatch({ ...patch, hypothesis: '中'.repeat(100_000) }), /256 KiB/)
})
