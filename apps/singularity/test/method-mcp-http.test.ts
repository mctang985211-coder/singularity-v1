import assert from 'node:assert/strict'
import { readFacts } from './run-fixture.ts'

import test from 'node:test'

import type { Agent,AgentHandle } from '@deepseek-ai/dsh-agent'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

import type { Ref } from '@singularity/protocol'
import { computeDigest } from '@singularity/protocol'
import { executeSingleRun } from '@singularity/runtime'

import { contextEpochFrom,messageTexts,toolSchemaNames } from './fixtures/chat-completions.ts'

import type { StreamableHttpFixture } from './fixtures/mcp-streamable-http.ts'
import {
startStreamableHttpFixture,
STREAMABLE_HTTP_INSTRUCTIONS,
} from './fixtures/mcp-streamable-http.ts'
import {
mcpToolReply,
reserveClosedPort,
s4a3RootLeftovers,
S4A4_RESOURCE_TOOL_NAMES,
S4A4_SERVER_NAME,
s4a4DirectConfig,
s4a4ExposedTools,
s4a4RpcMethods,
s4a4Server,
withS4a3Tmp,
} from './method-fixture.ts'
import {
captureAgentContexts,
captureAgentPrompts,
passingVerifier,
planReply,
recordSessionEvents,
submitReply,
toolCallNames,
withHarness,
writeOutputReply,
} from './run-fixture.ts'
import type { McpServerFixture,ReplyScript,Scenario } from './task-fixture.ts'
import { agentOptions,fixtureUsage,makeScenario } from './task-fixture.ts'

