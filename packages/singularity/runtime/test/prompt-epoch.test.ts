import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '@deepseek-ai/dsh-session'

import type { Ref } from '@singularity/protocol'

import {
  deriveContextEpoch,
  initialContextEpoch,
} from '../src/epoch.ts'
import {
  EXPLORATION_CARD,
  NODE_VIEW_MAX_BYTES,
  WORKER_CARD,
  WORKER_PERSONA,
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
  assert.ok(new TextEncoder().encode(renderWorkerCard(true)).byteLength <= WORKER_CARD_MAX_BYTES)
  assert.ok(new TextEncoder().encode(`${WORKER_PERSONA}\n\n${WORKER_CARD}\n\n${EXPLORATION_CARD}`).byteLength <= WORKER_CARD_MAX_BYTES)
  assert.deepEqual([...new Set(plain.match(/singularity_\w+/g))].sort(), [
    'singularity_decompose',
    'singularity_feedback',
    'singularity_plan',
    'singularity_read',
    'singularity_stop',
    'singularity_submit',
  ])
  assert.ok(plain.includes('ackPreview'), 'the current card must explain the commit acknowledgement')
  assert.ok(plain.includes('children'), 'the current card must explain the commit batch')
  assert.ok(!plain.includes('Child commit is not available yet'), 'the card must match the implemented commit tool')
  assert.ok(renderWorkerCard(true).includes('Instantiate executable checks'))

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

void test('context epochs follow native lifecycle and replacement generations', () => {
  const session = (firstLiveSeq: number, replaceGeneration: number) => ({
    id: 'session-epoch', firstLiveSeq, surface: { replaceGeneration },
  }) as unknown as Session
  const initial = initialContextEpoch('session-epoch')
  assert.equal(deriveContextEpoch(session(0, 0)), initial)
  assert.notEqual(initial, initialContextEpoch('other-session'))
  assert.notEqual(deriveContextEpoch(session(20, 0)), initial)
  assert.notEqual(deriveContextEpoch(session(20, 1)), deriveContextEpoch(session(20, 0)))
  assert.equal(deriveContextEpoch(session(20, 1)), deriveContextEpoch(session(20, 1)))
})

void test('clampPercent floors, clamps, and handles unknown totals', () => {
  assert.equal(clampPercent(50, 100), 50)
  assert.equal(clampPercent(99.9, 100), 99)
  assert.equal(clampPercent(-1, 100), 0)
  assert.equal(clampPercent(101, 100), 100)
  assert.equal(clampPercent(1, 0), 0)
  assert.equal(clampPercent(Number.NaN, 100), 0)
})
