import assert from 'node:assert/strict'
import test from 'node:test'

import { parseProtocolValue } from '../src/schema.ts'
import {
  decomposeCommitChildSchema,
  decomposeCommitSchema,
  decomposeInputSchema,
  decomposePrepareSchema,
  taskExampleSchema,
  taskProposalSchema,
} from '../src/task.ts'
import type {
  DecomposeCommit,
  DecomposeInput,
  DecomposePrepare,
  TaskExample,
  TaskProposal,
} from '../src/task.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

function ref(id: string, digest = digestA): { id: string; digest: string } {
  return { id, digest }
}

const goal = {
  summary: 'Simulate a 4-bit unsigned adder',
  deliverable: 'sim-result.json and the complete simulation log',
  scope: ['single combinational module', 'functional simulation'],
  constraints: ['treat the RTL as a read-only input', 'cover every input combination'],
}

const baseProposal: TaskProposal = {
  goal,
  acceptanceCriteria: [
    { id: 'traceable', statement: 'Results should be traceable to this input' },
  ],
  inputs: [
    {
      id: 'rtl',
      object: ref('object-rtl', digestB),
      path: 'inputs/rtl.sv',
      access: 'read',
    },
  ],
  localOutputs: [
    { id: 'log', path: 'result.log', kind: 'file', description: 'supporting execution log' },
  ],
}

function firstAcceptanceCriterion(proposal: TaskProposal) {
  const first = proposal.acceptanceCriteria?.[0]
  if (first === undefined) throw new Error('expected a local criterion')
  return first
}

function firstInput(proposal: TaskProposal) {
  return proposal.inputs[0]
}

function firstLocalOutput(proposal: TaskProposal) {
  const first = proposal.localOutputs?.[0]
  if (first === undefined) throw new Error('expected a local output')
  return first
}

const forbiddenProposalFields: readonly (readonly [string, unknown])[] = [
  ['method', ref('method-1')],
  ['template', ref('template-1')],
  ['resources', { baseTools: [], skills: [], mcpServers: [] }],
  ['acceptance', ref('acceptance-1')],
  ['environment', { seed: ref('seed-1'), profile: ref('profile-1') }],
  ['limits', { maxRuns: 1, maxStepsPerRun: 1, maxTokens: 1, deadlineAt: 1, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 }],
  ['origin', { kind: 'root', purpose: 'work', requestRef: ref('request-1') }],
  ['taskId', 'task-1'],
  ['parentId', 'task-parent'],
  ['parentRunId', 'run-parent'],
  ['batchId', 'batch-1'],
  ['bindingId', 'binding-1'],
  ['join', 'required'],
  ['required', true],
  ['role', 'deliverable'],
  ['acceptancePolicy', ref('acceptance-policy-1')],
  ['verifier', 'model-verifier'],
  ['scorer', 'model-scorer'],
  ['supersedesChildIds', ['child-1']],
  ['feedbackRef', ref('feedback-1')],
  ['digest', digestA],
  ['criteria', [{ id: 'criterion-1', statement: 'model-supplied acceptance', required: true }]],
]

const proposalUnknownFields: readonly {
  readonly label: string
  readonly mutate: (proposal: TaskProposal) => void
}[] = [
  {
    label: 'unknown goal field',
    mutate: proposal => { (proposal.goal as unknown as Record<string, unknown>)['unexpected'] = true },
  },
  {
    label: 'unknown acceptanceCriterion field',
    mutate: proposal => {
      (firstAcceptanceCriterion(proposal) as unknown as Record<string, unknown>)['unexpected'] = true
    },
  },
  {
    label: 'unknown input field',
    mutate: proposal => { (firstInput(proposal) as unknown as Record<string, unknown>)['unexpected'] = true },
  },
  {
    label: 'unknown input object field',
    mutate: proposal => {
      (firstInput(proposal).object as unknown as Record<string, unknown>)['unexpected'] = true
    },
  },
  {
    label: 'unknown localOutput field',
    mutate: proposal => {
      (firstLocalOutput(proposal) as unknown as Record<string, unknown>)['unexpected'] = true
    },
  },
]

