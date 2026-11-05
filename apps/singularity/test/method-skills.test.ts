import assert from 'node:assert/strict'
import { readFileSync,statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'

import { join } from 'node:path'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'

import { renderSkillContent } from '@deepseek-ai/dsh-skill'

import { computeDigest } from '@singularity/protocol'
import {
executeSingleRun
} from '@singularity/runtime'

import { messageTexts,toolSchemaNames,wireText } from './fixtures/chat-completions.ts'

import {
S4A2_REFERENCE_BODY,
S4A2_SKILL_BODY,
S4A2_SKILL_DESCRIPTION,
S4A2_SKILL_NAME,
s4a2SecondSkill,
s4a2Skill,
s4a3Server,withS4a3Tmp,
} from './method-fixture.ts'
import {
captureAgentContexts,
captureAgentPrompts,
captureAgentSkills,
withHarness
} from './run-fixture.ts'
import {
agentOptions,
fixtureUsage,
makeScenario
} from './task-fixture.ts'

void test('S4-A2 skill, native jobs and MCP compose within budget and scoped discovery reads the skill', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  const skill = { ...s4a2Skill(), content: `---\nname: content-only-name\n---\n${S4A2_SKILL_BODY}` }
  let skillDirectory = ''
  await withHarness((request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen skill before continuing.',
        toolCalls: [{
          id: 's4a2-skill-call',
          name: 'skill',
          arguments: JSON.stringify({ name: S4A2_SKILL_NAME }),
        }],
        usage: fixtureUsage(index),
      }
    }
    const result = messageTexts(request).find(text => text.startsWith(`<skill_content name="${S4A2_SKILL_NAME}">`))
    assert.ok(result)
    const path = /Base directory for this skill: (.+)/.exec(result)?.[1]
    assert.ok(path, result)
    skillDirectory = path
    assert.equal(readFileSync(join(path, 'refs/notes.txt'), 'utf8'), S4A2_REFERENCE_BODY)
    assert.equal(statSync(join(path, 'refs/notes.txt')).mode & 0o222, 0)
    return { content: 'The frozen skill reference was read without submitting.', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, home, storeRoot }) => {
    await spike.ctx.plugin(await import('@deepseek-ai/dsh-tool-jobs'))
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [skill],
      baseToolNames: ['bash', 'job_output', 'job_list', 'job_kill'],
      mcpServers: [await s4a3Server(join(storeRoot, 'skill-mcp.log'))],
    })
    assert.equal(scenario.composition.skills.length, 1)
    const prompts: string[] = []
    const contexts: string[] = []
    const discovered: string[][] = []
    const createdAgents: Agent[] = []
    const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    const disposeSkills = captureAgentSkills(spike, sessionId, workspace, discovered, [])
    const disposeAgents = spike.ctx.on('agent/created', ({ agent }) => {
      if (String(agent.session.id) === sessionId) createdAgents.push(agent)
      return undefined
    })
    let result
    try {
      result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('S4-A2 create must not verify without submission') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      disposePrompts()
      disposeContexts()
      disposeSkills()
      disposeAgents()
    }

    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 2, 'the catalog step and the skill read are two requests')
    assert.equal(prompts.length, 1)
    const prompt = prompts[0]
    assert.ok(prompt)
    assert.equal(
      scenario.composition.platformPrompt,
      computeDigest('object', { v: 1, text: prompt }),
      'skill binding must not change the A1 platformPrompt',
    )
    const firstRequest = fixture.requests[0] ?? {}
    const systemMessage = firstRequest.messages?.find(message => message.role === 'system')
    assert.ok(systemMessage)
    assert.equal(wireText(systemMessage.content), prompt)
    assert.ok(toolSchemaNames(firstRequest).includes('skill'), 'the native skill tool must be visible')
    assert.ok(Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])) <= 12 * 1024)
    assert.ok(Buffer.byteLength(contexts[0] ?? '') <= 8 * 1024)

    const firstTexts = messageTexts(firstRequest)
    const catalog = firstTexts.find(text => text.includes('<available_skills>'))
    assert.ok(catalog, 'the first request must contain the bound skill discovery entry')
    assert.ok(catalog.includes(S4A2_SKILL_NAME))
    assert.ok(catalog.includes(S4A2_SKILL_DESCRIPTION))
    assert.equal(
      firstTexts.filter(text => text.includes('<available_skills>')).length,
      1,
      'the first request must contain exactly one discovery catalog',
    )
    assert.equal(
      firstTexts.some(text => text.includes(S4A2_SKILL_BODY)),
      false,
      'skill body must not be injected into system or discovery messages',
    )

    const secondTexts = messageTexts(fixture.requests[1] ?? {})
    const expectedSkillResult = renderSkillContent({
      name: S4A2_SKILL_NAME,
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: skillDirectory },
      content: skill.content,
    })
    const skillResult = secondTexts.find(text => text.startsWith(`<skill_content name="${S4A2_SKILL_NAME}">`))
    assert.equal(skillResult, expectedSkillResult, 'the native skill result must equal renderSkillContent exactly')
    assert.equal(skillDirectory, join(workspace, '.singularity/skills', `0-${scenario.composition.skills[0]?.digest.slice('sha256:'.length) ?? ''}`))
    assert.equal(skillResult.includes(S4A2_REFERENCE_BODY), false, 'referenced files are not inlined into the skill result')
    assert.equal(skillResult.includes('refs/notes.txt'), false, 'referenced paths are not exposed')
    assert.ok(Buffer.byteLength(skillResult) <= 16 * 1024)
    assert.equal(
      secondTexts.filter(text => text.includes('<available_skills>')).length,
      1,
      'the discovery catalog must not be duplicated on the next request',
    )
    const evidence = {
      systemBytes: Buffer.byteLength(prompt),
      catalogBytes: Buffer.byteLength(catalog),
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])),
      nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
      request0Bytes: Buffer.byteLength(JSON.stringify(firstRequest)),
      request1Bytes: Buffer.byteLength(JSON.stringify(fixture.requests[1] ?? {})),
      skillResultBytes: Buffer.byteLength(skillResult),
    }
    if (process.env.SINGULARITY_S4A2_EVIDENCE === '1') {
      console.log('S4-A2 byte evidence:', JSON.stringify(evidence))
    }
    assert.ok(evidence.systemBytes > 0 && evidence.catalogBytes > 0)
    assert.ok(evidence.toolSchemaBytes <= 12 * 1024)
    assert.ok(evidence.nodeViewBytes <= 8 * 1024)
    assert.deepEqual(discovered, [[S4A2_SKILL_NAME]])
    assert.deepEqual(result.usage, {
      inputTokens: 90,
      outputTokens: 16,
      steps: 2,
      unknownRequests: 0,
    })
    assert.equal(createdAgents.length, 1)
    assert.ok(contexts[0]?.includes('"skills":[{"id":"skill:s4a2","name":"s4a2-bounded-skill"}]'))
    assert.ok(contexts[0]?.includes('"name":"skill"'))

    const agent = createdAgents[0]
    assert.ok(agent)
    assert.equal(spike.ctx.agents.get(sessionId as never), undefined, 'the Run must dispose its Agent')
    assert.equal(
      await spike.ctx.skills.get(S4A2_SKILL_NAME, { scope: agent, cwd: workspace }),
      undefined,
      'disposal must remove the scoped skill registration',
    )
    const workspaceEntries = await readdir(workspace, { recursive: true, withFileTypes: true })
    const homeEntries = await readdir(home, { recursive: true, withFileTypes: true })
    for (const entries of [workspaceEntries, homeEntries]) {
      assert.equal(
        entries.some(entry => entry.isFile() && (entry.name === 'SKILL.md' || entry.name === 'notes.txt')),
        false,
        'disposal must remove materialized skill files without leaving HOME copies',
      )
    }
  })
})