void test('S4-A4 mounts a frozen streamable-http server through the Method identity chain', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a4-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{ id: 's4a4-read', name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active)
      const epoch = contextEpochFrom(request)
      assert.ok(epoch)
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) return mcpToolReply(`mcp__${S4A4_SERVER_NAME}__echo`, { message: 's4a4-http-echo-ok' }, 's4a4-echo', index)
    if (index === 3) return mcpToolReply('list_mcp_resources', { server: S4A4_SERVER_NAME }, 's4a4-list', index)
    if (index === 4) return mcpToolReply('read_mcp_resource', { server: S4A4_SERVER_NAME, uri: 's4a4://note' }, 's4a4-read-note', index)
    if (index === 5) return mcpToolReply('list_mcp_resource_templates', { server: S4A4_SERVER_NAME }, 's4a4-templates', index)
    if (index === 6) return mcpToolReply('read_mcp_resource', { server: S4A4_SERVER_NAME, uri: 's4a4://note/42' }, 's4a4-read-template', index)
    if (index === 7) return writeOutputReply()
    if (index === 8) return submitReply()
    return { content: 'unexpected extra request after submit', usage: fixtureUsage(index) }
  }

  const httpFixture = await startStreamableHttpFixture({ resources: true })
  try {
    await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
      const server = s4a4Server(httpFixture.url)
      scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
      const active = scenario
      assert.equal(active.composition.mcpServers[0]?.transport, 'streamable-http')
      const prompts: string[] = []
      const contexts: string[] = []
      const schemaNames: string[][] = []
      const createdAgents: Agent[] = []
      const disposePrompts = captureAgentPrompts(spike, sessionId, prompts)
      const disposeContexts = captureAgentContexts(spike, sessionId, contexts)
      const disposeAgents = spike.ctx.on('agent/created', ({ agent }) => {
        if (String(agent.session.id) === sessionId) {
          createdAgents.push(agent)
          schemaNames.push(spike.ctx.tools.schemas(agent).map(schema => schema.name))
        }
        return undefined
      })
      const events = recordSessionEvents(spike, sessionId)
      const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
      let result
      try {
        result = await withS4a3Tmp(() => executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId,
          runId,
          admission: active.runAdmission,
          composition: active.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024 * 1024,
          verifier: passingVerifier(active, runId, workspace, verifierCalls),
          transientInvalidReasons: [],
        }))
      } finally {
        disposePrompts()
        disposeContexts()
        disposeAgents()
      }

      assert.ok(result.kind === 'settled')
      assert.equal(result.classification, 'verified', result.executionRecord?.reason)
      assert.equal(verifierCalls.length, 1)
      assert.equal(fixture.requests.length, 9)
      assert.equal(prompts.length, 1)
      const prompt = prompts[0]
      assert.ok(prompt)
      assert.equal(active.composition.platformPrompt, computeDigest('object', { v: 1, text: prompt }))
      assert.ok(prompt.includes(`### MCP server: ${S4A4_SERVER_NAME}`))
      assert.ok(prompt.includes(STREAMABLE_HTTP_INSTRUCTIONS))
      assert.ok(prompt.includes('## MCP resource servers'))
      const firstRequest = fixture.requests[0] ?? {}
      const visibleTools = toolSchemaNames(firstRequest)
      for (const name of [
        `mcp__${S4A4_SERVER_NAME}__echo`,
        `mcp__${S4A4_SERVER_NAME}__fail`,
        `mcp__${S4A4_SERVER_NAME}__guarded`,
        `mcp__${S4A4_SERVER_NAME}__hang`,
        ...S4A4_RESOURCE_TOOL_NAMES,
      ]) {
        assert.ok(visibleTools.includes(name), `${name} must be visible`)
        assert.ok(schemaNames[0]?.includes(name), `${name} must be registered`)
      }
      assert.ok(Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])) <= 12 * 1024)
      assert.ok(Buffer.byteLength(contexts[0] ?? '') <= 8 * 1024)
      assert.equal(contexts[0]?.includes(`mcp__${S4A4_SERVER_NAME}__echo`), true)

      const called = toolCallNames(events.events)
      for (const name of [`mcp__${S4A4_SERVER_NAME}__echo`, ...S4A4_RESOURCE_TOOL_NAMES]) {
        assert.ok(called.includes(name), `${name} must be dispatched through the DSH session`)
      }
      assert.ok(messageTexts(fixture.requests[3] ?? {}).some(text => text.includes('s4a4-http-echo-ok')))
      assert.ok(messageTexts(fixture.requests[4] ?? {}).some(text => text.includes('s4a4://note')))
      assert.ok(messageTexts(fixture.requests[5] ?? {}).some(text => text.includes('note:s4a4://note')))
      assert.ok(messageTexts(fixture.requests[6] ?? {}).some(text => text.includes('s4a4://note/{id}')))
      assert.ok(messageTexts(fixture.requests[7] ?? {}).some(text => text.includes('note:42')))

      await httpFixture.waitFor(
        records => s4a4RpcMethods(records).includes('server/discover')
          && s4a4RpcMethods(records).includes('initialize')
          && s4a4RpcMethods(records).includes('notifications/initialized')
          && s4a4RpcMethods(records).includes('tools/list')
          && s4a4RpcMethods(records).includes('tools/call'),
        'HTTP discovery/initialize/tools sequence',
        10_000,
      )
      const methods = s4a4RpcMethods(httpFixture.records)
      assert.ok(methods.indexOf('server/discover') < methods.indexOf('initialize'))
      assert.ok(methods.indexOf('initialize') < methods.indexOf('tools/list'))
      assert.equal(methods.filter(method => method === 'initialize').length, 1)
      assert.equal(methods.filter(method => method === 'notifications/initialized').length, 1)
      assert.ok(methods.filter(method => method === 'tools/call').length >= 1)
      assert.ok(methods.filter(method => method === 'resources/list').length >= 1)
      assert.ok(methods.filter(method => method === 'resources/templates/list').length >= 1)
      assert.ok(methods.filter(method => method === 'resources/read').length >= 2)

      await httpFixture.waitForIdle()
      assert.equal(httpFixture.activeConnections, 0, 'disposed HTTP client must close every fixture connection')
      assert.equal(httpFixture.activeRequests, 0)
      assert.equal(
        (await s4a3RootLeftovers()).length,
        0,
        'HTTP-only Runs must not create a materialization root',
      )
      assert.equal(spike.ctx.tools.definitions().some(definition => definition.name.startsWith('mcp__')), false)
      const agent = createdAgents[0]
      assert.ok(agent)
      const disposedNames = [
        `mcp__${S4A4_SERVER_NAME}__echo`,
        `mcp__${S4A4_SERVER_NAME}__fail`,
        `mcp__${S4A4_SERVER_NAME}__guarded`,
        `mcp__${S4A4_SERVER_NAME}__hang`,
        ...S4A4_RESOURCE_TOOL_NAMES,
      ]
      const disposedDefinitions = spike.ctx.tools.definitions(agent).map(definition => definition.name)
      for (const name of disposedNames) {
        assert.equal(disposedDefinitions.includes(name), false, `${name} must be removed with the Agent`)
        assert.equal(spike.ctx.tools.get(name, agent), undefined, `${name} must not remain registered`)
      }

      const metrics = {
        systemPromptBytes: Buffer.byteLength(prompt),
        nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
        toolSchemaBytes: Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])),
        firstRequestBytes: Buffer.byteLength(JSON.stringify(firstRequest)),
        httpRequestCount: httpFixture.requestCount,
        openedConnections: httpFixture.openedConnections,
        closedConnections: httpFixture.closedConnections,
        methods,
        usage: result.usage,
      }
      console.log(`S4-A4 metrics ${JSON.stringify(metrics)}`)
    })
  } finally {
    await httpFixture.close()
  }
})

