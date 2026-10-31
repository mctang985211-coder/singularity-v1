import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TaskContract, TaskTemplate } from '@singularity/protocol'

import { MethodResourceError } from '../src/errors.ts'
import { preflightNodeView, renderLiveNodeView } from '../src/node-view.ts'
import { initialContextEpoch } from '../src/epoch.ts'
import { NODE_VIEW_MAX_BYTES } from '../src/prompt.ts'
import { DomainStore } from '../src/store.ts'
import { RunToolController } from '../src/tools.ts'

const contract = {
  taskId: 'task-node-view',
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

void test('S4-B1 static NodeView preflight rejects an over-budget child catalog', () => {
  assert.throws(() => { preflightNodeView({
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
  }) }, (error: unknown) =>
    error instanceof MethodResourceError
    && error.code === 'CONTRACT_INVALID'
    && error.message.includes('static NodeView'))
})

void test('S4-B1 static NodeView preflight accepts the same catalog within 8 KiB', () => {
  assert.doesNotThrow(() => { preflightNodeView({
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
  }) })
})

void test('S4-B1 conservative preflight bounds the post-plan live NodeView at the near-cap edge', async () => {
  const workspace = resolve('relative-workspace')
  const catalog = (briefLength: number) => ({
    contract,
    runId: 'run-node-view',
    workspace,
    baseToolNames: [],
    template: template(1, briefLength),
    skills: [],
    mcpServers: [],
    budget: { tokensPct: null, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 },
    lastAttempt: null,
    asOf: 1,
    contextEpoch: initialContextEpoch('session-node-view'),
  })
  const passes = (briefLength: number): boolean => {
    try {
      preflightNodeView(catalog(briefLength))
      return true
    } catch {
      return false
    }
  }
  let low = 0
  let high = 16 * 1024
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (passes(middle)) low = middle
    else high = middle - 1
  }
  assert.ok(low > 0)
  assert.equal(passes(low), true)
  assert.equal(passes(low + 1), false)

  const root = await mkdtemp(join(tmpdir(), 's4b1-node-view-'))
  const store = await DomainStore.open({ root })
  try {
    const sessionId = 'session-node-view'
    const contextEpoch = initialContextEpoch(sessionId)
    const agent = { session: { id: sessionId, snapshotEvents: () => [] } } as unknown as Agent
    const callId = 'node-view-call' as ToolRunContext['callId']
    const execution = (name: string, args: unknown = {}): ToolRunContext => ({
      name, agent, arguments: args, callId, rootCallId: callId,
      token: Symbol() as ToolRunContext['token'], signal: new AbortController().signal,
      deferContext() {}, concludeTurn() {},
    })
    const definitions = new Map<string, ToolDefinition>()
    const controller = new RunToolController({
      contract,
      runId: 'run-node-view',
      sessionId,
      workspace,
      skillNames: [],
      mcpPlan: { serverNames: [], publicToolNames: [], resourceToolNames: [] },
      childBindingIds: ['binding-0'],
      writer: store,
      maxOutputBytes: 1024,
      clock: () => 1,
      budget: () => ({ tokensPct: null, stepsPct: 100, wallClockPct: 100, depthPct: 100, taskSlotsPct: 100 }),
      checkBudget: () => true,
      epoch: () => contextEpoch,
      commitSubmission: frozen => Promise.resolve(frozen.manifestRef),
    })
    controller.register({ get: () => ({ list: () => [] }), tools: {
      register: (definition: ToolDefinition) => {
        definitions.set(definition.name, definition)
        return () => undefined
      },
      guard() {},
    } } as unknown as Context, agent)
    const read = definitions.get('singularity_read')
    const plan = definitions.get('singularity_plan')
    assert.ok(read && plan)
    let cursor: string | undefined
    do {
      const page = await read.execute(
        { kind: 'self', ...(cursor === undefined ? {} : { cursor }) },
        execution('singularity_read'),
      ) as { readonly nextCursor?: string }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    await plan.execute({ sketch: {
      v: 1,
      taskId: contract.taskId,
      runId: 'run-node-view',
      contextEpoch,
      objective: 'near-cap live NodeView',
      sourceContract: contract.digest,
      levels: [0, 1].map(level => ({
        level, purpose: 'current level', likelyChildren: [], expectedInputs: [], expectedOutputs: [],
      })),
      directPlan: [],
      assumptions: [],
    } }, execution('singularity_plan'))
    const live = renderLiveNodeView({ ...catalog(low), controller })
    assert.ok(
      Buffer.byteLength(live) <= NODE_VIEW_MAX_BYTES,
      `post-plan live NodeView ${String(Buffer.byteLength(live))} exceeds ${String(NODE_VIEW_MAX_BYTES)}`,
    )
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(passes(low + 1), false, 'the over-cap catalog must be rejected before admission')
})
