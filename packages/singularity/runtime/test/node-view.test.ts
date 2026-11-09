import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskContract, TaskTemplate } from '@singularity/protocol'

import { renderLiveNodeView } from '../src/node-view.ts'
import type { RunToolController } from '../src/tools.ts'
import { initialContextEpoch } from '../src/epoch.ts'

const contract = {
  taskId: 'task-node-view',
  origin: { kind: 'root', purpose: 'work' },
  digest: `sha256:${'a'.repeat(64)}`,
  method: { id: 'method', digest: `sha256:${'b'.repeat(64)}` },
  spec: {
    goal: { summary: 'preflight', deliverable: 'out', scope: [], constraints: [] },
    criteria: [],
    inputs: [],
    outputs: [],
  },
  acceptance: { id: 'acceptance', digest: `sha256:${'c'.repeat(64)}` },
} as unknown as TaskContract

function template(childCount: number, briefLength: number): TaskTemplate {
  return {
    id: 'template',
    brief: 'template brief',
    children: Array.from({ length: childCount }, (_value, index) => ({
      bindingId: `binding-${String(index)}`,
      templateId: 'child-template',
      brief: 'x'.repeat(briefLength),
      join: 'probe' as const,
    })),
  } as unknown as TaskTemplate
}

const controller = {
  snapshot: () => ({ contextEpoch: initialContextEpoch('session-node-view') }),
  obligations: () => ({
    readSelf: true, readPlanningSketch: true, requiredFailure: false,
    denialCodes: ['READ_SELF_FIRST'],
  }),
} as unknown as RunToolController

void test('live NodeView rejects an over-budget child catalog', () => {
  assert.throws(() => { renderLiveNodeView({
    contract,
    runId: 'run-node-view',
    workspace: '/workspace',
    baseToolNames: [],
    template: template(40, 300),
    skills: [],
    mcpServers: [],
    budget: { tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 },
    lastAttempt: null,
    asOf: 1,
    contextEpoch: initialContextEpoch('session-node-view'),
    controller,
  }) }, /NodeView.*above the 8192 byte budget/)
})

void test('live NodeView renders the complete catalog within 8 KiB', () => {
  assert.doesNotThrow(() => { renderLiveNodeView({
    contract,
    runId: 'run-node-view',
    workspace: '/workspace',
    baseToolNames: [],
    template: template(2, 20),
    skills: [],
    mcpServers: [],
    budget: { tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 },
    lastAttempt: null,
    asOf: 1,
    contextEpoch: initialContextEpoch('session-node-view'),
    controller,
  }) })
})

void test('NodeView keeps current acceptance and paths visible without repeating scripts', () => {
  const current = { ...contract, spec: { ...contract.spec,
    criteria: [{ id: 'consumer', statement: 'Use original bytes through the consumer.', required: true, check: 'x'.repeat(20_000) }],
    inputs: [{ id: 'data', path: 'input.bin', access: 'read' as const, object: contract.method }],
  } }
  const text = renderLiveNodeView({ contract: current, runId: 'run', workspace: '/workspace', baseToolNames: ['bash'],
    template: template(0, 0), skills: [], mcpServers: [], budget: { tokensPct: 100, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 },
    lastAttempt: null, asOf: 1, contextEpoch: initialContextEpoch('session-node-view'), controller,
    children: { requiredObligations: [], childBatch: null, childHistory: { total: 1, outcomes: { verified: 1 } },
      recentChildResults: [{ id: 'child', batchId: 'batch', outcome: 'verified', publicReason: null, outputsPath: 'children/child' }] },
  })
  assert.ok(text.includes('Use original bytes through the consumer.'))
  assert.ok(text.includes('input.bin') && text.includes('children/child'))
  assert.ok(text.includes('"deliverable":"out"'))
  assert.equal(text.includes('x'.repeat(100)), false)
})
