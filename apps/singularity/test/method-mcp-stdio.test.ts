import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { readFacts } from './run-fixture.ts'

import { join } from 'node:path'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'

import type { Ref,ToolAsset } from '@singularity/protocol'
import { computeDigest } from '@singularity/protocol'
import {
DomainStore,
METHOD_GUIDANCE_SECTION,
executeSingleRun
} from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import {
contextEpochFrom,
messageTexts,
toolSchemaNames,
wireText,
} from './fixtures/chat-completions.ts'

import {
S4A3_INSTRUCTIONS,
S4A3_MESSAGE_OUTPUT,
S4A3_MESSAGE_PARAMETERS,
S4A3_RESOURCE_TOOL_NAMES,
S4A3_TMP_ROOT,
mcpToolReply,
s4a3ExposedTools,
s4a3ProcessAlive,
s4a3RootLeftovers,
s4a3Server,
waitForS4a3Log,
waitForS4a3RootsGone,
withS4a3Tmp,
} from './method-fixture.ts'
import {
captureAgentContexts,
captureAgentPrompts,
passingVerifier,
planReply,
readJson,
recordSessionEvents,
submitReply,
toolCallNames,
withHarness,
writeOutputReply
} from './run-fixture.ts'
import type { ReplyScript,Scenario } from './task-fixture.ts'
import {
agentOptions,
fixtureUsage,
makeScenario
} from './task-fixture.ts'

