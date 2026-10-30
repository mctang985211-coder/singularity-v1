import assert from 'node:assert/strict'
import test from 'node:test'

import { sealFact } from '../src/fact.ts'
import type {
  ChildrenAdmittedPayload,
  Fact,
  FactType,
  RunClosedPayload,
  RunOpenedPayload,
  RunSubmittedPayload,
  TaskClosedPayload,
  UsageRecord,
} from '../src/fact.ts'
import { sealMethodRevision } from '../src/method.ts'
import type { ChildBinding, MethodRevision, TaskTemplate } from '../src/method.ts'
import { reduceTaskRunFacts, ReducerError } from '../src/reducer.ts'
import type { ReducerErrorCode, ReplayContext } from '../src/reducer.ts'
import type { Ref } from '../src/refs.ts'
import { sealTaskContract } from '../src/task.ts'
import type {
  TaskChildOrigin,
  TaskContract,
  TaskLimits,
  TaskOrigin,
  TaskRootOrigin,
} from '../src/task.ts'

function digestFor(value: number): string {
  return `sha256:${value.toString(16).padStart(64, '0')}`
}

function ref(id: string, value = 1): Ref {
  return { id, digest: digestFor(value) }
}

function binding(
  bindingId: string,
  templateId: string,
  join: 'required' | 'probe',
): ChildBinding {
  return { bindingId, templateId, brief: `${bindingId} brief`, join }
}

function template(id: string, children: ChildBinding[] = []): TaskTemplate {
  return {
    id,
    brief: `${id} brief`,
    guidance: ref(`${id}-guidance`, 11),
    example: ref(`${id}-example`, 12),
    instanceSchema: {},
    requiredCriteria: [],
    requiredOutputs: [],
    acceptancePolicy: ref(`${id}-acceptance`, 13),
    skills: [],
    tools: [],
    children,
  }
}

const templates: TaskTemplate[] = [
  template('root-template', [
    binding('child-required', 'child-template', 'required'),
    binding('child-probe', 'child-template', 'probe'),
  ]),
  template('child-template', [binding('grandchild-probe', 'grand-template', 'probe')]),
  template('grand-template'),
]

const baseMethod = sealMethodRevision({
  v: 1,
  id: 'method-1',
  templates,
  skills: [],
  tools: [],
})

const baseMethodRef: Ref = { id: baseMethod.id, digest: baseMethod.digest }

const defaultLimits: TaskLimits = {
  maxRuns: 2,
  maxStepsPerRun: 10,
  maxTokens: 1_000,
  deadlineAt: 2_000,
  maxDepth: 4,
  maxTasks: 20,
  maxBatchChildren: 3,
}

const defaultReservation = { tokens: 100, steps: 5, deadlineAt: 1_500 }

function goalFor(taskId: string) {
  return {
    summary: `Goal for ${taskId}`,
    deliverable: `Deliverable for ${taskId}`,
    scope: [],
    constraints: [],
  }
}

function rootOrigin(): TaskRootOrigin {
  return { kind: 'root', purpose: 'work', requestRef: ref('request-root', 20) }
}

function childOrigin(
  parentId: string,
  parentRunId: string,
  batchId: string,
  bindingId = 'child-required',
): TaskChildOrigin {
  return { kind: 'child', parentId, parentRunId, batchId, bindingId }
}

function makeRootContract(
  options: {
    readonly limits?: Partial<TaskLimits>
    readonly method?: Ref
    readonly templateId?: string
    readonly templateDigest?: string
    readonly origin?: TaskOrigin
  } = {},
): TaskContract {
  const method = options.method ?? baseMethodRef
  return sealTaskContract({
    v: 1,
    taskId: 'task-root',
    spec: { goal: goalFor('task-root'), criteria: [], inputs: [], outputs: [] },
    origin: options.origin ?? rootOrigin(),
    method,
    template: {
      id: options.templateId ?? 'root-template',
      digest: options.templateDigest ?? method.digest,
    },
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: ref('acceptance-root', 21),
    environment: { seed: ref('seed-root', 22), profile: ref('profile-root', 23) },
    limits: { ...defaultLimits, ...options.limits },
  })
}

function makeChildContract(options: {
  readonly taskId: string
  readonly parentId?: string
  readonly parentRunId?: string
  readonly batchId?: string
  readonly bindingId?: string
  readonly templateId?: string
  readonly method?: Ref
  readonly limits?: Partial<TaskLimits>
}): TaskContract {
  const method = options.method ?? baseMethodRef
  return sealTaskContract({
    v: 1,
    taskId: options.taskId,
    spec: { goal: goalFor(options.taskId), criteria: [], inputs: [], outputs: [] },
    origin: childOrigin(
      options.parentId ?? 'task-root',
      options.parentRunId ?? 'run-root-1',
      options.batchId ?? 'batch-1',
      options.bindingId ?? 'child-required',
    ),
    method,
    template: {
      id: options.templateId ?? 'child-template',
      digest: method.digest,
    },
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: ref(`acceptance-${options.taskId}`, 24),
    environment: { seed: ref('seed-child', 25), profile: ref('profile-child', 26) },
    limits: { ...defaultLimits, ...options.limits },
  })
}

function contractRef(contract: TaskContract): Ref {
  return { id: `contract-${contract.taskId}`, digest: contract.digest }
}

function makeContext(
  contracts: readonly TaskContract[],
  methods: readonly MethodRevision[] = [baseMethod],
  transientInvalidReasons: readonly string[] = [],
): ReplayContext {
  return {
    contracts: new Map(contracts.map(contract => [`contract-${contract.taskId}`, contract])),
    methods: new Map(methods.map(method => [method.id, method])),
    transientInvalidReasons,
  }
}

class Journal {
  readonly facts: Fact[] = []

  add(type: FactType, data: unknown, at = 100): Fact {
    const seq = this.facts.length
    const previous = this.facts.at(-1)
    const fact = sealFact({
      v: 1,
      seq,
      commandId: `command-${String(seq)}`,
      commandDigest: digestFor(9_000 + seq),
      type,
      actor: { kind: 'runtime', id: 'runtime-1' },
      at,
      data,
      prev: previous?.digest ?? null,
    })
    this.facts.push(fact)
    return fact
  }
}

