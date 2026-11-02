import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  INVENTORY_CASES, INVENTORY_CHILD_BINDING, INVENTORY_CHILD_TEMPLATE, INVENTORY_ROOT_TEMPLATE,
  INVENTORY_VERIFIER_ASSET, INVENTORY_RECIPE, INVENTORY_RECIPE_REF, describeInventoryCheck, inventoryCheck, inventoryGuidedBaseline, inventoryTaskSpec, reconcileInventory, verifyInventory,
} from '@singularity/domain-inventory'
import { admitRootTask, canonicalize, parseJsonText } from '@singularity/protocol'
import type { TaskContract } from '@singularity/protocol'
import { CommandService, executeTaskTree, freezeGlobalResources } from '@singularity/runtime'
import type { RunVerifier } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts } from './fixtures/chat-completions.ts'
import { previewDigestFrom } from './method-fixture.ts'
import { withHarness } from './run-fixture.ts'
import { agentOptions, fixtureUsage, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

void test('guided inventory Method integrates a required independently accepted report through the ordinary maxActive=1 Task path', { timeout: 240_000 }, async () => {
  const taskId = `inventory-guided-${String(process.pid)}-${String(Date.now())}`
  const runId = `${taskId}:run`
  const csv = INVENTORY_CASES[1].csv
  const expected = reconcileInventory(csv)
  let scenario: Scenario | undefined
  let child: TaskContract | undefined
  let childRunId = ''
  const verified: string[] = []
  await withHarness((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `inventory-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: fixtureUsage(index) })
    assert.ok(scenario)
    if (index === 0 || index === 5 || index === 9) return call('singularity_read', { kind: 'self' })
    if (index === 1 || index === 6 || index === 10) {
      const current = index === 6 ? child : scenario.contract
      assert.ok(current)
      const isRoot = current.taskId === taskId
      return call('singularity_plan', { sketch: { v: 1, taskId: current.taskId,
        runId: isRoot ? runId : childRunId,
        contextEpoch: contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '',
        objective: current.spec.goal.summary,
        levels: [
          { level: 0, purpose: isRoot ? 'Inspect input and integrate the accepted direct report.' : 'Calculate the full inventory report.',
            likelyChildren: isRoot ? [INVENTORY_CHILD_BINDING] : [], expectedInputs: ['transactions.csv'], expectedOutputs: ['report.json'] },
          { level: 1, purpose: isRoot ? 'Independently reconcile the same authorized CSV.' : 'No direct work is missing.',
            likelyChildren: [], expectedInputs: isRoot ? ['transactions.csv'] : [], expectedOutputs: isRoot ? ['report.json'] : [] },
        ],
        directPlan: isRoot ? [{ bindingId: INVENTORY_CHILD_BINDING, purpose: 'Obtain the required full reconciliation report.' }] : [],
        assumptions: ['The supplied CSV and rules are sufficient.'], sourceContract: current.digest,
      } })
    }
    if (index === 2) return call('bash', { command: 'cat transactions.csv' })
    if (index === 3) return call('singularity_decompose', { action: 'prepare', bindingId: INVENTORY_CHILD_BINDING })
    if (index === 4) {
      assert.match(messageTexts(request).join('\n'), /BOLT,4/)
      return call('singularity_decompose', { action: 'commit', children: [{ bindingId: INVENTORY_CHILD_BINDING,
        ackPreview: previewDigestFrom(request), task: { goal: inventoryTaskSpec(scenario.contract.spec.inputs[0].object).goal,
          localCriteria: [], inputs: scenario.contract.spec.inputs, localOutputs: [], acceptanceChecks: [] } }] })
    }
    if (index === 7) {
      assert.match(messageTexts(request).join('\n'), /explore-child/)
      return call('bash', { command: `printf '%s' '${JSON.stringify(expected)}' > report.json` })
    }
    if (index === 8 || index === 13) return call('singularity_submit', { outputIds: ['report'], includeLearningDrafts: false })
    if (index === 11) {
      assert.match(messageTexts(request).join('\n'), /reason=children-terminal/)
      return call('singularity_read', { kind: 'children' })
    }
    if (index === 12) {
      assert.ok(child)
      assert.match(messageTexts(request).join('\n'), /"status":"winner"/)
      // The fixture parent recalculates from its own input before integrating the frozen report.
      const integrate = `const fs = require("node:fs"); const assert = require("node:assert/strict"); const rows = fs.readFileSync("transactions.csv", "utf8").trimEnd().split("\\n").slice(1); const totals = new Map(); for (const row of rows) { const [sku, delta] = row.split(","); totals.set(sku, (totals.get(sku) ?? 0) + Number(delta)); } const expected = {rowCount:rows.length,totals:[...totals].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([sku,quantity]) => ({sku,quantity}))}; const actual = JSON.parse(fs.readFileSync("children/${encodeURIComponent(child.taskId)}/report", "utf8")); assert.deepEqual(actual, expected); fs.writeFileSync("report.json", JSON.stringify(actual));`
      return call('bash', { command: `node -e '${integrate}'` })
    }
    return { content: `Unexpected fixture request ${String(index)}.`, usage: fixtureUsage(index) }
  }, async ({ spike, storeRoot, workspace, fixture }) => {
    const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, maxStepsPerRun: 12, maxDepth: 2, maxTasks: 3 })
    const writer = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value))
    try {
      await writer.putObject(INVENTORY_RECIPE_REF.id, bytes(INVENTORY_RECIPE))
      const fallbackExample = await writer.putObject('inventory:example:fallback', bytes({ goal: inventoryTaskSpec(original.contract.spec.inputs[0].object).goal, inputs: [{ id: 'transactions', exampleText: csv }], localCriteria: [], localOutputs: [{ id: 'report', path: 'report.json', kind: 'file', description: 'Exact inventory report for independent checking.' }], acceptanceChecks: [{ criterionId: 'task-goal', checks: [inventoryCheck()] }] }))
      const provider = await writer.putObject('inventory:verifier', bytes(INVENTORY_VERIFIER_ASSET))
      const baseline = inventoryGuidedBaseline(provider)
      for (const asset of baseline.assets) assert.deepEqual(await writer.putObject(asset.ref.id, bytes(asset.value)), asset.ref)
      const method = await writer.putObject(baseline.method.id, bytes(baseline.method), 'method')
      const input = await writer.putObject('inventory:transactions', new TextEncoder().encode(csv))
      const exploration = await freezeGlobalResources(writer, 'inventory:global-resources', { documents: [], skills: [], tools: [],
        baseTools: original.contract.resources.baseTools, fallbackExample, fallbackAcceptance: provider, fallbackJoin: 'probe' })
      assert.equal(original.contract.origin.kind, 'root')
      const contract = admitRootTask({ taskId, spec: inventoryTaskSpec(input), origin: original.contract.origin, method,
        template: { id: INVENTORY_ROOT_TEMPLATE, digest: method.digest },
        resources: { ...original.contract.resources, exploration }, acceptance: provider,
        environment: original.contract.environment, limits: original.contract.limits })
      const composition = await buildSingleRunComposition(spike.ctx, { store: writer, id: runId, contract,
        agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
      scenario = { ...original, contract, composition, method: baseline.method, provider,
        runAdmission: { ...original.runAdmission, contract, acceptanceBytes: bytes(INVENTORY_VERIFIER_ASSET),
          budgetReservation: { ...original.runAdmission.budgetReservation, steps: contract.limits.maxStepsPerRun } } }
      const verifier = (current: TaskContract): RunVerifier => ({ provider: current.acceptance, describeCheck: describeInventoryCheck,
        async verify(request) {
          assert.equal(request.inputs[0].digest, input.digest)
          verified.push(current.taskId)
          return verifyInventory(request, writer)
        },
      })
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
        admission: scenario.runAdmission, composition, agentOptions: agentOptions(), verifier: verifier(contract), maxOutputBytes: 4096,
        maxActive: 1, workspaceRoot: join(workspace, 'runs'),
        async resolveRun(request) {
          child = request.contract; childRunId = request.runId
          return { composition: await buildSingleRunComposition(spike.ctx, { store: writer, id: request.runId,
            contract: request.contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } }),
            agentOptions: agentOptions(), verifier: verifier(request.contract), maxOutputBytes: 4096 }
        },
      }, writer)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.equal(result.runs.length, 2)
      assert.ok(child)
      assert.equal(child.template.id, INVENTORY_CHILD_TEMPLATE)
      assert.deepEqual(child.method, contract.method)
      assert.deepEqual(child.acceptance, provider)
      assert.deepEqual(verified, [child.taskId, taskId])
      assert.deepEqual(result.root.receipt?.criteria.map(value => [value.id, value.verdict]), [['inventory-exact', 'pass']])
      assert.equal(result.root.receipt.inputDigests.length, 2)
      assert.equal(canonicalize(parseJsonText(await readFile(join(workspace, 'report.json'), 'utf8'))), canonicalize(expected))
      assert.equal(fixture.requests.length, 14)
      const state = await writer.taskRunState([])
      assert.equal(state.tasks.get(child.taskId)?.join, 'required')
      assert.equal(state.tasks.get(child.taskId)?.closed?.outcome, 'verified')
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
    } finally {
      await writer.close()
    }
    const replay = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    try {
      const state = await replay.taskRunState([])
      assert.equal(state.tasks.get(taskId)?.closed?.outcome, 'verified')
      assert.equal([...state.tasks.values()].filter(value => value.phase === 'closed').length, 2)
      assert.equal([...state.runs.values()].filter(value => value.phase === 'closed').length, 2)
    } finally { await replay.close() }
  })
})