void test('S4-A4 pre-aborted HTTP dispatch never reaches the fixture', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a4-preabort-${String(process.pid)}-${String(Date.now())}`
  const httpFixture: StreamableHttpFixture = await startStreamableHttpFixture()
  try {
    await withHarness((_request, index) => ({ content: 'pre-abort must not reach the model', usage: fixtureUsage(index) }), async ({ spike, workspace }) => {
      const sessionId = `${taskId}-session` as SessionId
      let handle: AgentHandle | undefined
      try {
        handle = await spike.ctx.agents.create({
          sessionId,
          meta: { cwd: workspace },
          agentOptions: agentOptions(),
          setup: async agentCtx => {
            await agentCtx.plugin(mcpClient, s4a4DirectConfig(httpFixture.url))
          },
        })
        const controller = new AbortController()
        controller.abort()
        const requestsBefore = httpFixture.requestCount
        const outcome = await spike.ctx.tools.execute({
          signal: controller.signal,
          agent: handle.agent,
          calls: [{
            type: 'tool-call',
            id: ToolCallId('s4a4-pre-abort'),
            name: 'list_mcp_resources',
            arguments: JSON.stringify({ server: S4A4_SERVER_NAME }),
          }],
        })
        const [settled] = outcome.results
        assert.ok(settled)
        assert.equal(settled.result.isError, true)
        assert.match(settled.result.error.message, /aborted before dispatch|aborted/i)
        assert.equal(httpFixture.requestCount, requestsBefore, 'pre-abort must not issue an HTTP request')
        assert.equal(s4a4RpcMethods(httpFixture.records).includes('resources/list'), false)
      } finally {
        await handle?.dispose()
      }
      await httpFixture.waitForIdle()
      assert.equal(httpFixture.activeConnections, 0)
      assert.equal((await s4a3RootLeftovers()).length, 0)
    })
  } finally {
    await httpFixture.close()
  }
})

void test('S4-A4 rejects a closed HTTP port before Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a4-closed-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  const port = await reserveClosedPort()
  await withHarness((_request, index) => ({ content: 'closed HTTP port must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      mcpServers: [s4a4Server(`http://127.0.0.1:${String(port)}/mcp`)],
    })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
      return undefined
    })

    try {
      await assert.rejects(withS4a3Tmp(() => executeSingleRun({
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
          verify() { throw new Error('closed HTTP port must not verify') },
        },
        transientInvalidReasons: [],
      })), /fetch failed|ECONNREFUSED|connect/i)
    } finally {
      dispose()
    }

    assert.equal(created, 0)
    assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
    assert.equal(fixture.requests.length, 0)
    assert.equal((await s4a3RootLeftovers()).length, 0, 'HTTP startup failure must not create a materialization root')
  })
})