void test('S4-A3 mounts a frozen stdio MCP server, exposes exact resources, and cleans up', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-create-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    if (index === 1) {
      const active = scenario
      assert.ok(active, 'scenario must exist before planning')
      const epoch = contextEpochFrom(request)
      assert.ok(epoch, 'runtime did not deliver a contextEpoch')
      return planReply(active, taskId, runId, epoch)
    }
    if (index === 2) return mcpToolReply('mcp__calc__echo', { message: 's4a3-echo-ok' }, 's4a3-echo', index)
    if (index === 3) return mcpToolReply('list_mcp_resources', { server: 'calc' }, 's4a3-list', index)
    if (index === 4) return mcpToolReply('read_mcp_resource', { server: 'calc', uri: 's4a3://note' }, 's4a3-read-note', index)
    if (index === 5) return mcpToolReply('list_mcp_resource_templates', { server: 'calc' }, 's4a3-templates', index)
    if (index === 6) return mcpToolReply('read_mcp_resource', { server: 'calc', uri: 's4a3://note/42' }, 's4a3-read-template', index)
    if (index === 7) return writeOutputReply()
    if (index === 8) return submitReply()
    return { content: 'unexpected extra model request after submit', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-server.log')
    const server = await s4a3Server(logPath)
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const active = scenario
    const composition = active.composition
    assert.equal(composition.mcpServers.length, 1)
    const compositionServer = composition.mcpServers[0]
    assert.ok(compositionServer)
    assert.equal(compositionServer.transport, 'stdio')
    assert.deepEqual(compositionServer.capabilities, ['tools', 'resources'])

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
        composition,
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
    assert.equal(fixture.requests.length, 9, 'MCP binding must not add extra model requests')

    assert.equal(prompts.length, 1)
    const prompt = prompts[0]
    assert.ok(prompt)
    assert.equal(composition.platformPrompt, computeDigest('object', { v: 1, text: prompt }))
    assert.ok(prompt.includes('### MCP server: calc'))
    assert.ok(prompt.includes(S4A3_INSTRUCTIONS))
    assert.ok(prompt.includes('## MCP resource servers'))
    assert.ok(prompt.includes('["calc"]'))
    const firstRequest = fixture.requests[0] ?? {}
    const systemMessage = firstRequest.messages?.find(message => message.role === 'system')
    assert.ok(systemMessage)
    assert.equal(wireText(systemMessage.content), prompt)
    const visibleTools = toolSchemaNames(firstRequest)
    for (const name of ['mcp__calc__echo', 'mcp__calc__echo_extra', ...S4A3_RESOURCE_TOOL_NAMES]) {
      assert.ok(visibleTools.includes(name), `${name} must be visible to the model`)
      assert.ok(schemaNames[0]?.includes(name), `${name} must be registered in the Agent scope`)
    }
    assert.ok(Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])) <= 12 * 1024)
    assert.ok(Buffer.byteLength(contexts[0] ?? '') <= 8 * 1024)
    assert.ok(contexts[0]?.includes('mcp__calc__echo'))

    const called = toolCallNames(events.events)
    for (const name of ['mcp__calc__echo', ...S4A3_RESOURCE_TOOL_NAMES]) {
      assert.ok(called.includes(name), `${name} must be dispatched through the DSH session`)
    }
    const echoResultText = messageTexts(fixture.requests[3] ?? {})
    assert.ok(echoResultText.some(text => text.includes('s4a3-echo-ok')))
    const resourceListText = messageTexts(fixture.requests[4] ?? {})
    assert.ok(resourceListText.some(text => text.includes('s4a3://note')))
    const resourceText = messageTexts(fixture.requests[5] ?? {})
    assert.ok(resourceText.some(text => text.includes('note:s4a3://note')))
    const templateText = messageTexts(fixture.requests[6] ?? {})
    assert.ok(templateText.some(text => text.includes('s4a3://note/{id}')))
    const expandedTemplateText = messageTexts(fixture.requests[7] ?? {})
    assert.ok(expandedTemplateText.some(text => text.includes('note:42')))

    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'tool' && entry.name === 'echo')
        && entries.some(entry => entry.type === 'resource' && entry.uri === 's4a3://note')
        && entries.some(entry => entry.type === 'resource' && entry.uri === 's4a3://note/42')
        && entries.filter(entry => entry.type === 'start').length > 0,
      'MCP fixture start/tool/resource records',
    )
    const starts = [...new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))]
    const exits = new Set(records.filter(entry => entry.type === 'exit').map(entry => entry.pid))
    assert.ok(starts.length > 0, 'the fixture must have started at least once')
    const firstStart = records.find(entry => entry.type === 'start')
    assert.ok(firstStart)
    assert.equal(firstStart.rootMode, 0o700, 'the Run MCP root must be owned 0700')
    assert.equal(firstStart.cwdMode, 0o700, 'each materialized server root must be 0700')
    for (const pid of starts) {
      assert.ok(exits.has(pid), `MCP fixture PID ${String(pid)} must record its exit`)
      assert.equal(s4a3ProcessAlive(pid), false, `MCP fixture PID ${String(pid)} must exit with the Agent`)
    }
    const leftovers = await readdir(S4A3_TMP_ROOT)
    assert.equal(leftovers.some(name => name.startsWith('singularity-mcp-')), false, 'MCP resource root must be removed')
    assert.equal(spike.ctx.tools.definitions().some(definition => definition.name.startsWith('mcp__')), false)

    const agent = createdAgents[0]
    assert.ok(agent)
    assert.equal(spike.ctx.tools.get('mcp__calc__echo', agent), undefined)

    const store = await DomainStore.open({ root: storeRoot })
    try {
      const schema = await readJson(store, compositionServer.schema, 'object')
      assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema))
      const tools = (schema as { readonly tools?: readonly { readonly name?: string }[] }).tools
      assert.deepEqual(tools?.map(tool => tool.name), ['echo', 'echo_extra'])
    } finally {
      await store.close()
    }

    const metrics = {
      systemPromptBytes: Buffer.byteLength(prompt),
      nodeViewBytes: Buffer.byteLength(contexts[0] ?? ''),
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(firstRequest.tools ?? [])),
      firstRequestBytes: Buffer.byteLength(JSON.stringify(firstRequest)),
      usage: result.usage,
    }
    console.log(`S4-A3 metrics ${JSON.stringify(metrics)}`)
  })
})

