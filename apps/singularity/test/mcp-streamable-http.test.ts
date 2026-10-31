import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server'

import { bootSpikeProfile } from '../src/host-composition.ts'
import {
  FIXTURE_INSTRUCTIONS_FRAGMENT,
  FIXTURE_INSTRUCTIONS_TAIL,
  LEGACY_PROTOCOL_VERSIONS,
  startStreamableHttpFixture,
} from './fixtures/mcp-streamable-http.ts'
import type { StreamableHttpFixture, StreamableHttpLogRecord } from './fixtures/mcp-streamable-http.ts'

const SERVER_NAME = 'spike-http'
const MCP_PREFIX = `mcp__${SERVER_NAME}__`
const GUARDED_TOOL = `${MCP_PREFIX}guarded`
const GUARD_REASON = 'the guarded MCP tool is denied by the S1-C agent guard'
const CLIENT_HEADER_NAME = 'x-singularity-s1-c'
const CLIENT_HEADER_VALUE = 'streamable-http'
const RESOURCE_TOOL_NAMES = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] as const
const RESOURCE_TOOL_NAME_SET: ReadonlySet<string> = new Set(RESOURCE_TOOL_NAMES)
const EXPECTED_MCP_TOOLS: readonly string[] = ['echo', 'fail', 'guarded', 'hang'].map(name => `${MCP_PREFIX}${name}`)
const EXPECTED_SCOPED_TOOLS: readonly string[] = ['skill', 'working_directory', ...EXPECTED_MCP_TOOLS, ...RESOURCE_TOOL_NAMES]
const REMOVED_TOOL_NAMES: readonly string[] = [...EXPECTED_MCP_TOOLS, ...RESOURCE_TOOL_NAMES]
const TOOL_CALL_TIMEOUT_MS = 250

interface McpServerSpec {
  readonly serverName: string
  readonly url: string
}

type RequestLogRecord = Extract<StreamableHttpLogRecord, { type: 'request' }>
type ToolLogRecord = Extract<StreamableHttpLogRecord, { type: 'tool' }>
type AbortLogRecord = Extract<StreamableHttpLogRecord, { type: 'abort' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestRecords(records: readonly StreamableHttpLogRecord[]): RequestLogRecord[] {
  return records.filter((record): record is RequestLogRecord => record.type === 'request')
}

function toolRecords(records: readonly StreamableHttpLogRecord[], name?: string): ToolLogRecord[] {
  return records.filter((record): record is ToolLogRecord => (
    record.type === 'tool' && (name === undefined || record.name === name)
  ))
}

function abortRecords(records: readonly StreamableHttpLogRecord[], name?: string): AbortLogRecord[] {
  return records.filter((record): record is AbortLogRecord => (
    record.type === 'abort' && (name === undefined || record.name === name)
  ))
}

function messageOfToolRecord(record: ToolLogRecord): string | undefined {
  if (!isRecord(record.args)) return undefined
  const message = record.args.message
  return typeof message === 'string' ? message : undefined
}

function toolCallsOf(records: readonly StreamableHttpLogRecord[], name: string): RequestLogRecord[] {
  return requestRecords(records).filter(record => record.rpcMethod === 'tools/call' && record.tool === name)
}

function requestMethods(records: readonly StreamableHttpLogRecord[]): (string | null)[] {
  return requestRecords(records).map(record => record.rpcMethod)
}

async function reserveClosedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: Error) => { reject(error) })
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'reserved server must expose an address')
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

function admitMcpServer(spec: McpServerSpec, admitted: readonly McpServerSpec[]): void {
  const allowed = admitted.some(entry => entry.serverName === spec.serverName && entry.url === spec.url)
  if (!allowed) throw new Error(`MCP server "${spec.serverName}" is not in the deployment allowlist`)
}

function streamableHttpConfig(spec: McpServerSpec): StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: spec.serverName,
    url: spec.url,
    headers: { [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE },
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: true,
    maxInstructionBytes: 32_768,
    reconnect: { enabled: false },
  }
}

function serverArgument(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const server = args.server
  return typeof server === 'string' ? server : undefined
}

function deniedReason(execution: Readonly<ToolExecution>): string | undefined {
  if (execution.name === GUARDED_TOOL) return GUARD_REASON
  if (RESOURCE_TOOL_NAME_SET.has(execution.name)) {
    const server = serverArgument(execution.arguments)
    if (server !== SERVER_NAME) return `MCP resource server "${server ?? '<missing>'}" is not admitted`
    return undefined
  }
  if (execution.name.startsWith('mcp__') && !execution.name.startsWith(MCP_PREFIX)) {
    return `MCP tool "${execution.name}" belongs to a server outside the allowlist`
  }
  return undefined
}

