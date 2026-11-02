import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { SessionId } from '@deepseek-ai/dsh-session'
import { computeDigestBytes } from '@singularity/protocol'
import { createSkillResourceRoot,createWakeMessage,DomainStore,materializeSkills,registerSkills,removeSkillResourceRoot } from '@singularity/runtime'

import { freezeBuckyballSkills,readBuckyballSkills } from '../examples/buckyball-skills.ts'
import { messageTexts } from './fixtures/chat-completions.ts'
import { withHarness } from './run-fixture.ts'
import { agentOptions,fixtureUsage } from './task-fixture.ts'

void test('Buckyball freezes adapted skills with all resources and loads dependencies by native registered name', { timeout: 120_000 }, async () => {
  let sourceDigest = ''
  await withHarness((request, index) => {
    const texts = messageTexts(request).join('\n')
    if (index === 1) {
      assert.ok(texts.includes('skill(name="model-optimize")'))
      assert.equal(texts.includes('OLD FULL-MODEL P2E GATE'), false)
    }
    if (index === 2) {
      assert.ok(texts.includes('Bank reuse and scheduling'))
      assert.equal(texts.includes('OLD FULL-MODEL P2E GATE'), false)
      return { content: 'Both native skills and their frozen resources were consumed.', usage: fixtureUsage(index) }
    }
    return { toolCalls: [{ id: `load-${String(index)}`, name: 'skill', arguments: JSON.stringify({ name: index === 0 ? 'model-port' : 'model-optimize' }) }], usage: fixtureUsage(index) }
  }, async ({ spike, workspace, storeRoot, fixture }) => {
    const baseline = join(workspace, 'baseline')
    for (const name of ['model-port', 'model-optimize', 'chip-designer', 'ip-designer', 'ball-align', 'workload-tests', 'debug-compiler', 'check', 'report']) {
      const path = join(baseline, '.agents/skills', name)
      await mkdir(path, { recursive: true })
      const original = 'OLD FULL-MODEL P2E GATE\n'
      await writeFile(join(path, 'SKILL.md'), original)
      sourceDigest = computeDigestBytes('object', new TextEncoder().encode(original))
    }
    const port = join(baseline, '.agents/skills/model-port')
    await mkdir(join(port, 'references'))
    await mkdir(join(port, 'scripts'))
    await writeFile(join(port, 'references/interface.txt'), 'frozen interface details\n')
    await writeFile(join(port, 'scripts/report.mjs'), 'console.log(JSON.stringify({cases:3,mismatches:0}))\n')
    const store = await DomainStore.open(storeRoot)
    const resourceRoot = await createSkillResourceRoot(workspace)
    try {
      const assets = await freezeBuckyballSkills(store, baseline)
      const resources = await readBuckyballSkills(store, assets)
      const mounted = await materializeSkills(resources, resourceRoot)
      const modelPort = mounted.find(skill => skill.name === 'model-port')
      assert.ok(modelPort)
      const base = modelPort.resourceBase.path
      assert.equal(await readFile(join(base, 'references/interface.txt'), 'utf8'), 'frozen interface details\n')
      assert.deepEqual(JSON.parse(execFileSync(process.execPath, [join(base, 'scripts/report.mjs')], { encoding: 'utf8' })), { cases: 3, mismatches: 0 })
      const provenance = JSON.parse(await readFile(join(base, 'ADAPTATION.json'), 'utf8')) as { sourceFiles: { path: string; digest: string }[]; entrypoint: { digest: string } }
      assert.equal(provenance.sourceFiles.find(file => file.path === 'SKILL.md')?.digest, sourceDigest)
      assert.equal(provenance.entrypoint.digest, computeDigestBytes('object', await readFile(join(base, 'SKILL.md'))))
      assert.deepEqual(provenance.sourceFiles.map(file => file.path), ['SKILL.md', 'references/interface.txt', 'scripts/report.mjs'])
      const handle = await spike.ctx.agents.create({ sessionId: SessionId('buckyball-frozen-skills'), meta: { cwd: workspace }, agentOptions: agentOptions(),
        setup: async scope => {
          await registerSkills(scope, mounted)
          scope.tools.restrict({ allow: ['skill'] })
        } })
      try {
        handle.agent.followup(createWakeMessage({ wakeId: 'skills', text: 'Read model-port and its design dependency through their registered names.' }))
        await handle.agent.whenIdle()
        assert.equal(fixture.requests.length, 3)
      } finally { await handle.dispose() }
    } finally {
      await removeSkillResourceRoot(resourceRoot)
      await store.close()
    }
  })
})