function appendFact(
  facts: readonly Fact[],
  type: FactType,
  data: unknown,
  at = 100,
): Fact {
  const seq = facts.length
  const previous = facts.at(-1)
  return sealFact({
    v: 1,
    seq,
    commandId: `extra-${String(seq)}`,
    commandDigest: digestFor(8_000 + seq),
    type,
    actor: { kind: 'runtime', id: 'runtime-1' },
    at,
    data,
    prev: previous?.digest ?? null,
  })
}

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { inputTokens: 10, outputTokens: 5, steps: 1, unknownRequests: 0, ...overrides }
}

function evidence(runId: string): Ref {
  return ref(`evidence-${runId}`, 77)
}

function execution(runId: string): Ref {
  return ref(`execution-${runId}`, 78)
}

function runOpened(
  taskId: string,
  runId: string,
  attempt: number,
  overrides: Partial<RunOpenedPayload> = {},
): RunOpenedPayload {
  return {
    taskId,
    runId,
    attempt,
    sessionId: `session-${runId}`,
    composition: ref(`composition-${runId}`, 30),
    workspaceKey: `workspace-${runId}`,
    workspaceSeed: ref(`seed-${runId}`, 31),
    budgetReservation: defaultReservation,
    ...overrides,
  }
}

function submitted(runId: string, sessionId = `session-${runId}`): RunSubmittedPayload {
  return {
    runId,
    outputs: ref(`outputs-${runId}`, 32),
    transcriptOffset: { sessionId, seq: 4 },
    previewReceipts: [],
    readReceipts: [],
    planningSketchRef: ref(`sketch-${runId}`, 33),
    feedbackRefs: [],
  }
}

function verifiedClosed(runId: string): RunClosedPayload {
  return {
    runId,
    classification: 'verified',
    reason: 'All required criteria passed',
    evidenceRef: evidence(runId),
    usage: usage(),
    feedbackRefs: [],
  }
}

function failedClosed(runId: string): RunClosedPayload {
  return {
    runId,
    classification: 'failed',
    reason: 'Required criteria failed',
    evidenceRef: evidence(runId),
    usage: usage(),
    feedbackRefs: [],
  }
}

function failedExecutionClosed(runId: string): RunClosedPayload {
  return {
    runId,
    classification: 'failed',
    reason: 'No submission before step limit',
    executionRecordRef: execution(runId),
    usage: usage(),
    feedbackRefs: [],
  }
}

function invalidClosed(runId: string, reason: string): RunClosedPayload {
  return {
    runId,
    classification: 'invalid',
    reason,
    executionRecordRef: execution(runId),
    usage: usage(),
    feedbackRefs: [],
  }
}

function cancelledExecutionClosed(runId: string): RunClosedPayload {
  return {
    runId,
    classification: 'cancelled',
    reason: 'Cancelled by operator',
    executionRecordRef: execution(runId),
    usage: usage(),
    feedbackRefs: [],
  }
}

function verifiedTask(taskId: string, decisiveRunId: string): TaskClosedPayload {
  return {
    taskId,
    outcome: 'verified',
    reason: 'Verified with required joins',
    decisiveRunId,
    evidenceRefs: [evidence(decisiveRunId)],
  }
}

function failedTask(taskId: string, decisiveRunId?: string): TaskClosedPayload {
  return {
    taskId,
    outcome: 'failed',
    reason: 'Retry policy exhausted',
    ...(decisiveRunId === undefined ? {} : { decisiveRunId }),
    evidenceRefs: [],
  }
}

function invalidTask(taskId: string, decisiveRunId?: string): TaskClosedPayload {
  return {
    taskId,
    outcome: 'invalid',
    reason: 'Infrastructure failure',
    ...(decisiveRunId === undefined ? {} : { decisiveRunId }),
    evidenceRefs: [],
  }
}

function cancelledTask(
  taskId: string,
  options: { readonly scope?: 'subtree'; readonly cut?: Ref } = {},
): TaskClosedPayload {
  return {
    taskId,
    outcome: 'cancelled',
    reason: 'Cancelled by operator',
    evidenceRefs: [],
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.cut === undefined ? {} : { cancellationCutRef: options.cut }),
  }
}

function admission(
  parentRunId: string,
  batchId: string,
  children: ChildrenAdmittedPayload['children'],
): ChildrenAdmittedPayload {
  return { parentRunId, batchId, children }
}

function admittedChild(
  contract: TaskContract,
  join: 'required' | 'probe',
  replacement?: ChildrenAdmittedPayload['children'][number]['replacement'],
): ChildrenAdmittedPayload['children'][number] {
  return {
    contract,
    join,
    budgetReservation: defaultReservation,
    ...(replacement === undefined ? {} : { replacement }),
  }
}