void test('S4-A2 unbound skill dispatch is refused before the DSH skill body', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-unbound-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Attempt an unbound skill name.',
        toolCalls: [{
          id: 's4a2-unbound-call',
          name: 'skill',
          arguments: JSON.stringify({ name: 'unbound-skill' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'The unbound skill call was refused.', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [s4a2Skill()],
    })
    const result = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId,
      runId,
      admission: scenario.runAdmission,
      composition: scenario.composition,
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: scenario.provider,
        verify() { throw new Error('unbound skill must not verify') },
      },
      transientInvalidReasons: [],
    })
    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 2)
    const texts = messageTexts(fixture.requests[1] ?? {})
    assert.ok(texts.some(text => text.includes('INPUT_NOT_AUTHORIZED')))
    assert.equal(texts.some(text => text.includes(S4A2_SKILL_BODY)), false, texts.join('\n---\n'))
  })
})

void test('S4-A2 dual-skill discovery keeps template order in NodeView and guards an unbound call', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a2-dual-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  const first = s4a2Skill()
  const second = s4a2SecondSkill()
  await withHarness((_request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read one bound skill and attempt one unbound name.',
        toolCalls: [
          { id: 's4a2-bound-call', name: 'skill', arguments: JSON.stringify({ name: first.name }) },
          { id: 's4a2-unbound-call', name: 'skill', arguments: JSON.stringify({ name: 'unbound-skill' }) },
        ],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'Dual skill step finished without submitting.', usage: fixtureUsage(index) }
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      skills: [first, second],
    })
    assert.deepEqual(scenario.contract.resources.skills, scenario.composition.skills)
    assert.equal(scenario.composition.skills.length, 2)
    const contexts: string[] = []
    const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
    let result
    try {
      result = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: scenario.runAdmission,
        composition: scenario.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: scenario.provider,
          verify() { throw new Error('dual skill create must not verify') },
        },
        transientInvalidReasons: [],
      })
    } finally {
      disposeContexts()
    }
    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'failed')
    assert.equal(fixture.requests.length, 2)
    const firstTexts = messageTexts(fixture.requests[0] ?? {})
    const catalog = firstTexts.find(text => text.includes('<available_skills>'))
    assert.ok(catalog)
    assert.ok(catalog.includes(first.name))
    assert.ok(catalog.includes(second.name))
    assert.equal(firstTexts.filter(text => text.includes('<available_skills>')).length, 1)
    assert.ok(contexts[0]?.includes(
      '"skills":[{"id":"skill:s4a2","name":"s4a2-bounded-skill"},{"id":"skill:s4a2-b","name":"s4a2-second-skill"}]',
    ), 'NodeView must keep the template binding order, not the DSH name order')
    assert.ok(contexts[0]?.includes('"name":"skill"'))
    const secondTexts = messageTexts(fixture.requests[1] ?? {})
    assert.ok(secondTexts.some(text => text.includes('<skill_content') && text.includes(first.content)))
    assert.ok(secondTexts.some(text => text.includes('INPUT_NOT_AUTHORIZED')))
    assert.equal(secondTexts.some(text => text.includes('<skill_content') && text.includes('unbound-skill')), false)
  })
})