void test('S4-A3 rejects an actual extra MCP tool before Agent or model', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-extra-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'extra MCP tool must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-extra.log')
    const server = await s4a3Server(logPath, {
      exposedTools: s4a3ExposedTools().filter(tool => tool.name === 'echo'),
    })
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
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
          verify() { throw new Error('extra MCP tool must not verify') },
        },
        transientInvalidReasons: [],
      })), /tool|surface/)
    } finally {
      dispose()
    }

    assert.equal(created, 0, 'surface mismatch must not publish an Agent')
    assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
    assert.equal(fixture.requests.length, 0, 'surface mismatch must not buy a model request')
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start')
        && entries.some(entry => entry.type === 'exit'),
      'extra-tool fixture exit',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'failed setup must roll back the MCP process')
    }
    assert.equal((await readdir(S4A3_TMP_ROOT)).some(name => name.startsWith('singularity-mcp-')), false)
  })
})

void test('S4-A3 rejects frozen instructions that differ from the mounted server before Agent', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-instructions-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'instruction mismatch must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-instructions.log')
    const server = await s4a3Server(logPath, { instructions: 'S4-A3 frozen instructions that the server does not send.' })
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
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
          verify() { throw new Error('instruction mismatch must not verify') },
        },
        transientInvalidReasons: [],
      })), /instructions|prompt/)
    } finally {
      dispose()
    }

    assert.equal(created, 0, 'platform prompt mismatch must not publish an Agent')
    assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
    assert.equal(fixture.requests.length, 0, 'platform prompt mismatch must not buy a model request')
    await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start') && entries.some(entry => entry.type === 'exit'),
      'instruction-mismatch fixture exit',
    )
  })
})

void test('S4-A3 rolls back the first server when the second stdio server fails startup', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-multi-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'failed second server must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const firstLog = join(storeRoot, 'mcp-first.log')
    const first = await s4a3Server(firstLog)
    const second = await s4a3Server(join(storeRoot, 'mcp-second.log'), {
      serverName: 'boom',
      exposedTools: [],
      instructions: 'Boom server.',
      source: "process.stderr.write('boom\\n'); process.exit(1)\n",
    })
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      mcpServers: [first, second],
    })
    assert.equal(scenario.composition.mcpServers.length, 2)
    assert.deepEqual(
      scenario.composition.mcpServers.map(server => server.bundle),
      scenario.contract.resources.mcpServers,
    )
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
          verify() { throw new Error('failed second server must not verify') },
        },
        transientInvalidReasons: [],
      })), /connection|closed|exit/i)
    } finally {
      dispose()
    }

    assert.equal(created, 0, 'partial mount failure must not publish an Agent')
    assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
    assert.equal(fixture.requests.length, 0, 'partial mount failure must not buy a model request')
    const records = await waitForS4a3Log(
      firstLog,
      entries => entries.some(entry => entry.type === 'start')
        && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
      'first server rollback exit',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'rollback must terminate the first server process')
    }
    assert.equal((await readdir(S4A3_TMP_ROOT)).some(name => name.startsWith('singularity-mcp-')), false)
  })
})

void test('S4-A3 denies an unbound resource server while the bound server still dispatches', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-guard-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-guard-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
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
    if (index === 2) return mcpToolReply('list_mcp_resources', { server: 'other' }, 's4a3-unbound-resource', index)
    if (index === 3) return mcpToolReply('read_mcp_resource', { server: 'calc', uri: 's4a3://note' }, 's4a3-bound-resource', index)
    if (index === 4) {
      return {
        reasoning: 'Stop after exercising the MCP dispatch guard.',
        toolCalls: [{
          id: 's4a3-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'S4-A3 guard check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra model request after stop', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-guard.log')
    const server = await s4a3Server(logPath)
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
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
        verify() { throw new Error('stopped guard run must not verify') },
      },
      transientInvalidReasons: [],
    }))
    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.match(result.executionRecord?.reason ?? '', /^stop:blocked:/)
    assert.equal(fixture.requests.length, 5)
    const denied = messageTexts(fixture.requests[3] ?? {})
    assert.ok(denied.some(text => text.includes('INPUT_NOT_AUTHORIZED')), 'unbound resource server must be denied before dispatch')
    const bound = messageTexts(fixture.requests[4] ?? {})
    assert.ok(bound.some(text => text.includes('note:s4a3://note')), 'the bound resource server must still dispatch')
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'resource' && entry.uri === 's4a3://note')
        && entries.some(entry => entry.type === 'exit'),
      'guarded fixture resource and exit',
    )
    assert.equal(records.filter(entry => entry.type === 'resource' && entry.uri === 's4a3://note').length, 1)
  })
})

