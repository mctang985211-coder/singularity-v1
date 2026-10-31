import assert from 'node:assert/strict'
import test from 'node:test'

import type { Ref } from '@singularity/protocol'

import {
  deriveContextEpochFromEvents,
  initialContextEpoch,
} from '../src/epoch.ts'
import {
  EXPLORATION_CARD,
  NODE_VIEW_MAX_BYTES,
  WORKER_CARD,
  WORKER_CARD_MAX_BYTES,
  clampPercent,
  renderNodeView,
  renderWorkerCard,
} from '../src/prompt.ts'
import type { NodeView, RemainingBudgetPct } from '../src/prompt.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const method: Ref = { id: 'method', digest: digestA }

const budget: RemainingBudgetPct = {
  tokensPct: 73,
  stepsPct: 50,
  wallClockPct: 99,
  depthPct: 100,
  taskSlotsPct: 90,
}

function makeView(): NodeView {
  return {
    v: 1,
    asOf: 1000,
    contextEpoch: initialContextEpoch('session-prompt'),
    task: {
      id: 'task',
      runId: 'run',
      goalSummary: 'goal',
      contractDigest: digestA,
      phase: 'working',
      mode: 'guided',
    },
    method,
    ownTemplate: { id: 'template', brief: 'brief' },
    documents: [],
    skills: [],
    tools: [{ name: 'bash' }],
    childOptions: [],
    requiredObligations: [],
    childBatch: null,
    childHistory: { total: 0, outcomes: {} },
    recentChildResults: [],
    obligations: {
      readSelf: true,
      readPlanningSketch: false,
      requiredFailure: false,
      canDecompose: false,
      canSubmit: false,
      denialCodes: ['READ_SELF_FIRST'],
    },
    planningSketchRef: null,
    feedback: { count: 0 },
    lastAttempt: null,
    budget,
    workspace: { cwd: '/workspace', outputs: [] },
  }
}

void test('worker card and NodeView stay inside the fixed prompt budgets', () => {
  const plain = renderWorkerCard(false)
  assert.ok(new TextEncoder().encode(plain).byteLength <= WORKER_CARD_MAX_BYTES)
  assert.ok(new TextEncoder().encode(`${WORKER_CARD}\n\n${EXPLORATION_CARD}`).byteLength <= WORKER_CARD_MAX_BYTES)
  assert.deepEqual([...new Set(plain.match(/singularity_\w+/g))].sort(), [
    'singularity_decompose',
    'singularity_plan',
    'singularity_read',
    'singularity_stop',
    'singularity_submit',
  ])
  assert.ok(plain.includes('When childOptions is empty'))
  assert.ok(plain.includes('BINDING_FIXED'))
  assert.throws(() => renderWorkerCard(true), /requires S4/)

  const rendered = renderNodeView(makeView())
  assert.ok(new TextEncoder().encode(rendered).byteLength <= NODE_VIEW_MAX_BYTES)
  const parsed = JSON.parse(rendered) as NodeView
  assert.deepEqual(parsed.budget, budget)
  for (const value of Object.values(parsed.budget)) {
    if (value === null) continue
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 100)
  }
  assert.equal(rendered.includes('maxTokens'), false)
  assert.equal(rendered.includes('deadlineAt'), false)
})

void test('context epochs are deterministic and change only on resume or successful compaction', () => {
  const initial = initialContextEpoch('session-epoch')
  assert.equal(initial, initialContextEpoch('session-epoch'))
  assert.notEqual(initial, initialContextEpoch('other-session'))
  assert.equal(deriveContextEpochFromEvents('session-epoch', []), initial)

  const resumed = deriveContextEpochFromEvents('session-epoch', [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'session/end-seed', seq: 1, data: {} },
  ])
  assert.notEqual(resumed, initial)

  const compacted = deriveContextEpochFromEvents('session-epoch', [
    { type: 'compaction/start', seq: 0, data: { compactionId: 'c1' } },
    { type: 'compaction/end', seq: 1, data: { compactionId: 'c1' } },
  ])
  assert.notEqual(compacted, initial)

  const failedCompaction = deriveContextEpochFromEvents('session-epoch', [
    { type: 'compaction/start', seq: 0, data: { compactionId: 'c2' } },
    { type: 'compaction/end', seq: 1, data: { compactionId: 'c2', error: 'boom' } },
  ])
  assert.equal(failedCompaction, initial)
})

void test('clampPercent floors, clamps, and handles unknown totals', () => {
  assert.equal(clampPercent(50, 100), 50)
  assert.equal(clampPercent(99.9, 100), 99)
  assert.equal(clampPercent(-1, 100), 0)
  assert.equal(clampPercent(101, 100), 100)
  assert.equal(clampPercent(1, 0), 0)
  assert.equal(clampPercent(Number.NaN, 100), 0)
})