void test('S4-A4 times out a hanging HTTP tool and keeps the client usable for stop', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a4-timeout-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{ id: 's4a4-timeout-read', name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active)
      const epoch = contextEpochFrom(request)
      assert.ok(epoch)
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) return mcpToolReply(`mcp__${S4A4_SERVER_NAME}__hang`, { message: 's4a4-http-timeout' }, 's4a4-timeout-hang', index)
    if (index === 3) {
      return {
        reasoning: 'Stop after the HTTP tool timeout.',
        toolCalls: [{
          id: 's4a4-timeout-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'HTTP timeout observed' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra request after timeout', usage: fixtureUsage(index) }
  }

  const httpFixture: StreamableHttpFixture = await startStreamableHttpFixture()
  try {
    await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
      scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        mcpServers: [s4a4Server(httpFixture.url, { toolCallTimeoutMs: 200 })],
      })
      const active = scenario
      const result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: active.runAdmission,
        composition: active.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() { throw new Error('timed-out HTTP tool must not verify') },
        },
        transientInvalidReasons: [],
      }))
      assert.ok(result.kind === 'settled')
      assert.equal(result.classification, 'failed', result.executionRecord?.reason)
      assert.match(result.executionRecord?.reason ?? '', /^stop:blocked:/)
      assert.equal(fixture.requests.length, 4)
      assert.ok(
        messageTexts(fixture.requests[3] ?? {}).some(text => /abort|timed out|timeout/i.test(text)),
        'the model must receive the HTTP timeout/abort error before stop',
      )
      await httpFixture.waitFor(
        records => records.some(record => record.type === 'abort' && record.name === 'hang' && record.message === 's4a4-http-timeout'),
        'HTTP tool timeout abort',
        10_000,
      )
      await httpFixture.waitForIdle()
      assert.equal(httpFixture.activeConnections, 0)
      assert.equal((await s4a3RootLeftovers()).length, 0)
    })
  } finally {
    await httpFixture.close()
  }
})