void test('S4-A3 uses native credential-name scrubbing and deployment environment paths', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-env-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-env-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
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
    if (index === 2) {
      return {
        reasoning: 'Stop after mounting the MCP server.',
        toolCalls: [{
          id: 's4a3-env-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'S4-A3 env check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra model request after stop', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-env.log')
    const server = await s4a3Server(logPath)
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const active = scenario
    const sentinels = {
      FIXTURE_API_KEY: 's4a3-key-sentinel',
      DSH_FIXTURE: 's4a3-dsh-sentinel',
      SSH_AUTH_SOCK: '/tmp/s4a3-ssh-auth-sock-sentinel',
      GPG_AGENT_INFO: '/tmp/s4a3-gpg-agent-sentinel:1:1',
      KUBECONFIG: '/tmp/s4a3-kubeconfig-sentinel',
      DOCKER_HOST: 'tcp://s4a3-docker-sentinel:2375',
    }
    const previous = Object.fromEntries(Object.keys(sentinels).map(name => [name, process.env[name]]))
    Object.assign(process.env, sentinels)
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
        verifier: {
          provider: active.provider,
          verify() { throw new Error('stopped env run must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 3)
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'env') && entries.some(entry => entry.type === 'exit'),
      'MCP fixture env record',
    )
    const env = records.find(entry => entry.type === 'env')
    assert.ok(env)
    assert.equal(env.home, process.env.HOME ?? null)
    assert.equal(env.apiKey, null, 'DSH removes names containing KEY')
    assert.equal(env.dshValue, null, 'DSH removes DSH_* configuration')
    // Native name scrubbing is not a credential broker. A trusted clean launch
    // environment must omit these nonmatching credential channels.
    assert.equal(env.sshAuthSock, sentinels.SSH_AUTH_SOCK)
    assert.equal(env.gpgAgentInfo, sentinels.GPG_AGENT_INFO)
    assert.equal(env.kubeconfig, sentinels.KUBECONFIG)
    assert.equal(env.dockerHost, sentinels.DOCKER_HOST)
    for (const [field, name] of Object.entries({
      xdgConfigHome: 'XDG_CONFIG_HOME', xdgCacheHome: 'XDG_CACHE_HOME',
      xdgDataHome: 'XDG_DATA_HOME', xdgStateHome: 'XDG_STATE_HOME',
      xdgRuntimeDir: 'XDG_RUNTIME_DIR',
    })) assert.equal(env[field as keyof typeof env], process.env[name] ?? null)
    assert.equal(env.tmpDir, S4A3_TMP_ROOT)
  })
})

void test('S4-A3 deadline uses native DSH cancellation and cleans MCP resources', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-timeout-clean-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  await withHarness((_request, index) => ({ content: 'timed-out acquisition must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
    const logPath = join(storeRoot, 'mcp-timeout-clean.log')
    const server = await s4a3Server(logPath, { startDelayMs: 2_500 })
    const scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      deadlineAt: Date.now() + 1_000,
      mcpServers: [server],
    })
    let created = 0
    const dispose = spike.ctx.on('agent/created', () => {
      created += 1
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
          verify() { throw new Error('timed-out acquisition must not verify') },
        },
        transientInvalidReasons: [],
      }))
    } finally {
      dispose()
    }
    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'invalid', result.executionRecord?.reason)
    assert.equal(created, 0, 'timed-out acquisition must not publish an Agent')
    assert.equal(fixture.requests.length, 0, 'timed-out acquisition must not buy a model request')
    const records = await waitForS4a3Log(
      logPath,
      entries => entries.some(entry => entry.type === 'start')
        && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
      'timed-out fixture exit',
    )
    for (const pid of new Set(records.filter(entry => entry.type === 'start').map(entry => entry.pid))) {
      assert.equal(s4a3ProcessAlive(pid), false, 'late acquisition must dispose the fixture process')
    }
    await waitForS4a3RootsGone('late acquisition resource root cleanup')
    assert.equal((await s4a3RootLeftovers()).length, 0)
  })
})

