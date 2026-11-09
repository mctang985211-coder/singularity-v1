import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { EXPLORE_TEMPLATE_ID, sealMethodRevision, sealTaskContract } from '@singularity/protocol'
import { CommandService, executeSingleRun, freezeGlobalResources, loadMethodResources } from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import { contextEpochFrom, messageTexts, toolSchemaNames } from './fixtures/chat-completions.ts'
import { mcpToolReply, s4a3Server, s4b2Example, withS4a3Tmp } from './method-fixture.ts'
import { contractPayload, methodPayload, passingVerifier, planReply, submitReply, withHarness, writeOutputReply } from './run-fixture.ts'
import { agentOptions, fixtureUsage, jsonBytes, makeScenario } from './task-fixture.ts'
import type { Scenario } from './task-fixture.ts'

for (const arm of ['empty-baseline', 'candidate-with-children'] as const) {
  void test(`${arm} invokes the same public MCP with no Method tool copies`, { timeout: 240_000 }, async () => {
    const taskId = `public-${arm}-${String(process.pid)}`, runId = `${taskId}:run`
    let scenario: Scenario | undefined
    await withS4a3Tmp(() => withHarness((request, index) => {
      assert.ok(scenario)
      assert.ok(toolSchemaNames(request).includes('mcp__calc__echo'))
      if (index === 0) return { toolCalls: [{ id: 'self', name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }], usage: fixtureUsage(index) }
      if (index === 1) return planReply(scenario, taskId, runId, contextEpochFrom(request) ?? '')
      if (index === 2) return mcpToolReply('mcp__calc__echo', { message: 'public-environment-observed' }, 'echo', index)
      if (index === 3) {
        assert.ok(messageTexts(request).some(text => text.includes('public-environment-observed')))
        return writeOutputReply()
      }
      return submitReply()
    }, async ({ spike, storeRoot, workspace, fixture }) => {
      const original = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1,
        mcpServers: [await s4a3Server(join(storeRoot, 'public-mcp.log'))],
        childBinding: { bindingId: 'optional', templateId: 'optional-child', brief: 'Optional responsibility.', join: 'required', example: s4b2Example() } })
      const service = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
      try {
        const snapshot = await freezeGlobalResources(service, 'public', { documents: [], skills: [], tools: original.method.tools,
          baseTools: original.contract.resources.baseTools, fallbackAcceptance: original.contract.acceptance })
        const { entryTemplateId: _entry, ...originalPayload } = methodPayload(original.method)
        void _entry
        const method = sealMethodRevision({ ...originalPayload, id: `method:${arm}`,
          ...(arm === 'empty-baseline' ? {} : { entryTemplateId: original.method.entryTemplateId }),
          templates: arm === 'empty-baseline' ? [] : original.method.templates.map(template => ({ ...template, tools: [] })), tools: [] })
        const methodRef = await service.putObject(method.id, jsonBytes(method), 'method')
        const contract = sealTaskContract({ ...contractPayload(original.contract), method: methodRef,
          template: { id: arm === 'empty-baseline' ? EXPLORE_TEMPLATE_ID : original.contract.template.id, digest: method.digest },
          resources: { ...original.contract.resources, exploration: snapshot } })
        const composition = await buildSingleRunComposition(spike.ctx, { store: service, id: runId, contract, agentOptions: agentOptions(), base: { v: 1, seed: contract.environment.seed } })
        scenario = { ...original, method, contract, composition }
        assert.equal(method.tools.length, 0)
        assert.deepEqual(composition.mcpServers.map(server => server.bundle), contract.resources.mcpServers)
        const resources = await loadMethodResources(service, contract)
        assert.equal(resources.template.children.length, arm === 'empty-baseline' ? 1 : original.method.templates[0].children.length)
        if (arm === 'candidate-with-children') {
          const child = original.method.templates.find(template => template.id === 'optional-child')
          assert.ok(child)
          const childContract = sealTaskContract({ ...contractPayload(contract), taskId: `${taskId}:child`, template: { id: child.id, digest: method.digest } })
          assert.deepEqual((await loadMethodResources(service, childContract)).mcpServers.map(server => server.bundle), contract.resources.mcpServers)
        }
        const result = await executeSingleRun({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId, sessionId: `${runId}:session`,
          admission: { ...original.runAdmission, contract }, composition, agentOptions: agentOptions(), verifier: passingVerifier(scenario, runId, workspace, []), maxOutputBytes: 1024 }, service)
        assert.equal(result.kind, 'settled')
        assert.equal(result.classification, 'verified')
        assert.equal(fixture.requests.length, 5)
        const conflicting = sealMethodRevision({ ...methodPayload(method), id: 'conflict', tools: original.method.tools })
        const conflictRef = await service.putObject(conflicting.id, jsonBytes(conflicting), 'method')
        const conflictContract = sealTaskContract({ ...contractPayload(contract), method: conflictRef, template: { ...contract.template, digest: conflictRef.digest } })
        await assert.rejects(loadMethodResources(service, conflictContract), /public asset.*conflicts/)
      } finally { await service.close() }
    }))
  })
}