let callSequence = 0

async function executeOne(
  ctx: Context,
  agent: Agent,
  name: string,
  args: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  callSequence += 1
  const outcome = await ctx.tools.execute({
    signal,
    agent,
    calls: [{
      type: 'tool-call',
      id: ToolCallId(`s1-c-mcp-call-${String(callSequence)}`),
      name,
      arguments: JSON.stringify(args),
    }],
  })
  assert.equal(outcome.results.length, 1)
  const [settled] = outcome.results
  assert.ok(settled)
  return settled.result
}

/** After disposal the native pipeline must fail locally; a throw or an error result both qualify. */
async function attemptAfterDispose(
  ctx: Context,
  agent: Agent,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult | undefined> {
  try {
    const outcome = await ctx.tools.execute({
      signal: new AbortController().signal,
      agent,
      calls: [{
        type: 'tool-call',
        id: ToolCallId('s1-c-mcp-call-after-dispose'),
        name,
        arguments: JSON.stringify(args),
      }],
    })
    if (outcome.results.length === 0) return undefined
    const [settled] = outcome.results
    assert.ok(settled)
    return settled.result
  } catch (error) {
    assert.ok(error instanceof Error, 'disposed dispatch must fail with an Error')
    return undefined
  }
}

function textOfResult(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function assertSuccess(result: ToolExecutionResult): asserts result is Extract<ToolExecutionResult, { isError: false }> {
  if (result.isError) assert.fail(`expected success, received: ${result.error.message}`)
}

function assertFailure(result: ToolExecutionResult): asserts result is Extract<ToolExecutionResult, { isError: true }> {
  if (!result.isError) assert.fail('expected a tool failure')
}

function structuredMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const structured = value.structuredContent
  if (!isRecord(structured)) return undefined
  const message = structured.message
  return typeof message === 'string' ? message : undefined
}

function parameterProperties(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = parameters.properties
  assert.ok(isRecord(properties), 'tool schema must declare parameter properties')
  return properties
}

function assertStringParameter(
  schema: { readonly parameters: Record<string, unknown> },
  name: string,
): void {
  const property = parameterProperties(schema.parameters)[name]
  assert.ok(isRecord(property), `schema must declare the ${name} parameter`)
  assert.equal(property.type, 'string')
}

function assertComposition(ctx: Context, agent: Agent): void {
  const globalNames = ctx.tools.definitions().map(definition => definition.name)
  assert.ok(globalNames.includes('bash'), 'bash must exist globally before the scoped restriction')
  assert.equal(globalNames.includes(`${MCP_PREFIX}echo`), false, 'MCP tools must be agent-scoped, not global')

  const definitions = ctx.tools.definitions(agent)
  const definitionNames = definitions.map(definition => definition.name).sort()
  assert.deepEqual(definitionNames, [...EXPECTED_SCOPED_TOOLS].sort())
  assert.equal(definitionNames.includes('bash'), false, 'global restrict must still hide bash')

  const schemaNames = ctx.tools.schemas(agent).map(schema => schema.name).sort()
  assert.deepEqual(schemaNames, definitionNames)

  const echo = ctx.tools.schemas(agent).find(schema => schema.name === `${MCP_PREFIX}echo`)
  assert.ok(echo, 'echo must expose a model schema')
  assertStringParameter(echo, 'message')
  const guarded = ctx.tools.schemas(agent).find(schema => schema.name === GUARDED_TOOL)
  assert.ok(guarded, 'guarded must expose a model schema')
  assertStringParameter(guarded, 'message')
  const listResources = ctx.tools.schemas(agent).find(schema => schema.name === 'list_mcp_resources')
  assert.ok(listResources, 'resource tools must expose a model schema')
  assertStringParameter(listResources, 'server')
}

async function assertAssembly(ctx: Context, agent: Agent): Promise<void> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [...EXPECTED_SCOPED_TOOLS].sort())

  const mcpSection = assembly.sections.find(section => section.name === `mcp:${SERVER_NAME}`)
  assert.ok(mcpSection, 'MCP server instructions must be assembled into the system prompt')
  assert.ok(mcpSection.text.includes(FIXTURE_INSTRUCTIONS_FRAGMENT))
  assert.ok(mcpSection.text.includes(FIXTURE_INSTRUCTIONS_TAIL))

  const resourceSection = assembly.sections.find(section => section.name === 'mcp-resource-servers')
  assert.ok(resourceSection, 'resource server guidance must be assembled into the system prompt')
  assert.ok(resourceSection.text.includes(JSON.stringify([SERVER_NAME])))
  for (const name of RESOURCE_TOOL_NAMES) assert.ok(resourceSection.text.includes(name))
}