void test('S4-A3 materializes every server before mount and isolates server roots', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-two-paths-${String(process.pid)}-${String(Date.now())}`
  const sessionId = `${taskId}-session`
  const runId = `${taskId}-run`
  let scenario: Scenario | undefined
  const script: ReplyScript = (request, index) => {
    if (index === 0) {
      return {
        reasoning: 'Read the frozen self contract before planning.',
        toolCalls: [{
          id: 's4a3-two-paths-read',
          name: 'singularity_read',
          arguments: JSON.stringify({ kind: 'self' }),
        }],
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
    if (index === 2) {
      return {
        reasoning: 'Stop after mounting both servers.',
        toolCalls: [{
          id: 's4a3-two-paths-stop',
          name: 'singularity_stop',
          arguments: JSON.stringify({ reason: 'blocked', message: 'S4-A3 two-server path check complete' }),
        }],
        usage: fixtureUsage(index),
      }
    }
    return { content: 'unexpected extra model request after stop', usage: fixtureUsage(index) }
  }

  await withHarness(script, async ({ spike, fixture, workspace, storeRoot }) => {
    const firstLog = join(storeRoot, 'mcp-first.log')
    const secondLog = join(storeRoot, 'mcp-second.log')
    const first = await s4a3Server(firstLog, { serverName: 'calc', siblingCheckPath: '../1-other/server.ts' })
    const second = await s4a3Server(secondLog, { serverName: 'other' })
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 1,
      mcpServers: [first, second],
    })
    const active = scenario
    assert.equal(active.composition.mcpServers.length, 2)
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
        verify() { throw new Error('stopped two-server run must not verify') },
      },
      transientInvalidReasons: [],
    }))
    assert.ok(result.kind === 'settled')
    assert.equal(result.classification, 'failed', result.executionRecord?.reason)
    assert.equal(fixture.requests.length, 3)
    const firstRecords = await waitForS4a3Log(
      firstLog,
      entries => entries.some(entry => entry.type === 'sibling') && entries.some(entry => entry.type === 'exit'),
      'first server sibling record and exit',
    )
    const sibling = firstRecords.find(entry => entry.type === 'sibling')
    assert.ok(sibling)
    assert.equal(sibling.exists, true, 'the second bundle must exist before the first server starts')
    const firstStart = firstRecords.find(entry => entry.type === 'start')
    assert.ok(firstStart)
    assert.ok(firstStart.cwd?.endsWith('/0-calc'))
    const secondRecords = await waitForS4a3Log(
      secondLog,
      entries => entries.some(entry => entry.type === 'start') && entries.some(entry => entry.type === 'exit'),
      'second server start and exit',
    )
    const secondStart = secondRecords.find(entry => entry.type === 'start')
    assert.ok(secondStart)
    assert.ok(secondStart.cwd?.endsWith('/1-other'))
    assert.notEqual(firstStart.cwd, secondStart.cwd)
  })
})

void test('S4-A3 host disposes partial prompt sections when MCP section registration conflicts', { timeout: 240_000 }, async () => {
  const taskId = `task-s4a3-section-conflict-${String(process.pid)}-${String(Date.now())}`
  await withHarness((_request, index) => ({ content: 'section conflict must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, storeRoot }) => {
    const server = await s4a3Server(join(storeRoot, 'mcp-section-conflict.log'))
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
    const duplicate = spike.ctx.systemPrompt.section({
      name: 'mcp:calc',
      order: spike.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      text: 'host duplicate MCP section',
      interpolate: false,
    })
    const store = await DomainStore.open({ root: storeRoot })
    try {
      await assert.rejects(
        buildSingleRunComposition(spike.ctx, {
          store,
          id: 's4a3-section-conflict',
          contract: scenario.contract,
          agentOptions: agentOptions(),
          base: { v: 1, seed: scenario.contract.environment.seed },
        }),
        /already|duplicate|registered/i,
      )
      const assembly = await spike.ctx.systemPrompt.assemble()
      assert.equal(
        assembly.sections.some(section => section.name === METHOD_GUIDANCE_SECTION),
        false,
        'partially registered guidance must be disposed after a later section conflict',
      )
      const duplicates = assembly.sections.filter(section => section.name === 'mcp:calc')
      assert.equal(duplicates.length, 1)
      assert.equal(duplicates[0]?.text, 'host duplicate MCP section')
    } finally {
      duplicate()
      await store.close()
    }
    assert.equal(fixture.requests.length, 0, 'section conflict must not buy a model request')
  })
})

for (const variant of [
  {
    name: 'a missing frozen tool',
    exposedTools: (): ToolAsset['server']['exposedTools'] => [
      ...s4a3ExposedTools(),
      {
        name: 'missing',
        description: 'A frozen tool the server does not expose.',
        parameters: S4A3_MESSAGE_PARAMETERS,
        output: S4A3_MESSAGE_OUTPUT,
      },
    ],
  },
  {
    name: 'a drifted description',
    exposedTools: (): ToolAsset['server']['exposedTools'] => [
      { ...s4a3ExposedTools()[0], description: 'A description the server does not send.' },
      s4a3ExposedTools()[1],
    ],
  },
  {
    name: 'drifted parameters',
    exposedTools: (): ToolAsset['server']['exposedTools'] => [
      {
        ...s4a3ExposedTools()[0],
        parameters: {
          type: 'object',
          properties: { other: { type: 'string' } },
          required: ['other'],
          additionalProperties: false,
        },
      },
      s4a3ExposedTools()[1],
    ],
  },
] as const) {
  void test(`S4-A3 rejects ${variant.name} before Agent or model`, { timeout: 240_000 }, async () => {
    const taskId = `task-s4a3-surface-${variant.name.replace(/ /g, '-')}-${String(process.pid)}-${String(Date.now())}`
    const sessionId = `${taskId}-session`
    const runId = `${taskId}-run`
    await withHarness((_request, index) => ({ content: 'surface mismatch must not reach the model', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
      const logPath = join(storeRoot, 'mcp-surface.log')
      const server = await s4a3Server(logPath, { exposedTools: variant.exposedTools() })
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1, mcpServers: [server] })
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
            verify() { throw new Error('surface mismatch must not verify') },
          },
          transientInvalidReasons: [],
        })), /tool|surface|description|parameter/)
      } finally {
        dispose()
      }

      assert.equal(created, 0, 'surface mismatch must not publish an Agent')
      assert.equal((await readFacts(storeRoot)).filter(fact => fact.type === 'run/closed').length, 0)
      assert.equal(fixture.requests.length, 0, 'surface mismatch must not buy a model request')
      await waitForS4a3Log(
        logPath,
        entries => entries.some(entry => entry.type === 'start')
          && entries.filter(entry => entry.type === 'start').every(start => entries.some(exit => exit.type === 'exit' && exit.pid === start.pid)),
        'surface mismatch fixture exit',
      )
    })
  })
}
