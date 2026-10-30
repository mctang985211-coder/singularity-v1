import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeSingleRun,
  initialContextEpoch,
  verifyRunSubmission,
} from '../src/index.ts'

void test('single-run runtime exports the shared execution surface', () => {
  assert.equal(typeof executeSingleRun, 'function')
  assert.equal(typeof verifyRunSubmission, 'function')

  const first = initialContextEpoch('session-a')
  assert.equal(first, initialContextEpoch('session-a'))
  assert.notEqual(first, initialContextEpoch('session-b'))
})