async function assertMcpDeclarationsRemoved(ctx: Context, agent: Agent): Promise<void> {
  const definitionNames = ctx.tools.definitions(agent).map(definition => definition.name)
  for (const name of REMOVED_TOOL_NAMES) {
    assert.equal(definitionNames.includes(name), false, `${name} must disappear with the agent`)
    assert.equal(ctx.tools.get(name, agent), undefined)
  }
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  assert.equal(assembly.tools.some(tool => REMOVED_TOOL_NAMES.includes(tool.name)), false)
  const mcpSection = assembly.sections.find(section => section.name === `mcp:${SERVER_NAME}`)
  assert.equal(mcpSection === undefined || mcpSection.text.trim().length === 0, true)
  const resourceSection = assembly.sections.find(section => section.name === 'mcp-resource-servers')
  assert.equal(resourceSection === undefined || resourceSection.text.trim().length === 0, true)
}

function assertNegotiationLog(records: readonly StreamableHttpLogRecord[]): void {
  const methods = requestMethods(records)
  const discoverIndex = methods.indexOf('server/discover')
  const initializeIndex = methods.indexOf('initialize')
  const toolsListIndex = methods.indexOf('tools/list')
  assert.ok(discoverIndex >= 0, 'the client must probe server/discover before legacy fallback')
  assert.ok(initializeIndex >= 0, 'the client must complete the legacy initialize handshake')
  assert.ok(toolsListIndex >= 0, 'the client must list tools after initialization')
  assert.ok(discoverIndex < initializeIndex, 'server/discover must precede initialize')
  assert.ok(initializeIndex < toolsListIndex, 'initialize must precede tools/list')
  assert.equal(methods.filter(method => method === 'server/discover').length, 1)
  assert.equal(methods.filter(method => method === 'initialize').length, 1)
  assert.equal(methods.filter(method => method === 'notifications/initialized').length, 1)
  assert.equal(methods.filter(method => method === 'tools/list').length, 1)

  const mcpRequests = requestRecords(records).filter(record => record.rpcMethod !== null)
  assert.ok(mcpRequests.length >= 4)
  for (const record of mcpRequests) {
    assert.equal(record.clientHeader, CLIENT_HEADER_VALUE, 'every MCP request must carry the configured header')
  }
}

async function assertNoLegacySse(fixture: StreamableHttpFixture): Promise<void> {
  const legacySse = await fetch(new URL('/sse', fixture.url))
  assert.equal(legacySse.status, 404, 'the fixture must not expose the legacy SSE endpoint')
  assert.equal(legacySse.headers.get('content-type')?.includes('text/event-stream') ?? false, false)
  await legacySse.text()

  const getMcp = await fetch(fixture.url)
  assert.equal(getMcp.status, 405, 'the fixture must not open a standalone SSE stream')
  assert.equal(getMcp.headers.get('content-type')?.includes('text/event-stream') ?? false, false)
  await getMcp.text()
}

