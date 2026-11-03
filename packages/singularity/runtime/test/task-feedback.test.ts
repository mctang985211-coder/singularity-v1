import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalize, computeDigest, parseJsonText, sealTaskContract, taskFeedbackInputSchema } from '@singularity/protocol'
import type { JsonValue, Ref, TaskContract, TaskFeedbackInput, TaskRunState } from '@singularity/protocol'

import { createSchedulerFeedback, createTaskFeedback, readDirectFeedback } from '../src/task-feedback.ts'
import type { CasObjectReader, CasObjectWriter } from '../src/workspace.ts'

const digest = `sha256:${'a'.repeat(64)}`
const ref = { id: 'fixture', digest }

function contract(taskId: string, parentId?: string): TaskContract {
  return sealTaskContract({
    v: 1,
    taskId,
    spec: { goal: { summary: 'Local goal', deliverable: 'Result', scope: [], constraints: [] }, criteria: [], inputs: [], outputs: [] },
    origin: parentId === undefined ? { kind: 'root', purpose: 'work', requestRef: ref }
      : { kind: 'child', parentId, parentRunId: 'parent-run', batchId: 'batch', bindingId: 'binding' },
    method: ref,
    template: ref,
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: ref,
    environment: { seed: ref, profile: ref },
    limits: { maxRuns: 1, maxStepsPerRun: 10, maxTokens: 1000, deadlineAt: 1000, maxDepth: 3, maxTasks: 8, maxBatchChildren: 3 },
  })
}

function memoryCas(): CasObjectReader & CasObjectWriter {
  const values = new Map<string, Uint8Array>()
  return {
    putObject(id, bytes) {
      const stored = { id, digest: computeDigest('object', parseJsonText(new TextDecoder().decode(bytes))) }
      values.set(stored.digest, bytes)
      return Promise.resolve(stored)
    },
    readObject(object) {
      const bytes = values.get(object.digest)
      assert.ok(bytes)
      return Promise.resolve({ bytes })
    },
  }
}

const suggestion: TaskFeedbackInput = {
  kind: 'input-invalid', summary: 'Need a complete input.',
  proposedChanges: [{ field: 'inputs', suggestion: 'Supply the missing public document.' }], refs: [],
}

void test('worker feedback derives direct-parent identity, preserves suggestions, and authorizes refs', async () => {
  const cas = memoryCas()
  const child = contract('child', 'parent')
  const feedbackRef = await createTaskFeedback({ contract: child, runId: 'child-run', callId: 'call-1', input: suggestion, createdAt: 10, writer: cas })
  const feedback = parseJsonText(new TextDecoder().decode((await cas.readObject(feedbackRef)).bytes))
  assert.equal(canonicalize(feedback), canonicalize({
    ...suggestion, v: 1, id: 'feedback:child-run:call-1', source: 'child-worker', sourceTaskId: 'child',
    sourceRunId: 'child-run', directParentTaskId: 'parent', sourceContract: child.digest, createdAt: 10,
  }))
  await assert.rejects(createTaskFeedback({ contract: contract('root'), runId: 'root-run', callId: 'bad', input: suggestion, createdAt: 10, writer: cas }), /direct parent/)
  await assert.rejects(createTaskFeedback({ contract: child, runId: 'child-run', callId: 'bad-ref', input: { ...suggestion, refs: [ref] }, createdAt: 10, writer: cas }), /public objects owned/)
  assert.equal(taskFeedbackInputSchema.safeParse({ ...suggestion, source: 'scheduler' }).success, false)
  assert.equal(taskFeedbackInputSchema.safeParse({ ...suggestion, directParentTaskId: 'grandparent' }).success, false)
})

void test('closed source refs expose feedback only to the direct parent, including scheduler results', async () => {
  const cas = memoryCas()
  const parent = contract('parent')
  const child = contract('child', 'parent')
  const refs = [
    await createTaskFeedback({ contract: child, runId: 'child-run', callId: 'call', input: suggestion, createdAt: 10, writer: cas }),
    await createSchedulerFeedback({ contract: child, runId: 'child-run', reason: 'no-submission', resultRef: ref, createdAt: 11, writer: cas }),
  ]
  const tasks = new Map([
    ['parent', { taskId: 'parent', contract: parent, childIds: ['child'], runIds: ['parent-run'] }],
    ['child', { taskId: 'child', contract: child, childIds: [], runIds: ['child-run'] }],
    ['unrelated', { taskId: 'unrelated', contract: contract('unrelated'), childIds: [], runIds: [] }],
  ])
  const state = {
    tasks,
    runs: new Map([['child-run', { runId: 'child-run', closed: { source: 'run/closed', feedbackRefs: refs } }]]),
  } as unknown as TaskRunState
  const first = await readDirectFeedback({ state, parentTaskId: 'parent', reader: cas, page: 1 })
  assert.ok(first.nextCursor)
  assert.equal((first.data as JsonValue[]).length, 1)
  const second = await readDirectFeedback({ state, parentTaskId: 'parent', reader: cas, cursor: first.nextCursor })
  assert.equal(canonicalize(second.data).includes('scheduler'), true)
  assert.deepEqual((second.data as { feedback: { refs: Ref[] } }[])[0]?.feedback.refs, [ref])
  assert.deepEqual((await readDirectFeedback({ state, parentTaskId: 'unrelated', reader: cas })).data, [])
  await assert.rejects(readDirectFeedback({ state, parentTaskId: 'parent', reader: cas, cursor: 'feedback:unrelated:1' }), /cursor/)
})