void test('TaskProposal accepts a complete proposal and a minimal proposal', () => {
  assert.deepEqual(parseProtocolValue(taskProposalSchema, baseProposal), baseProposal)

  const minimal: TaskProposal = { goal, inputs: [] }
  const parsed = parseProtocolValue(taskProposalSchema, minimal)
  assert.deepEqual(parsed, minimal)
  assert.equal('acceptanceCriteria' in parsed, false)
  assert.equal('localOutputs' in parsed, false)
})

void test('TaskProposal rejects every model-supplied binding, authority, and acceptance field', () => {
  for (const [field, value] of forbiddenProposalFields) {
    assert.throws(
      () => parseProtocolValue(taskProposalSchema, { ...baseProposal, [field]: value }),
      field,
    )
  }
})

void test('TaskProposal rejects unknown fields at every nested level', () => {
  for (const { label, mutate } of proposalUnknownFields) {
    const proposal = structuredClone(baseProposal)
    mutate(proposal)
    assert.throws(() => parseProtocolValue(taskProposalSchema, proposal), label)
  }
})

void test('localOutputs cannot carry role or required, even supporting and optional', () => {
  const localOutput = {
    id: 'log',
    path: 'result.log',
    kind: 'file' as const,
    description: 'supporting execution log',
  }
  for (const extra of [
    { role: 'supporting', required: false },
    { role: 'supporting' },
    { required: false },
    { role: 'deliverable', required: true },
  ]) {
    assert.throws(
      () => parseProtocolValue(taskProposalSchema, {
        ...baseProposal,
        localOutputs: [{ ...localOutput, ...extra }],
      }),
      JSON.stringify(extra),
    )
  }
})

void test('local values keep the frozen value constraints', () => {
  assert.throws(
    () => parseProtocolValue(taskProposalSchema, {
      ...baseProposal,
      localOutputs: [{ ...firstLocalOutput(baseProposal), kind: 'directory' }],
    }),
  )
  assert.throws(
    () => parseProtocolValue(taskProposalSchema, {
      ...baseProposal,
      inputs: [{ ...firstInput(baseProposal), access: 'write' }],
    }),
  )
})

void test('TaskExample is derived from TaskProposal with embedded example inputs', () => {
  const example: TaskExample = {
    goal,
    acceptanceCriteria: baseProposal.acceptanceCriteria,
    inputs: [
      {
        id: 'rtl-example',
        exampleText: 'module add4(input [3:0] a,b,output [3:0] sum,output carry); assign {carry,sum}=a+b; endmodule',
      },
    ],
    localOutputs: baseProposal.localOutputs,
  }

  assert.deepEqual(parseProtocolValue(taskExampleSchema, example), example)

  assert.throws(
    () => parseProtocolValue(taskProposalSchema, {
      ...baseProposal,
      inputs: [{ id: 'rtl-example', exampleText: 'module add4; endmodule' }],
    }),
  )
  assert.throws(
    () => parseProtocolValue(taskExampleSchema, {
      ...example,
      inputs: [{ id: 'rtl', object: ref('object-rtl'), path: 'inputs/rtl.sv', access: 'read' }],
    }),
  )
})