void test('alpha2 MCP streamable-http keeps admission, declarations, dispatch, cancellation, and connection cleanup aligned', { timeout: 180_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-mcp-http-work-'))
  const dshHome = await mkdtemp(join(tmpdir(), 'singularity-mcp-http-dsh-'))

  let fixture: StreamableHttpFixture | undefined
  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  let handle: AgentHandle | undefined
  let disposeCreatedListener: (() => boolean) | undefined
  try {
    fixture = await startStreamableHttpFixture()
    const mcpFixture = fixture
    assert.equal(mcpFixture.enableJsonResponse, true)
    assert.deepEqual([...mcpFixture.supportedProtocolVersions], [...SUPPORTED_PROTOCOL_VERSIONS])
    assert.deepEqual([...mcpFixture.supportedProtocolVersions], [...LEGACY_PROTOCOL_VERSIONS])
    assert.equal(mcpFixture.supportedProtocolVersions.some(version => version.startsWith('2026-')), false)
    await assertNoLegacySse(fixture)

    spike = await bootSpikeProfile({
      home: dshHome,
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'fixture-key',
    })
    assert.equal(spike.dshVersion, '0.2.2-alpha.2')
    const ctx = spike.ctx
    const agentOptions = {
      provider: 'singularity-local',
      model: 'deepseek-flash',
      reasoningEffort: ReasoningEffortId('max'),
    } satisfies AgentOptions

    const createdSessions = new Set<string>()
    disposeCreatedListener = ctx.on('agent/created', ({ agent }) => {
      createdSessions.add(String(agent.session.id))
      return undefined
    })

    const requestsAfterEndpointProbe = mcpFixture.requestCount

    const deniedServer: McpServerSpec = { serverName: 'spike-http-intruder', url: mcpFixture.url }
    const deniedSessionId = SessionId(`s1-c-mcp-http-denied-${String(process.pid)}-${String(Date.now())}`)
    const deniedSetup: AgentSetup = async agentCtx => {
      admitMcpServer(deniedServer, [{ serverName: SERVER_NAME, url: mcpFixture.url }])
      await agentCtx.plugin(mcpClient, streamableHttpConfig(deniedServer))
    }
    await assert.rejects(
      ctx.agents.create({
        sessionId: deniedSessionId,
        meta: { cwd: workspace },
        agentOptions,
        setup: deniedSetup,
      }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /not in the deployment allowlist/)
        return true
      },
    )
    assert.equal(ctx.agents.get(deniedSessionId), undefined)
    assert.equal(createdSessions.has(String(deniedSessionId)), false)
    assert.equal(mcpFixture.requestCount, requestsAfterEndpointProbe, 'denied server must not reach the fixture')

    const closedPort = await reserveClosedPort()
    const missingServer: McpServerSpec = {
      serverName: 'spike-http-missing',
      url: `http://127.0.0.1:${String(closedPort)}/mcp`,
    }
    const startupSessionId = SessionId(`s1-c-mcp-http-startup-${String(process.pid)}-${String(Date.now())}`)
    const startupSetup: AgentSetup = async agentCtx => {
      admitMcpServer(missingServer, [{ serverName: SERVER_NAME, url: mcpFixture.url }, missingServer])
      await agentCtx.plugin(mcpClient, streamableHttpConfig(missingServer))
    }
    await assert.rejects(
      ctx.agents.create({
        sessionId: startupSessionId,
        meta: { cwd: workspace },
        agentOptions,
        setup: startupSetup,
      }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /initial connection or tool synchronization failed/)
        return true
      },
    )
    assert.equal(ctx.agents.get(startupSessionId), undefined)
    assert.equal(createdSessions.has(String(startupSessionId)), false)
    assert.equal(mcpFixture.requestCount, requestsAfterEndpointProbe, 'startup failure must not reach the fixture')

    const state = { setupRuns: 0 }
    const approvedConfig = streamableHttpConfig({ serverName: SERVER_NAME, url: mcpFixture.url })
    const approvedSetup: AgentSetup = async agentCtx => {
      admitMcpServer({ serverName: SERVER_NAME, url: mcpFixture.url }, [{ serverName: SERVER_NAME, url: mcpFixture.url }])
      agentCtx.tools.restrict({ allow: ['working_directory', 'skill'] })
      agentCtx.tools.guard(deniedReason)
      await agentCtx.plugin(mcpClient, approvedConfig)
      state.setupRuns += 1
    }
    const sessionId = SessionId(`s1-c-mcp-http-${String(process.pid)}-${String(Date.now())}`)
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace },
      agentOptions,
      setup: approvedSetup,
    })
    assert.equal(state.setupRuns, 1)
    assert.equal(createdSessions.has(String(sessionId)), true)
    assert.equal(ctx.agents.get(sessionId), handle.agent)
    assert.equal(handle.agent.status, 'idle')

    const agent = handle.agent
    assertComposition(ctx, agent)
    await assertAssembly(ctx, agent)

    await mcpFixture.waitFor(
      records => {
        const methods = requestMethods(records)
        return methods.includes('server/discover') && methods.includes('initialize') && methods.includes('tools/list')
      },
      'MCP negotiation and tools/list',
    )
    assertNegotiationLog(mcpFixture.records)

    const echoMessage = 'streamable-http-echo-success'
    const echo = await executeOne(ctx, agent, `${MCP_PREFIX}echo`, { message: echoMessage })
    assertSuccess(echo)
    assert.equal(textOfResult(echo), echoMessage)
    assert.equal(structuredMessage(echo.value), echoMessage)
    assert.equal(toolCallsOf(mcpFixture.records, 'echo').length, 1)
    assert.equal(toolRecords(mcpFixture.records, 'echo').length, 1)

    const fail = await executeOne(ctx, agent, `${MCP_PREFIX}fail`, { message: 'expected-failure' })
    assertFailure(fail)
    assert.equal(fail.error.message, 'fixture failure: expected-failure')
    assert.equal(textOfResult(fail), 'Error: fixture failure: expected-failure')
    assert.equal(toolCallsOf(mcpFixture.records, 'fail').length, 1)

    const guardedRequestsBefore = mcpFixture.requestCount
    const guarded = await executeOne(ctx, agent, GUARDED_TOOL, { message: 'must-not-reach-server' })
    assertFailure(guarded)
    assert.equal(guarded.error.message, GUARD_REASON)
    assert.equal(guarded.error.info, undefined)
    assert.equal(textOfResult(guarded), `Error: ${GUARD_REASON}`)
    assert.equal(mcpFixture.requestCount, guardedRequestsBefore, 'a denied guarded call must not reach the fixture')
    assert.equal(toolCallsOf(mcpFixture.records, 'guarded').length, 0)
    assert.equal(toolRecords(mcpFixture.records, 'guarded').length, 0)

    const resourceServer = await executeOne(ctx, agent, 'list_mcp_resources', { server: SERVER_NAME })
    assertSuccess(resourceServer)
    const resourceText = textOfResult(resourceServer)
    assert.ok(resourceText.includes(`MCP server: ${SERVER_NAME}`))
    assert.ok(resourceText.includes('"resources":[]'))
    assert.ok(requestMethods(mcpFixture.records).includes('resources/list'))

    const resourceRequestsBefore = mcpFixture.requestCount
    const resourceListsBefore = requestMethods(mcpFixture.records).filter(method => method === 'resources/list').length
    const deniedResourceName = 'spike-http-other'
    for (const name of RESOURCE_TOOL_NAMES) {
      const args = name === 'read_mcp_resource'
        ? { server: deniedResourceName, uri: 'spike-http://not-admitted' }
        : { server: deniedResourceName }
      const deniedResource = await executeOne(ctx, agent, name, args)
      assertFailure(deniedResource)
      assert.equal(deniedResource.error.message, `MCP resource server "${deniedResourceName}" is not admitted`)
      assert.equal(textOfResult(deniedResource), `Error: MCP resource server "${deniedResourceName}" is not admitted`)
    }
    assert.equal(mcpFixture.requestCount, resourceRequestsBefore, 'guarded resource tools must not reach the fixture')
    assert.equal(
      requestMethods(mcpFixture.records).filter(method => method === 'resources/list').length,
      resourceListsBefore,
    )
    assert.equal(requestMethods(mcpFixture.records).filter(method => method === 'resources/read').length, 0)
    assert.equal(requestMethods(mcpFixture.records).filter(method => method === 'resources/templates/list').length, 0)

    const timeoutMessage = 'streamable-http-timeout-hang'
    const timeoutStartedAt = Date.now()
    const timedOut = await executeOne(ctx, agent, `${MCP_PREFIX}hang`, { message: timeoutMessage })
    const timeoutElapsed = Date.now() - timeoutStartedAt
    assertFailure(timedOut)
    assert.equal(timedOut.error.message, 'Request timed out')
    assert.equal(textOfResult(timedOut), 'Error: Request timed out')
    assert.ok(timeoutElapsed >= TOOL_CALL_TIMEOUT_MS - 50, `timeout fired too early: ${String(timeoutElapsed)}ms`)
    assert.ok(timeoutElapsed < 10_000, `timeout fired too late: ${String(timeoutElapsed)}ms`)
    await mcpFixture.waitFor(
      records => abortRecords(records, 'hang').some(record => record.message === timeoutMessage),
      'timeout cancellation at the fixture',
    )
    assert.equal(toolRecords(mcpFixture.records, 'hang').filter(record => messageOfToolRecord(record) === timeoutMessage).length, 1)
    assert.equal(toolCallsOf(mcpFixture.records, 'hang').length, 1)

    const afterTimeout = await executeOne(ctx, agent, `${MCP_PREFIX}echo`, { message: 'after-timeout' })
    assertSuccess(afterTimeout)
    assert.equal(textOfResult(afterTimeout), 'after-timeout')

    const preAbortMessage = 'streamable-http-pre-abort-hang'
    const preAbortRequestsBefore = mcpFixture.requestCount
    const preAbort = new AbortController()
    preAbort.abort()
    const preAborted = await executeOne(ctx, agent, `${MCP_PREFIX}hang`, { message: preAbortMessage }, preAbort.signal)
    assertFailure(preAborted)
    assert.equal(preAborted.error.message, 'tool call aborted before dispatch')
    assert.equal(preAborted.error.info?.name, 'AbortError')
    assert.equal(preAborted.error.info.code, TOOL_ABORTED_BEFORE_DISPATCH)
    assert.equal(textOfResult(preAborted), 'Error: tool call aborted before dispatch')
    assert.equal(mcpFixture.requestCount, preAbortRequestsBefore, 'a pre-abort call must not reach the fixture')
    assert.equal(
      toolRecords(mcpFixture.records, 'hang').some(record => messageOfToolRecord(record) === preAbortMessage),
      false,
      'a pre-abort call must not reach the fixture tool handler',
    )

    const inFlightMessage = 'streamable-http-in-flight-abort-hang'
    const inFlight = new AbortController()
    const inFlightResult = executeOne(ctx, agent, `${MCP_PREFIX}hang`, { message: inFlightMessage }, inFlight.signal)
    await mcpFixture.waitFor(
      records => toolRecords(records, 'hang').some(record => messageOfToolRecord(record) === inFlightMessage),
      'in-flight hang dispatch',
    )
    inFlight.abort()
    const abortedResult = await inFlightResult
    assertFailure(abortedResult)
    assert.ok(abortedResult.error.message.length > 0)
    assert.ok(textOfResult(abortedResult).startsWith('Error: '))
    await mcpFixture.waitFor(
      records => abortRecords(records, 'hang').some(record => record.message === inFlightMessage),
      'in-flight cancellation at the fixture',
    )
    assert.equal(
      toolRecords(mcpFixture.records, 'hang').filter(record => messageOfToolRecord(record) === inFlightMessage).length,
      1,
    )
    assert.equal(toolCallsOf(mcpFixture.records, 'hang').length, 2, 'timeout and in-flight abort must both reach the fixture')

    const afterAbort = await executeOne(ctx, agent, `${MCP_PREFIX}echo`, { message: 'after-abort' })
    assertSuccess(afterAbort)
    assert.equal(textOfResult(afterAbort), 'after-abort')

    for (const record of requestRecords(mcpFixture.records)) {
      if (record.rpcMethod !== null) {
        assert.equal(record.clientHeader, CLIENT_HEADER_VALUE, 'every MCP request must carry the configured header')
      }
    }

    assert.ok(mcpFixture.openedConnections > 0, 'the fixture must have accepted real HTTP connections')
    assert.equal(requestRecords(mcpFixture.records).some(record => record.httpMethod === 'DELETE'), false)
    // Cancelled MCP responses are dropped by the protocol layer, so the HTTP
    // requests they belong to stay open until the client transport is closed.
    // This makes the post-dispose connection cleanup assertion non-vacuous.
    assert.ok(mcpFixture.activeRequests > 0, 'cancelled hang requests must still hold open connections before disposal')

    const requestsBeforeDispose = mcpFixture.requestCount
    await handle.dispose()
    handle = undefined
    assert.equal(ctx.agents.get(sessionId), undefined)
    await assertMcpDeclarationsRemoved(ctx, agent)

    const afterDispose = await attemptAfterDispose(ctx, agent, `${MCP_PREFIX}echo`, { message: 'after-dispose' })
    if (afterDispose !== undefined) assertFailure(afterDispose)
    await delay(300)
    assert.equal(mcpFixture.requestCount, requestsBeforeDispose, 'a disposed MCP client must not issue new HTTP requests')
    await mcpFixture.waitForIdle()
    assert.equal(mcpFixture.activeConnections, 0)
    assert.equal(mcpFixture.openedConnections, mcpFixture.closedConnections, 'all fixture HTTP connections must be closed')

    await mcpFixture.close()
    assert.equal(mcpFixture.closed, true)
  } finally {
    disposeCreatedListener?.()
    await handle?.dispose()
    await spike?.dispose()
    await fixture?.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})
