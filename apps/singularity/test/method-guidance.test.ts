import assert from 'node:assert/strict'

import test from 'node:test'

import type { CompositionPayload } from '@singularity/protocol'
import {
computeDigest,
parseJsonText,
parseProtocolValue,
taskTemplateSchema
} from '@singularity/protocol'
import { DomainStore,executeSingleRun } from '@singularity/runtime'

import { messageTexts,wireText } from './fixtures/chat-completions.ts'

import { S4A1_CURRENT_MARKER,S4A1_OTHER_MARKER } from './method-fixture.ts'
import {
captureAgentContexts,
captureAgentPrompts,
factsOfType,
readFacts,
withHarness
} from './run-fixture.ts'
import {
agentOptions,
fixtureUsage,
makeScenario,
textDecoder
} from './task-fixture.ts'

void test('S4-A1 host derives template/guidance from the pinned Method and the first real DSH request carries only current guidance', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  await withHarness(
    (_request, index) => ({ content: 'S4-A1 finished without submitting.', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        guidanceText: S4A1_CURRENT_MARKER,
        otherGuidanceText: S4A1_OTHER_MARKER,
      })
      assert.equal(scenario.method.templates.length, 2)
      const currentTemplate = scenario.method.templates[0]
      assert.ok(currentTemplate)
      assert.deepEqual(scenario.composition.guidance, currentTemplate.guidance)

      const prompts: string[] = []
      const contexts: string[] = []
      const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
      const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
      try {
        const result = await executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId: `${taskId}-run`,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('no submission') },
          },
          transientInvalidReasons: [],
        })
        assert.ok(result.kind === 'settled')
        assert.equal(result.classification, 'failed')
      } finally {
        disposePrompts()
        disposeContexts()
      }

      assert.equal(fixture.requests.length, 1, 'the create path buys exactly one request')
      const texts = messageTexts(fixture.requests[0] ?? {})
      assert.ok(
        texts.some(text => text.includes(S4A1_CURRENT_MARKER)),
        'the first wire request must contain the current template guidance',
      )
      assert.equal(
        texts.some(text => text.includes(S4A1_OTHER_MARKER)),
        false,
        'another template guidance must not be injected',
      )
      assert.equal(prompts.length, 1)
      const prompt = prompts[0]
      assert.ok(prompt)
      assert.equal(
        scenario.composition.platformPrompt,
        computeDigest('object', { v: 1, text: prompt }),
        'the frozen platformPrompt must equal the actual scoped system prompt',
      )
      const systemMessage = fixture.requests[0]?.messages?.find(message => message.role === 'system')
      assert.ok(systemMessage, 'the first wire request must carry the assembled system prompt')
      assert.equal(
        wireText(systemMessage.content),
        prompt,
        'the first wire request system prompt must equal the actual scoped assembly',
      )
      assert.equal(contexts.length, 1)
      assert.ok(
        contexts[0]?.includes(
          '"ownTemplate":{"id":"template:s3c","brief":"Produce one declared file."}',
        ),
        'NodeView ownTemplate.brief must come from the pinned template, not the goal summary',
      )

      const store = await DomainStore.open({ root: storeRoot })
      try {
        const { bytes } = await store.readObject(scenario.composition.template, 'object')
        const template = parseProtocolValue(
          taskTemplateSchema,
          parseJsonText(textDecoder.decode(bytes)),
        )
        assert.deepEqual(template, currentTemplate)
      } finally {
        await store.close()
      }
    },
  )
})

void test('S4-A1 create rejects an actual scoped platformPrompt mismatch before any model request', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a1-platform-create-${String(process.pid)}-${String(Date.now())}`
  await withHarness(
    (_request, index) => ({ content: 'platform mismatch must not reach the model', usage: fixtureUsage(index) }),
    async ({ spike, fixture, workspace, storeRoot }) => {
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
      const wrongComposition: CompositionPayload = {
        ...scenario.composition,
        platformPrompt: computeDigest('object', { v: 1, text: 'wrong platform prompt' }),
      }
      const created: string[] = []
      const disposeCreated = spike.ctx.on('agent/created', ({ agent }) => {
        created.push(String(agent.session.id))
        return undefined
      })

      try {
        await assert.rejects(executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId: `${taskId}-session`,
          runId: `${taskId}-run`,
          admission: scenario.runAdmission,
          composition: wrongComposition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: {
            provider: scenario.provider,
            verify() { throw new Error('platform mismatch must not verify') },
          },
          transientInvalidReasons: [],
        }), /COMPOSITION_MISMATCH|platform prompt/)
      } finally {
        disposeCreated()
      }
      assert.equal(created.length, 0, 'platform mismatch must not publish an Agent')
      assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
      assert.equal(fixture.requests.length, 0, 'platform mismatch must not buy a model request')

      const facts = await readFacts(storeRoot)
      assert.equal(factsOfType(facts, 'run/submitted').length, 0)
      assert.equal(factsOfType(facts, 'run/closed').length, 0)
    },
  )
})

void test('public Composition preserves ordinary password/token schema fields without purchasing a model request', async () => {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  await withHarness(() => { throw new Error('Composition must not call the model') }, async ({ spike, fixture, storeRoot }) => {
    const dispose = spike.ctx.tools.register(defineTool({
      name: 'public_schema_fixture', description: 'Public parameter declarations.',
      parameters: {
        password: { type: 'string', description: 'A parameter name, without any credential value.' },
        token: { type: 'string', description: 'A public domain token field.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.result }] },
      execute: () => Promise.resolve({ result: 'unused' }),
    }))
    try {
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'public-composition-fields', maxRuns: 1 })
      const archive = await DomainStore.open(storeRoot)
      try {
        const { bytes } = await archive.readObject(scenario.composition.resources)
        const value = parseJsonText(textDecoder.decode(bytes))
        assert.partialDeepStrictEqual(value, { v: 1, tools: [{ name: 'public_schema_fixture',
          parameters: { properties: { password: { type: 'string' }, token: { type: 'string' } } } }] })
        assert.equal(fixture.requests.length, 0)
      } finally { await archive.close() }
    } finally { dispose() }
  })
})