function mustGet<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Missing map entry ${String(key)}`)
  return value
}

function expectReducerError(action: () => unknown, code: ReducerErrorCode): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ReducerError, `Expected ReducerError ${code}, got ${String(caught)}`)
  assert.equal(caught.code, code)
}

function happyPath(): {
  readonly journal: Journal
  readonly context: ReplayContext
  readonly root: TaskContract
  readonly child: TaskContract
} {
  const journal = new Journal()
  const root = makeRootContract()
  const child = makeChildContract({ taskId: 'task-child' })

  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(child, 'required')]),
  )
  journal.add('run/opened', runOpened('task-child', 'run-child-1', 1))
  journal.add('run/submitted', submitted('run-child-1'))
  journal.add('run/closed', verifiedClosed('run-child-1'))
  journal.add('task/closed', verifiedTask('task-child', 'run-child-1'))
  journal.add('run/submitted', submitted('run-root-1'))
  journal.add('run/closed', verifiedClosed('run-root-1'))
  journal.add('task/closed', verifiedTask('task-root', 'run-root-1'))

  return { journal, context: makeContext([root]), root, child }
}

void test('replay is deterministic and does not mutate facts or the frozen context', () => {
  const { journal, context } = happyPath()
  const facts = journal.facts
  const inputSnapshot = structuredClone({ facts, context })

  const first = reduceTaskRunFacts(facts, context)
  const second = reduceTaskRunFacts(facts, context)

  assert.deepEqual(first, second)
  assert.deepEqual(first.tasks, second.tasks)
  assert.deepEqual(first.runs, second.runs)
  assert.deepEqual(structuredClone({ facts, context }), inputSnapshot)
  assert.equal(first.tasks.size, 2)
  assert.equal(first.runs.size, 2)
  assert.equal(first.batches.size, 1)
})

void test('folds a root Task whose required child is verified before the parent closes', () => {
  const { journal, context } = happyPath()
  const state = reduceTaskRunFacts(journal.facts, context)

  const root = mustGet(state.tasks, 'task-root')
  const child = mustGet(state.tasks, 'task-child')
  const rootRun = mustGet(state.runs, 'run-root-1')
  const childRun = mustGet(state.runs, 'run-child-1')
  const batch = mustGet(state.batches, 'batch-1')

  assert.equal(root.phase, 'closed')
  assert.equal(root.closed?.outcome, 'verified')
  assert.equal(root.closed.source, 'task/closed')
  assert.equal(root.activeRunId, undefined)
  assert.deepEqual(root.childIds, ['task-child'])

  assert.equal(child.phase, 'closed')
  assert.equal(child.closed?.outcome, 'verified')
  assert.equal(child.join, 'required')
  assert.equal(child.bindingId, 'child-required')
  assert.equal(child.supersededBy, undefined)

  assert.equal(rootRun.phase, 'closed')
  assert.equal(rootRun.closed?.classification, 'verified')
  assert.deepEqual(rootRun.childIds, ['task-child'])
  assert.equal(childRun.closed?.classification, 'verified')
  assert.equal(batch.parentTaskId, 'task-root')
  assert.equal(batch.parentRunId, 'run-root-1')
  assert.deepEqual(batch.childIds, ['task-child'])
})

void test('root admission checks contract ref, contract digest, method and template', () => {
  const root = makeRootContract()
  const admitted = { taskId: 'task-root', contract: contractRef(root) }
  const fact = new Journal().add('task/admitted', admitted)

  expectReducerError(
    () => reduceTaskRunFacts([fact], makeContext([])),
    'CAS_REF_MISSING',
  )

  const tampered: TaskContract = { ...root, digest: digestFor(999) }
  const tamperedRef = { id: 'contract-task-root', digest: tampered.digest }
  const tamperedContext: ReplayContext = {
    contracts: new Map([['contract-task-root', tampered]]),
    methods: new Map([[baseMethod.id, baseMethod]]),
    transientInvalidReasons: [],
  }
  expectReducerError(
    () =>
      reduceTaskRunFacts(
        [new Journal().add('task/admitted', { taskId: 'task-root', contract: tamperedRef })],
        tamperedContext,
      ),
    'CONTRACT_INVALID',
  )

  expectReducerError(
    () => reduceTaskRunFacts([fact], makeContext([root], [])),
    'CAS_REF_MISSING',
  )

  const methodWithoutRoot = sealMethodRevision({
    v: 1,
    id: 'method-1',
    templates: templates.filter(entry => entry.id !== 'root-template'),
    skills: [],
    tools: [],
  })
  const contractWithoutRoot = makeRootContract({
    method: { id: methodWithoutRoot.id, digest: methodWithoutRoot.digest },
  })
  const withoutRootFact = new Journal().add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(contractWithoutRoot),
  })
  expectReducerError(
    () => reduceTaskRunFacts([withoutRootFact], makeContext([contractWithoutRoot], [methodWithoutRoot])),
    'METHOD_TEMPLATE_MISMATCH',
  )

  const wrongTemplateDigest = makeRootContract({ templateDigest: digestFor(123) })
  const wrongTemplateFact = new Journal().add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(wrongTemplateDigest),
  })
  expectReducerError(
    () => reduceTaskRunFacts([wrongTemplateFact], makeContext([wrongTemplateDigest])),
    'METHOD_TEMPLATE_MISMATCH',
  )

  const childOriginRoot = makeRootContract({
    origin: childOrigin('task-parent', 'run-parent-1', 'batch-parent-1'),
  })
  const childOriginFact = new Journal().add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(childOriginRoot),
  })
  expectReducerError(
    () => reduceTaskRunFacts([childOriginFact], makeContext([childOriginRoot])),
    'TASK_ORIGIN_INVALID',
  )
})

void test('run/opened requires an open Task, ordered attempts, and bounded reservations', () => {
  const root = makeRootContract({ limits: { maxRuns: 2, maxTokens: 100, maxStepsPerRun: 5 } })
  const context = makeContext([root])
  const prefix = [
    new Journal().add('task/admitted', { taskId: 'task-root', contract: contractRef(root) }),
  ]

  for (const attempt of [0, 2]) {
    const invalid = appendFact(
      prefix,
      'run/opened',
      runOpened('task-root', `run-${String(attempt)}`, attempt),
    )
    expectReducerError(() => reduceTaskRunFacts([...prefix, invalid], context), 'INVALID_ATTEMPT')
  }

  const overTokens = appendFact(
    prefix,
    'run/opened',
    runOpened('task-root', 'run-budget-1', 1, {
      budgetReservation: { tokens: 101, steps: 1, deadlineAt: 1_500 },
    }),
  )
  expectReducerError(() => reduceTaskRunFacts([...prefix, overTokens], context), 'BUDGET_EXCEEDED')

  const overSteps = appendFact(
    prefix,
    'run/opened',
    runOpened('task-root', 'run-budget-2', 1, {
      budgetReservation: { tokens: 1, steps: 6, deadlineAt: 1_500 },
    }),
  )
  expectReducerError(() => reduceTaskRunFacts([...prefix, overSteps], context), 'BUDGET_EXCEEDED')

  const first = appendFact(prefix, 'run/opened', runOpened('task-root', 'run-root-1', 1))
  const opened = reduceTaskRunFacts([...prefix, first], context)
  assert.equal(mustGet(opened.tasks, 'task-root').phase, 'active')
  assert.equal(mustGet(opened.tasks, 'task-root').activeRunId, 'run-root-1')

  const secondWhileActive = appendFact(
    [...prefix, first],
    'run/opened',
    runOpened('task-root', 'run-root-2', 2),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...prefix, first, secondWhileActive], context),
    'TASK_NOT_OPEN',
  )

  const duplicate = appendFact(
    [...prefix, first],
    'run/opened',
    runOpened('task-root', 'run-root-1', 2),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...prefix, first, duplicate], context),
    'DUPLICATE_RUN',
  )
})

void test('failed retry is allowed only while maxRuns, deadline, tokens, and unknown usage permit', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const journal = new Journal()
  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add('run/submitted', submitted('run-root-1'))
  journal.add('run/closed', failedClosed('run-root-1'))

  const afterFailure = reduceTaskRunFacts(journal.facts, context)
  assert.equal(mustGet(afterFailure.tasks, 'task-root').phase, 'open')
  assert.equal(mustGet(afterFailure.runs, 'run-root-1').closed?.classification, 'failed')

  const prematureClose = appendFact(journal.facts, 'task/closed', failedTask('task-root', 'run-root-1'))
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, prematureClose], context),
    'RETRY_AVAILABLE',
  )

  journal.add('run/opened', runOpened('task-root', 'run-root-2', 2))
  journal.add('run/submitted', submitted('run-root-2'))
  journal.add('run/closed', failedClosed('run-root-2'))
  journal.add('task/closed', failedTask('task-root', 'run-root-2'))

  const exhausted = reduceTaskRunFacts(journal.facts, context)
  assert.equal(mustGet(exhausted.tasks, 'task-root').phase, 'closed')
  assert.equal(mustGet(exhausted.tasks, 'task-root').closed?.outcome, 'failed')

  const afterExhaustion = journal.facts.slice(0, -1)
  const thirdRun = appendFact(
    afterExhaustion,
    'run/opened',
    runOpened('task-root', 'run-root-3', 3),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...afterExhaustion, thirdRun], context),
    'RETRY_NOT_ALLOWED',
  )
})

void test('a retry Run cannot open while an earlier child is still active', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const child = makeChildContract({ taskId: 'task-child' })
  const journal = new Journal()
  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(child, 'required')]),
  )
  journal.add('run/closed', failedExecutionClosed('run-root-1'))

  const retry = appendFact(journal.facts, 'run/opened', runOpened('task-root', 'run-root-2', 2))
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, retry], context),
    'CHILDREN_NOT_TERMINAL',
  )
})

void test('deadline, token exhaustion, and unknown usage stop retry but permit task closure', () => {
  const deadlineRoot = makeRootContract()
  const deadlineContext = makeContext([deadlineRoot])
  const deadlineJournal = new Journal()
  deadlineJournal.add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(deadlineRoot),
  })
  deadlineJournal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  deadlineJournal.add('run/submitted', submitted('run-root-1'))
  deadlineJournal.add('run/closed', failedClosed('run-root-1'))

  const atDeadline = appendFact(
    deadlineJournal.facts,
    'run/opened',
    runOpened('task-root', 'run-root-2', 2),
    deadlineRoot.limits.deadlineAt,
  )
  expectReducerError(
    () =>
      reduceTaskRunFacts([...deadlineJournal.facts, atDeadline], deadlineContext),
    'RETRY_NOT_ALLOWED',
  )

  const closedAtDeadline = appendFact(
    deadlineJournal.facts,
    'task/closed',
    failedTask('task-root', 'run-root-1'),
    deadlineRoot.limits.deadlineAt,
  )
  const deadlineClosed = reduceTaskRunFacts(
    [...deadlineJournal.facts, closedAtDeadline],
    deadlineContext,
  )
  assert.equal(mustGet(deadlineClosed.tasks, 'task-root').closed?.outcome, 'failed')

  const tokenRoot = makeRootContract({ limits: { maxTokens: 100 } })
  const tokenContext = makeContext([tokenRoot])
  const tokenJournal = new Journal()
  tokenJournal.add('task/admitted', { taskId: 'task-root', contract: contractRef(tokenRoot) })
  tokenJournal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  tokenJournal.add('run/submitted', submitted('run-root-1'))
  tokenJournal.add(
    'run/closed',
    {
      ...failedClosed('run-root-1'),
      usage: usage({ inputTokens: 60, outputTokens: 40 }),
    },
  )
  const tokenRetry = appendFact(
    tokenJournal.facts,
    'run/opened',
    runOpened('task-root', 'run-root-2', 2, {
      budgetReservation: { tokens: 1, steps: 1, deadlineAt: 1_500 },
    }),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...tokenJournal.facts, tokenRetry], tokenContext),
    'RETRY_NOT_ALLOWED',
  )
  const tokenClose = appendFact(tokenJournal.facts, 'task/closed', failedTask('task-root'))
  assert.equal(
    mustGet(
      reduceTaskRunFacts([...tokenJournal.facts, tokenClose], tokenContext).tasks,
      'task-root',
    ).closed?.outcome,
    'failed',
  )

  const unknownRoot = makeRootContract()
  const unknownContext = makeContext([unknownRoot])
  const unknownJournal = new Journal()
  unknownJournal.add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(unknownRoot),
  })
  unknownJournal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  unknownJournal.add('run/submitted', submitted('run-root-1'))
  unknownJournal.add(
    'run/closed',
    { ...failedClosed('run-root-1'), usage: usage({ unknownRequests: 1 }) },
  )
  const unknownRetry = appendFact(
    unknownJournal.facts,
    'run/opened',
    runOpened('task-root', 'run-root-2', 2),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...unknownJournal.facts, unknownRetry], unknownContext),
    'RETRY_NOT_ALLOWED',
  )
  const unknownClose = appendFact(unknownJournal.facts, 'task/closed', failedTask('task-root'))
  assert.equal(
    mustGet(
      reduceTaskRunFacts([...unknownJournal.facts, unknownClose], unknownContext).tasks,
      'task-root',
    ).closed?.outcome,
    'failed',
  )
})

void test('invalid retry requires a pre-listed transient reason', () => {
  const root = makeRootContract()
  const transientContext = makeContext([root], [baseMethod], ['transient-db-lock'])
  const journal = new Journal()
  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add('run/closed', invalidClosed('run-root-1', 'transient-db-lock'))

  const afterInvalid = reduceTaskRunFacts(journal.facts, transientContext)
  assert.equal(mustGet(afterInvalid.tasks, 'task-root').phase, 'open')

  const prematureInvalidClose = appendFact(
    journal.facts,
    'task/closed',
    invalidTask('task-root', 'run-root-1'),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, prematureInvalidClose], transientContext),
    'RETRY_AVAILABLE',
  )

  journal.add('run/opened', runOpened('task-root', 'run-root-2', 2))
  journal.add('run/closed', invalidClosed('run-root-2', 'transient-db-lock'))
  journal.add('task/closed', invalidTask('task-root', 'run-root-2'))
  assert.equal(
    mustGet(reduceTaskRunFacts(journal.facts, transientContext).tasks, 'task-root').closed
      ?.outcome,
    'invalid',
  )

  const permanentContext = makeContext([root], [baseMethod], ['transient-db-lock'])
  const permanentJournal = new Journal()
  permanentJournal.add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(root),
  })
  permanentJournal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  permanentJournal.add('run/closed', invalidClosed('run-root-1', 'corrupt-evidence'))
  const permanentRetry = appendFact(
    permanentJournal.facts,
    'run/opened',
    runOpened('task-root', 'run-root-2', 2),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...permanentJournal.facts, permanentRetry], permanentContext),
    'RETRY_NOT_ALLOWED',
  )
  const permanentClose = appendFact(
    permanentJournal.facts,
    'task/closed',
    invalidTask('task-root', 'run-root-1'),
  )
  assert.equal(
    mustGet(
      reduceTaskRunFacts([...permanentJournal.facts, permanentClose], permanentContext).tasks,
      'task-root',
    ).closed?.outcome,
    'invalid',
  )
})

void test('child admission guards origin, method, template, binding, join, and batch identity', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const prefix = [
    new Journal().add('task/admitted', { taskId: 'task-root', contract: contractRef(root) }),
    new Journal().add('run/opened', runOpened('task-root', 'run-root-1', 1)),
  ]

  const goodChild = makeChildContract({ taskId: 'task-child' })

  const cases: readonly (readonly [string, ChildrenAdmittedPayload, ReducerErrorCode])[] = [
    [
      'empty batch',
      admission('run-root-1', 'batch-1', []),
      'CHILD_BATCH_EMPTY',
    ],
    [
      'parent mismatch',
      admission('run-root-1', 'batch-1', [
        admittedChild(
          makeChildContract({ taskId: 'task-child', parentId: 'task-other' }),
          'required',
        ),
      ]),
      'CHILD_ORIGIN_MISMATCH',
    ],
    [
      'origin batch mismatch',
      admission('run-root-1', 'batch-1', [
        admittedChild(
          makeChildContract({ taskId: 'task-child', batchId: 'batch-other' }),
          'required',
        ),
      ]),
      'CHILD_ORIGIN_MISMATCH',
    ],
    [
      'method mismatch',
      admission('run-root-1', 'batch-1', [
        admittedChild(
          makeChildContract({
            taskId: 'task-child',
            method: { id: 'method-other', digest: digestFor(555) },
          }),
          'required',
        ),
      ]),
      'CHILD_METHOD_MISMATCH',
    ],
    [
      'binding missing from parent template',
      admission('run-root-1', 'batch-1', [
        admittedChild(
          makeChildContract({ taskId: 'task-child', bindingId: 'missing-binding' }),
          'required',
        ),
      ]),
      'CHILD_BINDING_MISMATCH',
    ],
    [
      'template mismatch',
      admission('run-root-1', 'batch-1', [
        admittedChild(
          makeChildContract({ taskId: 'task-child', templateId: 'grand-template' }),
          'required',
        ),
      ]),
      'CHILD_TEMPLATE_MISMATCH',
    ],
    [
      'join mismatch',
      admission('run-root-1', 'batch-1', [admittedChild(goodChild, 'probe')]),
      'CHILD_JOIN_MISMATCH',
    ],
    [
      'duplicate child task id',
      admission('run-root-1', 'batch-1', [
        admittedChild(goodChild, 'required'),
        admittedChild(goodChild, 'required'),
      ]),
      'CHILD_DUPLICATE',
    ],
  ]

  for (const [label, payload, code] of cases) {
    const fact = appendFact(prefix, 'task/children-admitted', payload)
    expectReducerError(
      () => reduceTaskRunFacts([...prefix, fact], context),
      code,
    )
    assert.ok(label.length > 0)
  }
})

void test('child admission enforces batch limits, budgets, active batches, and satisfied bindings', () => {
  const root = makeRootContract({ limits: { maxBatchChildren: 2 } })
  const context = makeContext([root])
  const prefix = [
    new Journal().add('task/admitted', { taskId: 'task-root', contract: contractRef(root) }),
    new Journal().add('run/opened', runOpened('task-root', 'run-root-1', 1)),
  ]

  const tooMany = admission('run-root-1', 'batch-many', [
    admittedChild(makeChildContract({ taskId: 'task-a' }), 'required'),
    admittedChild(
      makeChildContract({ taskId: 'task-b', bindingId: 'child-probe' }),
      'probe',
    ),
    admittedChild(
      makeChildContract({ taskId: 'task-c', bindingId: 'child-probe' }),
      'probe',
    ),
  ])
  const tooManyFact = appendFact(prefix, 'task/children-admitted', tooMany)
  expectReducerError(
    () => reduceTaskRunFacts([...prefix, tooManyFact], context),
    'CHILD_LIMIT_EXCEEDED',
  )

  const child = makeChildContract({ taskId: 'task-child' })
  const overBudget = admission('run-root-1', 'batch-budget', [
    {
      contract: makeChildContract({ taskId: 'task-child', batchId: 'batch-budget' }),
      join: 'required',
      budgetReservation: { tokens: 2_000, steps: 1, deadlineAt: 1_500 },
    },
  ])
  const overBudgetFact = appendFact(prefix, 'task/children-admitted', overBudget)
  expectReducerError(
    () => reduceTaskRunFacts([...prefix, overBudgetFact], context),
    'BUDGET_EXCEEDED',
  )

  const firstAdmission = appendFact(
    prefix,
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(child, 'required')]),
  )
  const withActiveChild = [...prefix, firstAdmission]
  const secondBatch = appendFact(
    withActiveChild,
    'task/children-admitted',
    admission('run-root-1', 'batch-2', [
      admittedChild(
        makeChildContract({ taskId: 'task-child-2', batchId: 'batch-2' }),
        'required',
      ),
    ]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...withActiveChild, secondBatch], context),
    'CHILD_ACTIVE',
  )

  const childRun = appendFact(
    withActiveChild,
    'run/opened',
    runOpened('task-child', 'run-child-1', 1),
  )
  const childSubmit = appendFact(
    [...withActiveChild, childRun],
    'run/submitted',
    submitted('run-child-1'),
  )
  const childClose = appendFact(
    [...withActiveChild, childRun, childSubmit],
    'run/closed',
    verifiedClosed('run-child-1'),
  )
  const childTaskClose = appendFact(
    [...withActiveChild, childRun, childSubmit, childClose],
    'task/closed',
    verifiedTask('task-child', 'run-child-1'),
  )
  const afterChildVerified = [...withActiveChild, childRun, childSubmit, childClose, childTaskClose]
  const duplicateBinding = appendFact(
    afterChildVerified,
    'task/children-admitted',
    admission('run-root-1', 'batch-2', [
      admittedChild(
        makeChildContract({ taskId: 'task-child-2', batchId: 'batch-2' }),
        'required',
      ),
    ]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...afterChildVerified, duplicateBinding], context),
    'BINDING_ALREADY_SATISFIED',
  )

  const submittedRoot = appendFact(prefix, 'run/submitted', submitted('run-root-1'))
  const afterSubmit = [...prefix, submittedRoot]
  const admissionAfterSubmit = appendFact(
    afterSubmit,
    'task/children-admitted',
    admission('run-root-1', 'batch-after-submit', [admittedChild(child, 'required')]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...afterSubmit, admissionAfterSubmit], context),
    'RUN_NOT_OPEN',
  )
})

void test('replacement supersedes only terminal nonverified children and becomes the new winner', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const oldChild = makeChildContract({ taskId: 'task-child-old', limits: { maxRuns: 1 } })
  const newChild = makeChildContract({
    taskId: 'task-child-new',
    batchId: 'batch-2',
  })
  const journal = new Journal()

  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(oldChild, 'required')]),
  )
  journal.add('run/opened', runOpened('task-child-old', 'run-old-1', 1))

  const activeReplacement = appendFact(
    journal.facts,
    'task/children-admitted',
    admission('run-root-1', 'batch-active-replacement', [
      admittedChild(
        makeChildContract({ taskId: 'task-child-new', batchId: 'batch-active-replacement' }),
        'required',
        { feedbackRef: ref('feedback-1', 40), supersedesChildIds: ['task-child-old'] },
      ),
    ]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, activeReplacement], context),
    'CHILD_ACTIVE',
  )

  journal.add('run/closed', failedExecutionClosed('run-old-1'))
  journal.add('task/closed', failedTask('task-child-old', 'run-old-1'))

  const afterFailure = reduceTaskRunFacts(journal.facts, context)
  assert.equal(mustGet(afterFailure.tasks, 'task-child-old').closed?.outcome, 'failed')

  const emptyReplacement = appendFact(
    journal.facts,
    'task/children-admitted',
    admission('run-root-1', 'batch-empty-replacement', [
      admittedChild(
        makeChildContract({ taskId: 'task-child-new', batchId: 'batch-empty-replacement' }),
        'required',
        { feedbackRef: ref('feedback-1', 40), supersedesChildIds: [] },
      ),
    ]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, emptyReplacement], context),
    'REPLACEMENT_TARGET_INVALID',
  )

  const withoutReplacement = appendFact(
    journal.facts,
    'task/children-admitted',
    admission('run-root-1', 'batch-2', [
      admittedChild(
        makeChildContract({ taskId: 'task-child-new', batchId: 'batch-2' }),
        'required',
      ),
    ]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, withoutReplacement], context),
    'REPLACEMENT_REQUIRED',
  )

  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-2', [
      admittedChild(newChild, 'required', {
        feedbackRef: ref('feedback-1', 40),
        supersedesChildIds: ['task-child-old'],
      }),
    ]),
  )
  const replaced = reduceTaskRunFacts(journal.facts, context)
  assert.equal(mustGet(replaced.tasks, 'task-child-old').supersededBy, 'task-child-new')
  assert.equal(mustGet(replaced.tasks, 'task-child-new').supersededBy, undefined)

  journal.add('run/opened', runOpened('task-child-new', 'run-new-1', 1))
  journal.add('run/submitted', submitted('run-new-1'))
  journal.add('run/closed', verifiedClosed('run-new-1'))
  journal.add('task/closed', verifiedTask('task-child-new', 'run-new-1'))
  journal.add('run/submitted', submitted('run-root-1'))
  journal.add('run/closed', verifiedClosed('run-root-1'))
  journal.add('task/closed', verifiedTask('task-root', 'run-root-1'))

  const state = reduceTaskRunFacts(journal.facts, context)
  assert.equal(mustGet(state.tasks, 'task-root').closed?.outcome, 'verified')
  assert.equal(mustGet(state.tasks, 'task-child-old').closed?.outcome, 'failed')
  assert.equal(mustGet(state.tasks, 'task-child-old').supersededBy, 'task-child-new')
  assert.equal(mustGet(state.tasks, 'task-child-new').closed?.outcome, 'verified')
})

void test('a new parent Run must re-establish required winners instead of reusing old children', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const oldChild = makeChildContract({ taskId: 'task-child-old' })
  const journal = new Journal()

  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(oldChild, 'required')]),
  )
  journal.add('run/opened', runOpened('task-child-old', 'run-old-1', 1))
  journal.add('run/submitted', submitted('run-old-1'))
  journal.add('run/closed', verifiedClosed('run-old-1'))
  journal.add('task/closed', verifiedTask('task-child-old', 'run-old-1'))
  journal.add('run/submitted', submitted('run-root-1'))
  journal.add('run/closed', failedClosed('run-root-1'))
  journal.add('run/opened', runOpened('task-root', 'run-root-2', 2))

  const verifiedTarget = appendFact(
    journal.facts,
    'task/children-admitted',
    admission('run-root-2', 'batch-2', [
      admittedChild(
        makeChildContract({
          taskId: 'task-child-new',
          parentRunId: 'run-root-2',
          batchId: 'batch-2',
        }),
        'required',
        { feedbackRef: ref('feedback-1', 40), supersedesChildIds: ['task-child-old'] },
      ),
    ]),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, verifiedTarget], context),
    'REPLACEMENT_TARGET_INVALID',
  )

  journal.add('run/submitted', submitted('run-root-2'))
  journal.add('run/closed', verifiedClosed('run-root-2'))

  const closesWithoutNewChild = appendFact(
    journal.facts,
    'task/closed',
    verifiedTask('task-root', 'run-root-2'),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, closesWithoutNewChild], context),
    'JOIN_UNSATISFIED',
  )

  const successful = new Journal()
  const newChild = makeChildContract({
    taskId: 'task-child-new',
    parentRunId: 'run-root-2',
    batchId: 'batch-2',
  })
  successful.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  successful.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  successful.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(oldChild, 'required')]),
  )
  successful.add('run/opened', runOpened('task-child-old', 'run-old-1', 1))
  successful.add('run/submitted', submitted('run-old-1'))
  successful.add('run/closed', verifiedClosed('run-old-1'))
  successful.add('task/closed', verifiedTask('task-child-old', 'run-old-1'))
  successful.add('run/submitted', submitted('run-root-1'))
  successful.add('run/closed', failedClosed('run-root-1'))
  successful.add('run/opened', runOpened('task-root', 'run-root-2', 2))
  successful.add(
    'task/children-admitted',
    admission('run-root-2', 'batch-2', [admittedChild(newChild, 'required')]),
  )
  successful.add('run/opened', runOpened('task-child-new', 'run-new-1', 1))
  successful.add('run/submitted', submitted('run-new-1'))
  successful.add('run/closed', verifiedClosed('run-new-1'))
  successful.add('task/closed', verifiedTask('task-child-new', 'run-new-1'))
  successful.add('run/submitted', submitted('run-root-2'))
  successful.add('run/closed', verifiedClosed('run-root-2'))
  successful.add('task/closed', verifiedTask('task-root', 'run-root-2'))

  const state = reduceTaskRunFacts(successful.facts, context)
  assert.equal(mustGet(state.tasks, 'task-root').closed?.outcome, 'verified')
  assert.equal(mustGet(state.tasks, 'task-child-old').closed?.outcome, 'verified')
  assert.equal(mustGet(state.tasks, 'task-child-old').supersededBy, undefined)
  assert.equal(mustGet(state.tasks, 'task-child-new').closed?.outcome, 'verified')
})

void test('subtree cancellation closes nonterminal descendants and runs without rewriting run/closed', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const terminalChild = makeChildContract({
    taskId: 'task-terminal',
    bindingId: 'child-probe',
  })
  const activeChild = makeChildContract({
    taskId: 'task-active',
    batchId: 'batch-2',
    bindingId: 'child-required',
  })
  const grandchild = makeChildContract({
    taskId: 'task-grandchild',
    parentId: 'task-active',
    parentRunId: 'run-active-1',
    batchId: 'batch-3',
    bindingId: 'grandchild-probe',
    templateId: 'grand-template',
  })

  const journal = new Journal()
  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(terminalChild, 'probe')]),
  )
  journal.add('run/opened', runOpened('task-terminal', 'run-terminal-1', 1))
  journal.add('run/submitted', submitted('run-terminal-1'))
  journal.add('run/closed', verifiedClosed('run-terminal-1'))
  journal.add('task/closed', verifiedTask('task-terminal', 'run-terminal-1'))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-2', [admittedChild(activeChild, 'required')]),
  )
  journal.add('run/opened', runOpened('task-active', 'run-active-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-active-1', 'batch-3', [admittedChild(grandchild, 'probe')]),
  )
  journal.add('run/opened', runOpened('task-grandchild', 'run-grandchild-1', 1))
  const cancellationFact = journal.add(
    'task/closed',
    cancelledTask('task-root', { scope: 'subtree', cut: ref('cancellation-cut-1', 90) }),
  )

  const state = reduceTaskRunFacts(journal.facts, context)
  const rootState = mustGet(state.tasks, 'task-root')
  const terminal = mustGet(state.tasks, 'task-terminal')
  const active = mustGet(state.tasks, 'task-active')
  const grandchildState = mustGet(state.tasks, 'task-grandchild')

  assert.equal(rootState.closed?.outcome, 'cancelled')
  assert.equal(rootState.closed.source, 'task/closed')
  assert.equal(terminal.closed?.outcome, 'verified')
  assert.equal(terminal.closed.source, 'task/closed')
  assert.equal(active.closed?.outcome, 'cancelled')
  assert.equal(active.closed.source, 'subtree-cancellation')
  assert.equal(grandchildState.closed?.outcome, 'cancelled')
  assert.equal(grandchildState.closed.source, 'subtree-cancellation')

  for (const runId of ['run-root-1', 'run-active-1', 'run-grandchild-1']) {
    const run = mustGet(state.runs, runId)
    assert.equal(run.phase, 'closed')
    assert.equal(run.closed?.classification, 'cancelled')
    assert.equal(run.closed.source, 'subtree-cancellation')
    assert.equal(run.closed.factDigest, cancellationFact.digest)
  }
  const terminalRun = mustGet(state.runs, 'run-terminal-1')
  assert.equal(terminalRun.closed?.classification, 'verified')
  assert.equal(terminalRun.closed.source, 'run/closed')
  assert.equal(state.runs.size, 4)

  const lateRunClose = appendFact(
    journal.facts,
    'run/closed',
    cancelledExecutionClosed('run-root-1'),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, lateRunClose], context),
    'RUN_ALREADY_CLOSED',
  )

  const lateTaskClose = appendFact(
    journal.facts,
    'task/closed',
    cancelledTask('task-active'),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, lateTaskClose], context),
    'TASK_ALREADY_CLOSED',
  )

  const invalidSubtreeOutcome = appendFact(
    journal.facts.slice(0, -1),
    'task/closed',
    { ...failedTask('task-root'), scope: 'subtree' },
  )
  expectReducerError(
    () =>
      reduceTaskRunFacts(
        [...journal.facts.slice(0, -1), invalidSubtreeOutcome],
        context,
      ),
    'CANCELLATION_INVALID',
  )
})

void test('rejects unsupported fact types and illegal lifecycle transitions', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const methodFact = new Journal().add('method/registered', { revision: baseMethodRef })
  expectReducerError(
    () => reduceTaskRunFacts([methodFact], context),
    'UNSUPPORTED_FACT_TYPE',
  )

  const journal = new Journal()
  const admittedFact = journal.add('task/admitted', {
    taskId: 'task-root',
    contract: contractRef(root),
  })
  const duplicateTask = appendFact(journal.facts, 'task/admitted', {
    taskId: 'task-root',
    contract: contractRef(root),
  })
  expectReducerError(
    () => reduceTaskRunFacts([admittedFact, duplicateTask], context),
    'DUPLICATE_TASK',
  )

  const runOpenedFact = appendFact(journal.facts, 'run/opened', runOpened('task-root', 'run-root-1', 1))
  const prefix = [...journal.facts, runOpenedFact]
  const submittedFact = appendFact(prefix, 'run/submitted', submitted('run-root-1'))
  const duplicatedSubmit = appendFact(
    [...prefix, submittedFact],
    'run/submitted',
    submitted('run-root-1'),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...prefix, submittedFact, duplicatedSubmit], context),
    'RUN_NOT_OPEN',
  )

  const verifiedWithoutSubmit = appendFact(
    prefix,
    'run/closed',
    verifiedClosed('run-root-1'),
  )
  expectReducerError(
    () => reduceTaskRunFacts([...prefix, verifiedWithoutSubmit], context),
    'RUN_CLASSIFICATION_INVALID',
  )

  const closedFact = appendFact(
    [...prefix, submittedFact],
    'run/closed',
    verifiedClosed('run-root-1'),
  )
  const afterClose = [...prefix, submittedFact, closedFact]
  const secondClose = appendFact(afterClose, 'run/closed', verifiedClosed('run-root-1'))
  expectReducerError(
    () => reduceTaskRunFacts([...afterClose, secondClose], context),
    'RUN_ALREADY_CLOSED',
  )

  const submitAfterClose = appendFact(afterClose, 'run/submitted', submitted('run-root-1'))
  expectReducerError(
    () => reduceTaskRunFacts([...afterClose, submitAfterClose], context),
    'RUN_ALREADY_CLOSED',
  )

  const missingDecisive = appendFact(afterClose, 'task/closed', {
    taskId: 'task-root',
    outcome: 'verified',
    reason: 'Verified without a decisive Run',
    evidenceRefs: [evidence('run-root-1')],
  })
  expectReducerError(
    () => reduceTaskRunFacts([...afterClose, missingDecisive], context),
    'TASK_OUTCOME_INVALID',
  )

  const wrongEvidence = appendFact(afterClose, 'task/closed', {
    ...verifiedTask('task-root', 'run-root-1'),
    evidenceRefs: [ref('wrong-evidence', 99)],
  })
  expectReducerError(
    () => reduceTaskRunFacts([...afterClose, wrongEvidence], context),
    'EVIDENCE_MISMATCH',
  )

  const failedWithoutRun = appendFact(journal.facts, 'task/closed', failedTask('task-root'))
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, failedWithoutRun], context),
    'TASK_OUTCOME_INVALID',
  )

  const duplicateTaskClose = appendFact(afterClose, 'task/closed', cancelledTask('task-root'))
  const duplicateTaskClose2 = appendFact(
    [...afterClose, duplicateTaskClose],
    'task/closed',
    cancelledTask('task-root'),
  )
  expectReducerError(
    () =>
      reduceTaskRunFacts(
        [...afterClose, duplicateTaskClose, duplicateTaskClose2],
        context,
      ),
    'TASK_ALREADY_CLOSED',
  )
})

void test('submit requires no active child batch', () => {
  const root = makeRootContract()
  const context = makeContext([root])
  const child = makeChildContract({ taskId: 'task-child' })
  const journal = new Journal()
  journal.add('task/admitted', { taskId: 'task-root', contract: contractRef(root) })
  journal.add('run/opened', runOpened('task-root', 'run-root-1', 1))
  journal.add(
    'task/children-admitted',
    admission('run-root-1', 'batch-1', [admittedChild(child, 'required')]),
  )
  const earlySubmit = appendFact(journal.facts, 'run/submitted', submitted('run-root-1'))
  expectReducerError(
    () => reduceTaskRunFacts([...journal.facts, earlySubmit], context),
    'CHILD_ACTIVE',
  )
})
