import assert from 'node:assert/strict'
import test from 'node:test'

import type { JsonObject,JsonValue } from '@singularity/protocol'
import { decomposeCommitSchema,parseProtocolValue,validateInstanceSchema } from '@singularity/protocol'

import { decomposeInputSchema,planningInputSchema,taskToolExamples } from '../src/task-tool-schema.ts'

void test('model-visible schemas accept structured checks and planning with root-resolved JSON references', () => {
  const commit = parseProtocolValue(decomposeCommitSchema, taskToolExamples.singularity_decompose)
  commit.children[0].task.acceptanceChecks[0].checks[0].params = {
    candidate: 'result/adapter', cases: [{ id: 'boundary', input: [1, 2], enabled: true }], threshold: null,
  }
  assert.deepEqual(validateInstanceSchema(decomposeInputSchema as JsonObject, commit as unknown as JsonValue), { valid: true })
  assert.deepEqual(validateInstanceSchema(planningInputSchema as JsonObject, taskToolExamples.singularity_plan), { valid: true })
  const { acceptanceChecks, ...task } = commit.children[0].task
  assert.equal(acceptanceChecks.length, 1)
  const missing = { ...commit, children: [{ ...commit.children[0], task }] }
  assert.equal(validateInstanceSchema(decomposeInputSchema as JsonObject, missing as unknown as JsonValue).valid, false)
})
