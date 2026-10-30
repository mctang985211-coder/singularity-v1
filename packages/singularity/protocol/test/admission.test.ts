import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AdmissionError,
  MCP_DRAFTS_OUTPUT,
  SKILL_DRAFTS_OUTPUT,
  admitChildBatch,
  admitRootTask,
} from '../src/admission.ts'
import type {
  AdmittedChildBatch,
  ChildAdmissionRequest,
  ChildBatchAdmissionInput,
  RootAdmissionInput,
} from '../src/admission.ts'
import * as protocol from '../src/index.ts'
import { computeDigest } from '../src/digest.ts'
import type { Digest } from '../src/digest.ts'
import {
  sealMethodRevision,
} from '../src/method.ts'
import type { MethodRevision, TaskTemplate } from '../src/method.ts'
import {
  sealTaskContract,
  verifyTaskContract,
} from '../src/task.ts'
import type {
  InputRef,
  LocalOutput,
  OutputSpec,
  TaskContract,
  TaskContractPayload,
  TaskLimits,
  TaskProposal,
} from '../src/task.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`
const digestC = `sha256:${'c'.repeat(64)}`
const digestD = `sha256:${'d'.repeat(64)}`

function ref(id: string, digest: Digest = digestA): { id: string; digest: Digest } {
  return { id, digest }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

const goal = {
  summary: 'Implement one bounded part of the parent goal',
  deliverable: 'A frozen result and supporting log',
  scope: ['single bounded part', 'no parent changes'],
  constraints: ['use only authorized inputs', 'do not alter acceptance'],
}

const environment = { seed: ref('seed-1', digestB), profile: ref('profile-1', digestC) }
const childEnvironment = { seed: ref('child-seed-1', digestB), profile: ref('profile-1', digestC) }

const resources = {
  baseTools: [ref('tool-read', digestA)],
  skills: [ref('skill-1', digestB)],
  mcpServers: [ref('mcp-1', digestC)],
  exploration: ref('exploration-1', digestD),
}
const childResources = {
  baseTools: [ref('tool-read', digestA)],
  skills: [ref('skill-child', digestC)],
  mcpServers: [],
}

const parentLimits: TaskLimits = {
  maxRuns: 2,
  maxStepsPerRun: 20,
  maxTokens: 100_000,
  deadlineAt: 1_800_000_000_000,
  maxDepth: 3,
  maxTasks: 8,
  maxBatchChildren: 2,
}

const childLimits: TaskLimits = {
  maxRuns: 1,
  maxStepsPerRun: 10,
  maxTokens: 20_000,
  deadlineAt: 1_800_000_000_000,
  maxDepth: 2,
  maxTasks: 4,
  maxBatchChildren: 1,
}

const inputA: InputRef = {
  id: 'input-a',
  object: ref('object-a', digestB),
  path: 'inputs/a.txt',
  access: 'read',
}
const inputB: InputRef = {
  id: 'input-b',
  object: ref('object-b', digestC),
  path: 'inputs/b.txt',
  access: 'copy-to-work',
}

const childTemplate: TaskTemplate = {
  id: 'template-child',
  brief: 'Execute one bounded part and produce its evidence.',
  guidance: ref('guidance-child', digestA),
  example: ref('example-child', digestB),
  instanceSchema: { type: 'object', additionalProperties: false },
  requiredCriteria: [
    { id: 'required-a', statement: 'The required result is complete', required: true },
    { id: 'required-b', statement: 'The log is traceable', required: false },
  ],
  requiredOutputs: [
    { id: 'result', path: 'outputs/result.json', kind: 'file', role: 'deliverable', required: true },
    { id: 'trace', path: 'outputs/trace', kind: 'tree', role: 'supporting', required: false },
  ],
  acceptancePolicy: ref('acceptance-child', digestD),
  skills: ['skill-child'],
  tools: [],
  children: [],
}

const rootTemplate: TaskTemplate = {
  ...childTemplate,
  id: 'template-root',
  brief: 'Coordinate the bounded root work.',
  requiredCriteria: [],
  requiredOutputs: [],
  acceptancePolicy: ref('acceptance-root', digestA),
  children: [
    { bindingId: 'build-part', templateId: 'template-child', brief: 'Build one part.', join: 'required' },
    { bindingId: 'probe-part', templateId: 'template-child', brief: 'Probe one part.', join: 'probe' },
    { bindingId: 'third-part', templateId: 'template-child', brief: 'Build another part.', join: 'probe' },
  ],
}

const method: MethodRevision = sealMethodRevision({
  v: 1,
  id: 'method-admission',
  entryTemplateId: 'template-root',
  templates: [rootTemplate, childTemplate],
  skills: [],
  tools: [],
})

const methodRef = { id: method.id, digest: method.digest }
const rootTemplateRef = { id: rootTemplate.id, digest: method.digest }

const rootBaseOutputs: OutputSpec[] = [
  { id: 'root-result', path: 'root/result.json', kind: 'file', role: 'deliverable', required: true },
  { id: 'root-log', path: 'root/log', kind: 'tree', role: 'supporting', required: false },
]

const rootInput: RootAdmissionInput = {
  taskId: 'task-root',
  spec: {
    goal,
    criteria: [
      { id: 'root-required', statement: 'The root result is verified', required: true },
    ],
    localGuidance: [{ id: 'root-local', statement: 'Keep root notes with the result' }],
    inputs: [inputA, inputB],
    outputs: rootBaseOutputs,
  },
  origin: { kind: 'root', purpose: 'work', requestRef: ref('request-root', digestA) },
  method: methodRef,
  template: rootTemplateRef,
  resources,
  acceptance: ref('acceptance-root', digestA),
  environment,
  limits: parentLimits,
}

const childProposal: TaskProposal = {
  goal,
  localCriteria: [
    { id: 'local-first', statement: 'Keep local notes in proposal order' },
    { id: 'local-second', statement: 'Keep local notes separate from acceptance' },
  ],
  inputs: [inputA, inputB],
  localOutputs: [
    { id: 'local-log', path: 'local/run.log', kind: 'file', description: 'Supporting execution log' },
    { id: 'local-notes', path: 'local/notes', kind: 'tree', description: 'Supporting notes' },
  ],
}

function parentContract(): TaskContract {
  return admitRootTask(rootInput)
}

function childBatchInput(): ChildBatchAdmissionInput {
  return {
    parent: parentContract(),
    method,
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    children: [
      {
        bindingId: 'build-part',
        taskId: 'task-child-1',
        authorizedInputs: [inputA, inputB],
        proposal: childProposal,
        resources: childResources,
        environment: childEnvironment,
        limits: childLimits,
      },
    ],
  }
}

function admissionError(code: AdmissionError['code']) {
  return (error: unknown): true => {
    assert.ok(error instanceof AdmissionError, `expected AdmissionError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  }
}

function firstChild(batch: AdmittedChildBatch) {
  const child = batch.children.at(0)
  if (child === undefined) throw new Error('expected one admitted child')
  return child
}

function childRequest(input: ChildBatchAdmissionInput): ChildAdmissionRequest {
  const request = input.children.at(0)
  if (request === undefined) throw new Error('expected one child request')
  return request
}

function rootInputRecord(input: RootAdmissionInput): Record<string, unknown> {
  return input as unknown as Record<string, unknown>
}

function childBatchInputRecord(input: ChildBatchAdmissionInput): Record<string, unknown> {
  return input as unknown as Record<string, unknown>
}

void test('protocol index exports the admission surface alongside existing modules', () => {
  assert.equal(protocol.admitRootTask, admitRootTask)
  assert.equal(protocol.admitChildBatch, admitChildBatch)
  assert.equal(protocol.AdmissionError, AdmissionError)
  assert.equal(protocol.SKILL_DRAFTS_OUTPUT, SKILL_DRAFTS_OUTPUT)
  assert.equal(protocol.MCP_DRAFTS_OUTPUT, MCP_DRAFTS_OUTPUT)
  assert.equal(typeof protocol.replayJournal, 'function')
})

void test('root admission appends fixed drafts last and seals a verifiable contract', () => {
  const input = clone(rootInput)
  const contract = admitRootTask(input)

  assert.equal(verifyTaskContract(contract), true)
  assert.equal(contract.digest, computeDigest('contract', (() => {
    const { digest, ...body } = contract
    void digest
    return body
  })()))
  assert.equal(contract.taskId, 'task-root')
  assert.deepEqual(contract.origin, rootInput.origin)
  assert.deepEqual(contract.method, methodRef)
  assert.deepEqual(contract.template, rootTemplateRef)
  assert.deepEqual(contract.spec.inputs, [inputA, inputB])
  assert.deepEqual(contract.spec.criteria, rootInput.spec.criteria)
  assert.deepEqual(contract.spec.localGuidance, rootInput.spec.localGuidance)
  assert.deepEqual(contract.spec.outputs, [
    ...rootBaseOutputs,
    SKILL_DRAFTS_OUTPUT,
    MCP_DRAFTS_OUTPUT,
  ])
  assert.deepEqual(SKILL_DRAFTS_OUTPUT, {
    id: '__skill-drafts',
    path: 'learning-drafts/skills',
    kind: 'tree',
    role: 'skill-draft',
    required: false,
  })
  assert.deepEqual(MCP_DRAFTS_OUTPUT, {
    id: '__mcp-drafts',
    path: 'learning-drafts/mcp-servers',
    kind: 'tree',
    role: 'mcp-draft',
    required: false,
  })
  assert.deepEqual(input, rootInput)
})

void test('root admission preserves optional absence instead of adding defaults', () => {
  const input: RootAdmissionInput = {
    ...rootInput,
    resources: { baseTools: [], skills: [], mcpServers: [] },
    spec: {
      goal,
      criteria: [],
      inputs: [],
      outputs: rootBaseOutputs,
    },
  }
  const before = clone(input)
  const contract = admitRootTask(input)

  assert.equal('localGuidance' in contract.spec, false)
  assert.equal('exploration' in contract.resources, false)
  assert.deepEqual(input, before)
})

void test('root admission rejects duplicate and reserved output identities without partial output', () => {
  const cases: readonly {
    readonly label: string
    readonly outputs: OutputSpec[]
  }[] = [
    {
      label: 'duplicate id',
      outputs: [
        { id: 'same', path: 'a', kind: 'file', role: 'supporting', required: false },
        { id: 'same', path: 'b', kind: 'file', role: 'supporting', required: false },
      ],
    },
    {
      label: 'duplicate path',
      outputs: [
        { id: 'a', path: 'same', kind: 'file', role: 'supporting', required: false },
        { id: 'b', path: 'same', kind: 'file', role: 'supporting', required: false },
      ],
    },
    {
      label: 'reserved skill id',
      outputs: [{ id: '__skill-drafts', path: 'custom', kind: 'tree', role: 'supporting', required: false }],
    },
    {
      label: 'reserved mcp id',
      outputs: [{ id: '__mcp-drafts', path: 'custom', kind: 'tree', role: 'supporting', required: false }],
    },
    {
      label: 'reserved root path',
      outputs: [{ id: 'custom', path: 'learning-drafts', kind: 'tree', role: 'supporting', required: false }],
    },
    {
      label: 'reserved root path with slash',
      outputs: [{ id: 'custom', path: 'learning-drafts/', kind: 'tree', role: 'supporting', required: false }],
    },
    {
      label: 'reserved nested path',
      outputs: [{ id: 'custom', path: 'learning-drafts/skills/extra', kind: 'file', role: 'supporting', required: false }],
    },
    {
      label: 'draft role in base output',
      outputs: [{ id: 'custom', path: 'custom', kind: 'tree', role: 'skill-draft', required: false }],
    },
  ]

  for (const { label, outputs } of cases) {
    const input = clone(rootInput)
    input.spec.outputs = outputs
    assert.throws(
      () => admitRootTask(input),
      admissionError('INVALID_ARGUMENT'),
      label,
    )
    assert.deepEqual(input.spec.outputs, outputs)
  }
})

void test('root admission rejects duplicate criteria and input ids', () => {
  const duplicateCriteria = clone(rootInput)
  const criterion = duplicateCriteria.spec.criteria[0]
  duplicateCriteria.spec.criteria = [
    criterion,
    { ...criterion, statement: 'A second criterion with the same id' },
  ]
  assert.throws(() => admitRootTask(duplicateCriteria), admissionError('INVALID_ARGUMENT'))
  assert.deepEqual(duplicateCriteria.spec.criteria, [
    criterion,
    { ...criterion, statement: 'A second criterion with the same id' },
  ])

  const duplicateInputs = clone(rootInput)
  duplicateInputs.spec.inputs = [
    inputA,
    { ...inputA, path: 'inputs/a-second.txt' },
  ]
  assert.throws(() => admitRootTask(duplicateInputs), admissionError('INVALID_ARGUMENT'))
  assert.deepEqual(duplicateInputs.spec.inputs, [
    inputA,
    { ...inputA, path: 'inputs/a-second.txt' },
  ])
})

void test('root admission rejects inconsistent method/template refs and unknown fields', () => {
  const mismatchedTemplate = clone(rootInput)
  mismatchedTemplate.template = { ...mismatchedTemplate.template, digest: digestD }
  assert.throws(
    () => admitRootTask(mismatchedTemplate),
    admissionError('INVALID_ARGUMENT'),
  )

  const unknownTopLevel = rootInputRecord(clone(rootInput))
  unknownTopLevel['unexpected'] = true
  assert.throws(
    () => admitRootTask(unknownTopLevel as unknown as RootAdmissionInput),
    admissionError('INVALID_ARGUMENT'),
  )

  const unknownSpec = clone(rootInput) as unknown as Record<string, unknown>
  unknownSpec['spec'] = { ...rootInput.spec, unexpected: true }
  assert.throws(
    () => admitRootTask(unknownSpec as unknown as RootAdmissionInput),
    admissionError('INVALID_ARGUMENT'),
  )
})

void test('child admission merges template obligations, proposal guidance, and supporting outputs in order', () => {
  const input = childBatchInput()
  const before = clone(input)
  const batch = admitChildBatch(input)
  const child = firstChild(batch)

  assert.equal(batch.parentId, 'task-root')
  assert.equal(batch.parentRunId, 'run-root-1')
  assert.equal(batch.batchId, 'batch-1')
  assert.equal(child.bindingId, 'build-part')
  assert.equal(child.join, 'required')
  assert.equal('join' in child.contract, false)
  assert.equal(verifyTaskContract(child.contract), true)

  assert.equal(child.contract.taskId, 'task-child-1')
  assert.deepEqual(child.contract.origin, {
    kind: 'child',
    parentId: 'task-root',
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    bindingId: 'build-part',
  })
  assert.deepEqual(child.contract.method, methodRef)
  assert.deepEqual(child.contract.template, { id: 'template-child', digest: method.digest })
  assert.deepEqual(child.contract.acceptance, childTemplate.acceptancePolicy)
  assert.deepEqual(child.contract.resources, childResources)
  assert.deepEqual(child.contract.environment, childEnvironment)
  assert.deepEqual(child.contract.limits, childLimits)

  assert.deepEqual(child.contract.spec.criteria, childTemplate.requiredCriteria)
  assert.deepEqual(child.contract.spec.localGuidance, childProposal.localCriteria)
  assert.deepEqual(child.contract.spec.inputs, [inputA, inputB])
  assert.deepEqual(child.contract.spec.outputs, [
    ...childTemplate.requiredOutputs,
    { id: 'local-log', path: 'local/run.log', kind: 'file', role: 'supporting', required: false },
    { id: 'local-notes', path: 'local/notes', kind: 'tree', role: 'supporting', required: false },
    SKILL_DRAFTS_OUTPUT,
    MCP_DRAFTS_OUTPUT,
  ])
  assert.deepEqual(input, before)
})

void test('child admission accepts limits at the parent boundary and leaves maxRuns unconstrained', () => {
  const boundary = childBatchInput()
  const boundaryRequest = childRequest(boundary)
  boundaryRequest.limits = {
    maxRuns: parentLimits.maxRuns + 10,
    maxStepsPerRun: parentLimits.maxStepsPerRun,
    maxTokens: parentLimits.maxTokens,
    deadlineAt: parentLimits.deadlineAt,
    maxDepth: parentLimits.maxDepth - 1,
    maxTasks: parentLimits.maxTasks - 1,
    maxBatchChildren: parentLimits.maxBatchChildren,
  }
  const boundaryChild = firstChild(admitChildBatch(boundary))
  assert.deepEqual(boundaryChild.contract.limits, boundaryRequest.limits)

  const minimal = childBatchInput()
  const minimalRequest = childRequest(minimal)
  minimalRequest.limits = {
    maxRuns: 99,
    maxStepsPerRun: 0,
    maxTokens: 0,
    deadlineAt: 0,
    maxDepth: 0,
    maxTasks: 1,
    maxBatchChildren: 0,
  }
  const minimalChild = firstChild(admitChildBatch(minimal))
  assert.deepEqual(minimalChild.contract.limits, minimalRequest.limits)
})

void test('child admission rejects limits that exceed the parent without inventing a maxRuns rule', () => {
  const cases: readonly {
    readonly label: string
    readonly limits: TaskLimits
  }[] = [
    {
      label: 'deadline after parent',
      limits: { ...childLimits, deadlineAt: parentLimits.deadlineAt + 1 },
    },
    {
      label: 'maxDepth equal to parent',
      limits: { ...childLimits, maxDepth: parentLimits.maxDepth },
    },
    {
      label: 'maxDepth greater than parent',
      limits: { ...childLimits, maxDepth: parentLimits.maxDepth + 1 },
    },
    {
      label: 'maxTasks below one',
      limits: { ...childLimits, maxTasks: 0 },
    },
    {
      label: 'maxTasks equal to parent',
      limits: { ...childLimits, maxTasks: parentLimits.maxTasks },
    },
    {
      label: 'maxTasks greater than parent',
      limits: { ...childLimits, maxTasks: parentLimits.maxTasks + 1 },
    },
    {
      label: 'maxTokens greater than parent',
      limits: { ...childLimits, maxTokens: parentLimits.maxTokens + 1 },
    },
    {
      label: 'maxStepsPerRun greater than parent',
      limits: { ...childLimits, maxStepsPerRun: parentLimits.maxStepsPerRun + 1 },
    },
    {
      label: 'maxBatchChildren greater than parent',
      limits: { ...childLimits, maxBatchChildren: parentLimits.maxBatchChildren + 1 },
    },
  ]

  for (const { label, limits } of cases) {
    const input = childBatchInput()
    childRequest(input).limits = limits
    assert.throws(() => admitChildBatch(input), admissionError('LIMIT_EXCEEDED'), label)
  }
})

void test('child admission derives probe join from the fixed binding', () => {
  const input = childBatchInput()
  const request = childRequest(input)
  input.children = [{ ...request, bindingId: 'probe-part', taskId: 'task-child-probe' }]

  const child = firstChild(admitChildBatch(input))
  assert.equal(child.join, 'probe')
  assert.deepEqual(child.contract.origin, {
    kind: 'child',
    parentId: 'task-root',
    parentRunId: 'run-root-1',
    batchId: 'batch-1',
    bindingId: 'probe-part',
  })
})

void test('child admission rejects empty batches, duplicate bindings, oversized batches, and active batches', () => {
  const empty = childBatchInput()
  empty.children = []
  assert.throws(() => admitChildBatch(empty), admissionError('INVALID_ARGUMENT'))

  const duplicate = childBatchInput()
  const request = childRequest(duplicate)
  duplicate.children = [request, { ...request, taskId: 'task-child-2' }]
  assert.throws(() => admitChildBatch(duplicate), admissionError('INVALID_ARGUMENT'))

  const duplicateTask = childBatchInput()
  const taskRequest = childRequest(duplicateTask)
  duplicateTask.children = [
    { ...taskRequest, bindingId: 'build-part', taskId: 'task-duplicate' },
    { ...taskRequest, bindingId: 'probe-part', taskId: 'task-duplicate' },
  ]
  assert.throws(() => admitChildBatch(duplicateTask), admissionError('INVALID_ARGUMENT'))

  const oversized = childBatchInput()
  oversized.children = [
    { ...request, bindingId: 'build-part', taskId: 'task-child-1' },
    { ...request, bindingId: 'probe-part', taskId: 'task-child-2' },
    { ...request, bindingId: 'third-part', taskId: 'task-child-3' },
  ]
  assert.throws(() => admitChildBatch(oversized), admissionError('LIMIT_EXCEEDED'))

  const active = childBatchInput()
  active.activeBatch = { batchId: 'batch-active' }
  assert.throws(() => admitChildBatch(active), admissionError('CHILD_BATCH_ACTIVE'))

  assert.deepEqual(empty.children, [])
  assert.equal(duplicate.children.length, 2)
  assert.equal(oversized.children.length, 3)
})

void test('child admission rejects unauthorized or reordered inputs', () => {
  const cases: readonly {
    readonly label: string
    readonly mutate: (proposal: TaskProposal) => void
  }[] = [
    { label: 'missing input', mutate: proposal => { proposal.inputs = [inputA] } },
    { label: 'extra input', mutate: proposal => { proposal.inputs = [inputA, inputB, inputA] } },
    {
      label: 'modified object',
      mutate: proposal => {
        proposal.inputs = [{ ...inputA, object: ref('object-other', digestD) }, inputB]
      },
    },
    {
      label: 'modified access',
      mutate: proposal => {
        proposal.inputs = [{ ...inputA, access: 'copy-to-work' }, inputB]
      },
    },
    {
      label: 'modified path',
      mutate: proposal => {
        proposal.inputs = [{ ...inputA, path: 'inputs/other.txt' }, inputB]
      },
    },
    {
      label: 'reordered inputs',
      mutate: proposal => { proposal.inputs = [inputB, inputA] },
    },
  ]

  for (const { label, mutate } of cases) {
    const input = childBatchInput()
    const request = childRequest(input)
    const proposal = clone(request.proposal)
    mutate(proposal)
    request.proposal = proposal
    const before = clone(input)
    assert.throws(() => admitChildBatch(input), admissionError('INPUT_NOT_AUTHORIZED'), label)
    assert.deepEqual(input, before)
  }
})

void test('child admission rejects duplicate criteria and input ids', () => {
  const duplicateInputs = childBatchInput()
  const inputRequest = childRequest(duplicateInputs)
  const authorized = [inputA, { ...inputA, path: 'inputs/a-second.txt' }]
  inputRequest.authorizedInputs = authorized
  inputRequest.proposal = { ...inputRequest.proposal, inputs: authorized }
  assert.throws(() => admitChildBatch(duplicateInputs), admissionError('INVALID_ARGUMENT'))
  assert.deepEqual(inputRequest.authorizedInputs, authorized)

  const duplicateCriteriaTemplate: TaskTemplate = {
    ...childTemplate,
    requiredCriteria: [
      childTemplate.requiredCriteria[0],
      { ...childTemplate.requiredCriteria[0], statement: 'A second required criterion with the same id' },
    ],
  }
  const duplicateCriteriaMethod = sealMethodRevision({
    v: 1,
    id: 'method-duplicate-criteria',
    entryTemplateId: rootTemplate.id,
    templates: [rootTemplate, duplicateCriteriaTemplate],
    skills: [],
    tools: [],
  })
  const duplicateCriteriaParent = admitRootTask({
    ...rootInput,
    method: { id: duplicateCriteriaMethod.id, digest: duplicateCriteriaMethod.digest },
    template: { id: rootTemplate.id, digest: duplicateCriteriaMethod.digest },
  })
  const duplicateCriteriaInput: ChildBatchAdmissionInput = {
    ...childBatchInput(),
    parent: duplicateCriteriaParent,
    method: duplicateCriteriaMethod,
  }
  assert.throws(
    () => admitChildBatch(duplicateCriteriaInput),
    admissionError('INVALID_ARGUMENT'),
  )
})

void test('child admission rejects model-supplied authority fields in proposals', () => {
  const authorityFields: readonly (readonly [string, unknown])[] = [
    ['method', methodRef],
    ['template', { id: 'template-child', digest: method.digest }],
    ['resources', childResources],
    ['acceptance', childTemplate.acceptancePolicy],
    ['environment', childEnvironment],
    ['limits', childLimits],
    ['origin', { kind: 'child', parentId: 'task-root', parentRunId: 'run-root-1', batchId: 'batch-1', bindingId: 'build-part' }],
    ['join', 'required'],
    ['required', true],
    ['role', 'deliverable'],
    ['acceptancePolicy', childTemplate.acceptancePolicy],
    ['verifier', 'model-verifier'],
    ['scorer', 'model-scorer'],
    ['taskId', 'task-model'],
    ['parentId', 'task-model-parent'],
    ['parentRunId', 'run-model'],
    ['batchId', 'batch-model'],
    ['bindingId', 'model-binding'],
    ['criteria', childTemplate.requiredCriteria],
    ['digest', digestA],
  ]

  for (const [field, value] of authorityFields) {
    const input = childBatchInput()
    const request = childRequest(input)
    const proposal = clone(request.proposal) as unknown as Record<string, unknown>
    proposal[field] = value
    request.proposal = proposal as unknown as TaskProposal
    assert.throws(() => admitChildBatch(input), admissionError('INVALID_ARGUMENT'), field)
  }
})

void test('child admission rejects unknown request fields, tampered parents, and tampered methods', () => {
  const unknownRequest = childBatchInputRecord(clone(childBatchInput()))
  const children = unknownRequest['children'] as Record<string, unknown>[]
  const first = children.at(0)
  if (first === undefined) throw new Error('expected one child request')
  first['join'] = 'required'
  assert.throws(
    () => admitChildBatch(unknownRequest as unknown as ChildBatchAdmissionInput),
    admissionError('INVALID_ARGUMENT'),
  )

  const tamperedParent = childBatchInput()
  tamperedParent.parent = { ...tamperedParent.parent, taskId: 'task-tampered' }
  assert.throws(() => admitChildBatch(tamperedParent), admissionError('INVALID_ARGUMENT'))

  const tamperedMethod = childBatchInput()
  tamperedMethod.method = { ...tamperedMethod.method, id: 'method-tampered' }
  assert.throws(() => admitChildBatch(tamperedMethod), admissionError('INVALID_ARGUMENT'))
})

void test('child admission rejects a method that does not match the parent pin', () => {
  const otherMethod = sealMethodRevision({
    v: 1,
    id: 'method-other',
    templates: [],
    skills: [],
    tools: [],
  })
  const input = childBatchInput()
  input.method = otherMethod
  assert.throws(() => admitChildBatch(input), admissionError('BINDING_FIXED'))
})

void test('child admission rejects parent template and binding identities outside the frozen method', () => {
  const input = childBatchInput()
  const { digest, ...body } = input.parent
  void digest
  input.parent = sealTaskContract({
    ...body,
    template: { ...body.template, digest: digestD },
  } as TaskContractPayload)
  assert.throws(() => admitChildBatch(input), admissionError('BINDING_FIXED'))

  const unknownBinding = childBatchInput()
  childRequest(unknownBinding).bindingId = 'not-a-binding'
  assert.throws(() => admitChildBatch(unknownBinding), admissionError('BINDING_FIXED'))
})

void test('child admission rejects a binding whose template is absent from the method', () => {
  const brokenRootTemplate: TaskTemplate = {
    ...rootTemplate,
    children: [
      { bindingId: 'missing-target', templateId: 'template-missing', brief: 'Broken binding.', join: 'required' },
    ],
  }
  const brokenMethod = sealMethodRevision({
    v: 1,
    id: 'method-broken-template',
    entryTemplateId: brokenRootTemplate.id,
    templates: [brokenRootTemplate, childTemplate],
    skills: [],
    tools: [],
  })
  const brokenParent = admitRootTask({
    ...rootInput,
    method: { id: brokenMethod.id, digest: brokenMethod.digest },
    template: { id: brokenRootTemplate.id, digest: brokenMethod.digest },
  })
  const input: ChildBatchAdmissionInput = {
    ...childBatchInput(),
    parent: brokenParent,
    method: brokenMethod,
    children: [
      {
        ...childRequest(childBatchInput()),
        bindingId: 'missing-target',
      },
    ],
  }
  assert.throws(() => admitChildBatch(input), admissionError('INVALID_ARGUMENT'))
})

void test('child admission rejects template draft roles/paths and duplicate or reserved local outputs', () => {
  const draftRoleTemplate: TaskTemplate = {
    ...childTemplate,
    requiredOutputs: [
      ...childTemplate.requiredOutputs,
      { id: 'platform-draft', path: 'custom/draft', kind: 'tree', role: 'skill-draft', required: false },
    ],
  }
  const draftRoleMethod = sealMethodRevision({
    v: 1,
    id: 'method-draft-role',
    entryTemplateId: rootTemplate.id,
    templates: [rootTemplate, draftRoleTemplate],
    skills: [],
    tools: [],
  })
  const draftRoleParent = admitRootTask({
    ...rootInput,
    method: { id: draftRoleMethod.id, digest: draftRoleMethod.digest },
    template: { id: rootTemplate.id, digest: draftRoleMethod.digest },
  })
  assert.throws(
    () => admitChildBatch({
      ...childBatchInput(),
      parent: draftRoleParent,
      method: draftRoleMethod,
    }),
    admissionError('INVALID_ARGUMENT'),
  )

  const localCases: readonly {
    readonly label: string
    readonly localOutputs: LocalOutput[]
  }[] = [
    {
      label: 'duplicate with template output id',
      localOutputs: [{ id: 'result', path: 'local/result', kind: 'file', description: 'duplicate id' }],
    },
    {
      label: 'duplicate with template output path',
      localOutputs: [{ id: 'local-result', path: 'outputs/result.json', kind: 'file', description: 'duplicate path' }],
    },
    {
      label: 'duplicate local id',
      localOutputs: [
        { id: 'local', path: 'local/a', kind: 'file', description: 'first' },
        { id: 'local', path: 'local/b', kind: 'file', description: 'second' },
      ],
    },
    {
      label: 'reserved local id',
      localOutputs: [{ id: '__mcp-drafts', path: 'local/draft', kind: 'tree', description: 'reserved id' }],
    },
    {
      label: 'reserved local path',
      localOutputs: [{ id: 'local-draft', path: 'learning-drafts/mcp-servers', kind: 'tree', description: 'reserved path' }],
    },
  ]

  for (const { label, localOutputs } of localCases) {
    const input = childBatchInput()
    const request = childRequest(input)
    request.proposal = { ...request.proposal, localOutputs }
    assert.throws(() => admitChildBatch(input), admissionError('INVALID_ARGUMENT'), label)
  }
})