void test('TaskExample rejects unknown fields, fake refs, and missing example text', () => {
  const example: TaskExample = {
    goal,
    acceptanceCriteria: baseProposal.acceptanceCriteria,
    inputs: [{ id: 'rtl-example', exampleText: 'module add4; endmodule' }],
    localOutputs: baseProposal.localOutputs,
  }

  for (const [field, value] of forbiddenProposalFields) {
    assert.throws(
      () => parseProtocolValue(taskExampleSchema, { ...example, [field]: value }),
      field,
    )
  }

  for (const invalid of [
    { ...example, inputs: [{ id: 'rtl-example', exampleText: 'x', digest: digestA }] },
    { ...example, inputs: [{ id: 'rtl-example' }] },
    { ...example, inputs: [{ id: 'rtl-example', exampleText: 'x', object: ref('object-rtl') }] },
    { ...example, inputs: [{ id: 'rtl-example', exampleText: 'x', path: 'inputs/rtl.sv' }] },
    { ...example, inputs: [{ id: 'rtl-example', exampleText: 'x', access: 'read' }] },
  ]) {
    assert.throws(() => parseProtocolValue(taskExampleSchema, invalid))
  }
})

const prepare: DecomposePrepare = { action: 'prepare', bindingId: 'functional-simulation' }

const commitChild = {
  bindingId: 'functional-simulation',
  ackPreview: digestA,
  task: baseProposal,
}

const commit: DecomposeCommit = {
  action: 'commit',
  children: [commitChild],
}

const contractShapedTask = {
  ...baseProposal,
  v: 1,
  taskId: 'task-child',
  origin: {
    kind: 'child',
    parentId: 'task-parent',
    parentRunId: 'run-parent',
    batchId: 'batch-1',
    bindingId: 'functional-simulation',
  },
  method: ref('method-1'),
  template: ref('template-1'),
  resources: { baseTools: [], skills: [], mcpServers: [] },
  acceptance: ref('acceptance-1'),
  environment: { seed: ref('seed-1'), profile: ref('profile-1') },
  limits: { maxRuns: 1, maxStepsPerRun: 1, maxTokens: 1, deadlineAt: 1, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 },
}

void test('decompose prepare and commit inputs accept their frozen shapes', () => {
  assert.deepEqual(parseProtocolValue(decomposePrepareSchema, prepare), prepare)
  assert.deepEqual(parseProtocolValue(decomposeCommitSchema, commit), commit)
  assert.deepEqual(parseProtocolValue(decomposeCommitChildSchema, commitChild), commitChild)

  const prepareInput: DecomposeInput = prepare
  const commitInput: DecomposeInput = commit
  assert.deepEqual(parseProtocolValue(decomposeInputSchema, prepareInput), prepareInput)
  assert.deepEqual(parseProtocolValue(decomposeInputSchema, commitInput), commitInput)

  const ordered: DecomposeCommit = {
    action: 'commit',
    children: [
      commitChild,
      { bindingId: 'second-binding', ackPreview: digestB, task: { goal, inputs: [] } },
    ],
  }
  assert.deepEqual(parseProtocolValue(decomposeInputSchema, ordered), ordered)
})

void test('decompose prepare rejects unknown, missing, and commit-only fields', () => {
  for (const invalid of [
    { action: 'prepare' },
    { action: 'prepare', bindingId: 'binding-1', children: [] },
    { action: 'prepare', bindingId: 'binding-1', task: baseProposal },
    { action: 'prepare', bindingId: 'binding-1', taskId: 'task-1' },
    { action: 'prepare', bindingId: 'binding-1', method: ref('method-1') },
    { action: 'prepare', bindingId: 'binding-1', join: 'required' },
    { action: 'prepare', bindingId: 'binding-1', required: true },
    { action: 'spawn', bindingId: 'binding-1' },
  ]) {
    assert.throws(() => parseProtocolValue(decomposeInputSchema, invalid))
  }
})

void test('decompose commit rejects unknown, missing, and prepare-only fields', () => {
  for (const invalid of [
    { action: 'commit' },
    { action: 'commit', children: {} },
    { action: 'commit', children: [], bindingId: 'binding-1' },
    { action: 'commit', children: [], join: 'required' },
    { action: 'commit', children: [], task: baseProposal },
    { action: 'commit', children: [], method: ref('method-1') },
    { action: 'prepare', children: [commitChild] },
  ]) {
    assert.throws(() => parseProtocolValue(decomposeInputSchema, invalid))
  }
})