void test('S4-A4 aborts an in-flight HTTP tool through the native transport', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a4-inflight-${String(process.pid)}-${String(Date.now())}`
  const httpFixture: StreamableHttpFixture = await startStreamableHttpFixture()
  try {
    await withHarness((_request, index) => ({ content: 'in-flight abort must not reach the model', usage: fixtureUsage(index) }), async ({ spike, workspace }) => {
      const sessionId = `${taskId}-session` as SessionId
      let handle: AgentHandle | undefined
      try {
        handle = await spike.ctx.agents.create({
          sessionId,
          meta: { cwd: workspace },
          agentOptions: agentOptions(),
          setup: async agentCtx => {
            await agentCtx.plugin(mcpClient, s4a4DirectConfig(httpFixture.url))
          },
        })
        const controller = new AbortController()
        const pending = spike.ctx.tools.execute({
          signal: controller.signal,
          agent: handle.agent,
          calls: [{
            type: 'tool-call',
            id: ToolCallId('s4a4-in-flight'),
            name: `mcp__${S4A4_SERVER_NAME}__hang`,
            arguments: JSON.stringify({ message: 's4a4-http-in-flight' }),
          }],
        })
        await httpFixture.waitFor(
          records => records.some(record => record.type === 'tool' && record.name === 'hang' && JSON.stringify(record.args).includes('s4a4-http-in-flight')),
          'HTTP in-flight tool dispatch',
          10_000,
        )
        controller.abort()
        const outcome = await pending
        const [settled] = outcome.results
        assert.ok(settled)
        assert.equal(settled.result.isError, true)
        assert.ok(settled.result.error.message.length > 0)
        await httpFixture.waitFor(
          records => records.some(record => record.type === 'abort' && record.name === 'hang' && record.message === 's4a4-http-in-flight'),
          'HTTP in-flight abort',
          10_000,
        )
      } finally {
        await handle?.dispose()
      }
      await httpFixture.waitForIdle()
      assert.equal(httpFixture.activeConnections, 0)
      assert.equal((await s4a3RootLeftovers()).length, 0)
    })
  } finally {
    await httpFixture.close()
  }
})

void test('S4-A4 denies an unbound HTTP resource server before dispatch without resources/list traffic', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a4-guard-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{ id: 's4a4-guard-read', name: 'singularity_read', arguments: JSON.stringify({ kind: 'self' }) }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active)
      const epoch = contextEpochFrom(request)
      assert.ok(epoch)
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) return mcpToolReply('list_mcp_resources', { server: 'other' }, 's4a4-unbound-resource', index)
    if (index === 3) {
      return {
        reasoning: 'Stop after the HTTP guard check.',
        toolCalls: [{
          id: 's4a4-guard-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'HTTP guard check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra request after guard', usage: fixtureUsage(index) }
  }

  const httpFixture: StreamableHttpFixture = await startStreamableHttpFixture({ resources: true })
  try {
    await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
      scenario = await makeScenario(storeRoot, spike.ctx, {
        taskId,
        maxRuns: 1,
        mcpServers: [s4a4Server(httpFixture.url)],
      })
      const active = scenario
      const result = await withS4a3Tmp(() => executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId,
        runId,
        admission: active.runAdmission,
        composition: active.composition,
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() { throw new Error('unbound resource guard must not verify') },
        },
        transientInvalidReasons: [],
      }))
      assert.ok(result.kind === 'settled')
      assert.equal(result.classification, 'failed', result.executionRecord?.reason)
      assert.match(result.executionRecord?.reason ?? '', /^stop:blocked:/)
      assert.equal(fixture.requests.length, 4)
      assert.ok(messageTexts(fixture.requests[3] ?? {}).some(text => text.includes('INPUT_NOT_AUTHORIZED')))
      assert.equal(
        s4a4RpcMethods(httpFixture.records).includes('resources/list'),
        false,
        'unbound resource guard must not issue resources/list traffic',
      )
      await httpFixture.waitForIdle()
      assert.equal(httpFixture.activeConnections, 0)
    })
  } finally {
    await httpFixture.close()
  }
})

for (const variant of [
  {
    name: 'frozen instructions mismatch',
    expected: { code: 'COMPOSITION_MISMATCH' },
    server: (url: string): McpServerFixture => s4a4Server(url, { instructions: 'S4-A4 frozen instructions the server does not send.' }),
  },
  {
    name: 'exposedTools description mismatch',
    expected: { code: 'UNSUPPORTED_RESOURCES' },
    server: (url: string): McpServerFixture => s4a4Server(url, {
      exposedTools: s4a4ExposedTools().map((tool, index) => index === 0
        ? { ...tool, description: 'A description the HTTP server does not send.' }
        : tool),
    }),
  },
] as const) {
  void test(`S4-A4 rejects ${variant.name} before Agent publication`, { timeout: 240_000 }, async () => {
    const taskId = `task-s4a4-surface-${String(process.pid)}-${String(Date.now())}`
    const sessionId = `${taskId}-session`
    const runId = `${taskId}-run`
    const httpFixture: StreamableHttpFixture = await startStreamableHttpFixture({ resources: true })
    try {
      await withHarness((_request, index) => ({ content: 'surface mismatch must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
        const scenario = await makeScenario(storeRoot, spike.ctx, {
          taskId,
          maxRuns: 1,
          mcpServers: [variant.server(httpFixture.url)],
        })
        let created = 0
        const dispose = spike.ctx.on('agent/created', () => {
          created += 1
          return undefined
        })

        try {
          await assert.rejects(withS4a3Tmp(() => executeSingleRun({
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
              verify() { throw new Error('HTTP surface mismatch must not verify') },
            },
            transientInvalidReasons: [],
          })), variant.expected)
        } finally {
          dispose()
        }

        assert.equal(created, 0, 'HTTP surface mismatch must not publish an Agent')
        assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
        assert.equal(fixture.requests.length, 0, 'HTTP surface mismatch must not buy a model request')
        assert.equal((await s4a3RootLeftovers()).length, 0)
        await httpFixture.waitFor(
          records => s4a4RpcMethods(records).includes('tools/list'),
          'HTTP tools/list before surface mismatch',
          10_000,
        )
        assert.equal(s4a4RpcMethods(httpFixture.records).includes('tools/list'), true)
        await httpFixture.waitForIdle()
        assert.equal(httpFixture.activeConnections, 0)
      })
    } finally {
      await httpFixture.close()
    }
  })
}