void test('decompose commit children are strict and must not supply authority fields', () => {
  for (const invalid of [
    { action: 'commit', children: [{ ackPreview: digestA, task: baseProposal }] },
    { action: 'commit', children: [{ bindingId: 'binding-1', task: baseProposal }] },
    { action: 'commit', children: [{ bindingId: 'binding-1', ackPreview: digestA }] },
    { action: 'commit', children: [{ ...commitChild, join: 'required' }] },
    { action: 'commit', children: [{ ...commitChild, required: true }] },
    { action: 'commit', children: [{ ...commitChild, role: 'supporting' }] },
    { action: 'commit', children: [{ ...commitChild, taskId: 'task-1' }] },
    { action: 'commit', children: [{ ...commitChild, parentId: 'task-parent' }] },
    { action: 'commit', children: [{ ...commitChild, parentRunId: 'run-parent' }] },
    { action: 'commit', children: [{ ...commitChild, batchId: 'batch-1' }] },
    { action: 'commit', children: [{ ...commitChild, method: ref('method-1') }] },
    { action: 'commit', children: [{ ...commitChild, template: ref('template-1') }] },
    { action: 'commit', children: [{ ...commitChild, resources: { baseTools: [], skills: [], mcpServers: [] } }] },
    { action: 'commit', children: [{ ...commitChild, acceptance: ref('acceptance-1') }] },
    { action: 'commit', children: [{ ...commitChild, environment: { seed: ref('seed-1'), profile: ref('profile-1') } }] },
    { action: 'commit', children: [{ ...commitChild, limits: { maxRuns: 1, maxStepsPerRun: 1, maxTokens: 1, deadlineAt: 1, maxDepth: 1, maxTasks: 1, maxBatchChildren: 1 } }] },
    { action: 'commit', children: [{ ...commitChild, digest: digestA }] },
    { action: 'commit', children: [{ ...commitChild, supersedesChildIds: [] }] },
    { action: 'commit', children: [{ ...commitChild, feedbackRef: ref('feedback-1') }] },
  ]) {
    assert.throws(() => parseProtocolValue(decomposeInputSchema, invalid))
  }
})

void test('decompose commit rejects malformed ackPreview values', () => {
  for (const ackPreview of [
    `sha256:${'A'.repeat(64)}`,
    'sha256:',
    'preview-object',
    ref('preview-object'),
    null,
    1,
  ]) {
    assert.throws(
      () => parseProtocolValue(decomposeInputSchema, {
        action: 'commit',
        children: [{ ...commitChild, ackPreview }],
      }),
    )
  }
})

void test('decompose commit accepts only TaskProposal, never a complete TaskContract', () => {
  assert.throws(
    () => parseProtocolValue(decomposeInputSchema, {
      action: 'commit',
      children: [{ ...commitChild, task: contractShapedTask }],
    }),
  )

  const exampleTask = {
    ...baseProposal,
    inputs: [{ id: 'rtl-example', exampleText: 'module add4; endmodule' }],
  }
  assert.throws(
    () => parseProtocolValue(decomposeInputSchema, {
      action: 'commit',
      children: [{ ...commitChild, task: exampleTask }],
    }),
  )

  for (const localOutput of [
    { ...firstLocalOutput(baseProposal), role: 'supporting', required: false },
    { ...firstLocalOutput(baseProposal), role: 'supporting' },
    { ...firstLocalOutput(baseProposal), required: false },
  ]) {
    assert.throws(
      () => parseProtocolValue(decomposeInputSchema, {
        action: 'commit',
        children: [{
          ...commitChild,
          task: { ...baseProposal, localOutputs: [localOutput] },
        }],
      }),
    )
  }

  assert.throws(
    () => parseProtocolValue(decomposeInputSchema, {
      action: 'commit',
      children: [{
        ...commitChild,
        task: { ...baseProposal, criteria: [{ id: 'c', statement: 's', required: true }] },
      }],
    }),
  )
})
