import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

import { bootSpikeProfile } from '../src/host-composition.ts'

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/mcp-stdio-server.ts', import.meta.url))
const SERVER_NAME = 'spike'
const MCP_PREFIX = `mcp__${SERVER_NAME}__`
const GUARDED_TOOL = `${MCP_PREFIX}guarded`
const GUARD_REASON = 'the guarded MCP tool is denied by the S1-B agent guard'
const RESOURCE_TOOL_NAMES = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] as const
const RESOURCE_TOOL_NAME_SET: ReadonlySet<string> = new Set(RESOURCE_TOOL_NAMES)
const EXPECTED_MCP_TOOLS: readonly string[] = ['echo', 'fail', 'guarded', 'hang'].map(name => `${MCP_PREFIX}${name}`)
const EXPECTED_SCOPED_TOOLS: readonly string[] = ['skill', 'working_directory', ...EXPECTED_MCP_TOOLS, ...RESOURCE_TOOL_NAMES]
const REMOVED_TOOL_NAMES: readonly string[] = [...EXPECTED_MCP_TOOLS, ...RESOURCE_TOOL_NAMES]
const INSTRUCTIONS_FRAGMENT = 'SINGULARITY S1-B MCP stdio spike fixture.'
const INSTRUCTIONS_TAIL = 'hang never returns.'
const TOOL_CALL_TIMEOUT_MS = 250
const PROCESS_EXIT_TIMEOUT_MS = 20_000

interface McpServerSpec {
  readonly serverName: string
  readonly command: string
  readonly args: readonly string[]
  readonly logPath: string
}

type LogRecord =
  | { readonly type: 'start'; readonly pid: number; readonly cwd: string }
  | { readonly type: 'tool'; readonly name: string; readonly args: unknown; readonly pid: number }
  | { readonly type: 'exit'; readonly pid: number; readonly code: number }

type ToolLogRecord = Extract<LogRecord, { type: 'tool' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseLogRecord(value: unknown): LogRecord | undefined {
  if (!isRecord(value)) return undefined
  const pid = value.pid
  if (!isFiniteNumber(pid) || !Number.isInteger(pid) || pid <= 0) return undefined
  switch (value.type) {
    case 'start': {
      const cwd = value.cwd
      return typeof cwd === 'string' ? { type: 'start', pid, cwd } : undefined
    }
    case 'tool': {
      const name = value.name
      return typeof name === 'string' ? { type: 'tool', name, args: value.args, pid } : undefined
    }
    case 'exit': {
      const code = value.code
      return isFiniteNumber(code) ? { type: 'exit', pid, code } : undefined
    }
    default:
      return undefined
  }
}

async function readMcpLog(path: string): Promise<LogRecord[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return []
    throw error
  }
  const records: LogRecord[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      continue
    }
    const record = parseLogRecord(parsed)
    if (record !== undefined) records.push(record)
  }
  return records
}

function toolRecords(records: readonly LogRecord[]): ToolLogRecord[] {
  return records.filter((record): record is ToolLogRecord => record.type === 'tool')
}

function toolPids(records: readonly LogRecord[]): number[] {
  return [...new Set(toolRecords(records).map(record => record.pid))]
}

function messageOfToolRecord(record: ToolLogRecord): string | undefined {
  if (!isRecord(record.args)) return undefined
  const message = record.args.message
  return typeof message === 'string' ? message : undefined
}

async function waitForLog(
  path: string,
  predicate: (records: readonly LogRecord[]) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate(await readMcpLog(path))) return
    await delay(20)
  }
  assert.fail(`timed out waiting for ${label}`)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(isErrnoException(error) && error.code === 'ESRCH')
  }
}

/**
 * Prove the child process actually exited: every logged PID must have an exit
 * record and must no longer answer signal 0. Version negotiation may spawn a
 * disposable sibling, so all logged PIDs are checked, not just the live one.
 */
async function assertFixtureProcessesExited(logPath: string): Promise<readonly number[]> {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  let startPids: readonly number[] = []
  let pending: readonly number[] = []
  while (Date.now() < deadline) {
    const records = await readMcpLog(logPath)
    startPids = [...new Set(records.filter(record => record.type === 'start').map(record => record.pid))]
    const exited = new Set(records.filter(record => record.type === 'exit').map(record => record.pid))
    pending = startPids.filter(pid => !exited.has(pid) || processAlive(pid))
    if (startPids.length > 0 && pending.length === 0) return startPids
    await delay(25)
  }
  assert.fail(`MCP fixture processes still running after disposal: ${pending.join(', ')}`)
}

/** Observe the child HOME where Linux exposes it; cwd is asserted from the fixture log. */
async function assertChildHome(pid: number, expectedHome: string): Promise<void> {
  let environ: Buffer
  try {
    environ = await readFile(`/proc/${String(pid)}/environ`)
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'EACCES')) return
    throw error
  }
  assert.ok(
    environ.toString('utf8').split('\0').includes(`HOME=${expectedHome}`),
    `MCP fixture PID ${String(pid)} must run with its isolated HOME`,
  )
}

function admitMcpServer(spec: McpServerSpec, admitted: readonly McpServerSpec[]): void {
  const allowed = admitted.some(entry => entry.serverName === spec.serverName && entry.command === spec.command)
  if (!allowed) throw new Error(`MCP server "${spec.serverName}" is not in the deployment allowlist`)
}

function stdioConfig(spec: McpServerSpec, home: string, cwd: string): StdioConfig {
  return {
    transport: 'stdio',
    serverName: spec.serverName,
    command: spec.command,
    args: [...spec.args],
    env: { HOME: home },
    cwd,
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: true,
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
      id: ToolCallId(`s1-b-mcp-call-${String(callSequence)}`),
      name,
      arguments: JSON.stringify(args),
    }],
  })
  assert.equal(outcome.results.length, 1)
  const [settled] = outcome.results
  assert.ok(settled)
  return settled.result
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
  assert.ok(mcpSection.text.includes(INSTRUCTIONS_FRAGMENT))
  assert.ok(mcpSection.text.includes(INSTRUCTIONS_TAIL))

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
  // The resource runtime keeps its global section, but an empty text means no
  // resource server remains visible; the per-server instructions must vanish.
  const mcpSection = assembly.sections.find(section => section.name === `mcp:${SERVER_NAME}`)
  assert.equal(mcpSection === undefined || mcpSection.text.trim().length === 0, true)
  const resourceSection = assembly.sections.find(section => section.name === 'mcp-resource-servers')
  assert.equal(resourceSection === undefined || resourceSection.text.trim().length === 0, true)
}

void test('alpha2 MCP stdio keeps admission, declarations, dispatch, cancellation, and process cleanup aligned', { timeout: 180_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-mcp-stdio-work-'))
  const mcpWorkspace = await mkdtemp(join(tmpdir(), 'singularity-mcp-stdio-server-'))
  const mcpHome = await mkdtemp(join(tmpdir(), 'singularity-mcp-stdio-home-'))
  const dshHome = await mkdtemp(join(tmpdir(), 'singularity-mcp-stdio-dsh-'))
  const logDirectory = join(workspace, 'mcp-logs')
  const approvedLog = join(logDirectory, 'approved.jsonl')
  const deniedLog = join(logDirectory, 'denied.jsonl')
  const startupLog = join(logDirectory, 'startup-failure.jsonl')

  const approvedServer: McpServerSpec = {
    serverName: SERVER_NAME,
    command: process.execPath,
    args: [FIXTURE_PATH, approvedLog],
    logPath: approvedLog,
  }
  const missingCommandServer: McpServerSpec = {
    serverName: 'spike-missing',
    command: join(mcpWorkspace, 'definitely-missing-mcp-server'),
    args: [startupLog],
    logPath: startupLog,
  }
  const deniedServer: McpServerSpec = {
    serverName: 'spike-intruder',
    command: process.execPath,
    args: [FIXTURE_PATH, deniedLog],
    logPath: deniedLog,
  }
  const admittedServers: readonly McpServerSpec[] = [approvedServer, missingCommandServer]

  let spike: Awaited<ReturnType<typeof bootSpikeProfile>> | undefined
  let handle: AgentHandle | undefined
  let disposeCreatedListener: (() => boolean) | undefined
  try {
    spike = await bootSpikeProfile({
      home: dshHome,
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'fixture-key',
    })
    assert.equal(spike.dshVersion, '0.2.2-alpha.2')
    const ctx = spike.ctx
    const agentOptions = {
      provider: 'singularity-local',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: ReasoningEffortId('max'),
    } satisfies AgentOptions

    const createdSessions = new Set<string>()
    disposeCreatedListener = ctx.on('agent/created', ({ agent }) => {
      createdSessions.add(String(agent.session.id))
      return undefined
    })

    const deniedSessionId = SessionId(`s1-b-mcp-denied-${String(process.pid)}-${String(Date.now())}`)
    const deniedSetup: AgentSetup = async agentCtx => {
      admitMcpServer(deniedServer, admittedServers)
      await agentCtx.plugin(mcpClient, stdioConfig(deniedServer, mcpHome, mcpWorkspace))
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
    await assert.rejects(access(deniedLog), error => isErrnoException(error) && error.code === 'ENOENT')

    const startupSessionId = SessionId(`s1-b-mcp-startup-${String(process.pid)}-${String(Date.now())}`)
    const startupSetup: AgentSetup = async agentCtx => {
      admitMcpServer(missingCommandServer, admittedServers)
      await agentCtx.plugin(mcpClient, stdioConfig(missingCommandServer, mcpHome, mcpWorkspace))
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
    await assert.rejects(access(startupLog), error => isErrnoException(error) && error.code === 'ENOENT')

    const state = { setupRuns: 0 }
    const approvedConfig = stdioConfig(approvedServer, mcpHome, mcpWorkspace)
    const approvedSetup: AgentSetup = async agentCtx => {
      admitMcpServer(approvedServer, admittedServers)
      agentCtx.tools.restrict({ allow: ['working_directory', 'skill'] })
      agentCtx.tools.guard(deniedReason)
      await agentCtx.plugin(mcpClient, approvedConfig)
      state.setupRuns += 1
    }
    const sessionId = SessionId(`s1-b-mcp-stdio-${String(process.pid)}-${String(Date.now())}`)
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

    await waitForLog(approvedLog, records => records.some(record => record.type === 'start'), 'fixture startup')
    const startRecords = (await readMcpLog(approvedLog)).filter(record => record.type === 'start')
    assert.ok(startRecords.length > 0)
    for (const record of startRecords) assert.equal(record.cwd, mcpWorkspace)

    const echoMessage = 'mcp-echo-success'
    const echo = await executeOne(ctx, agent, `${MCP_PREFIX}echo`, { message: echoMessage })
    assertSuccess(echo)
    assert.equal(textOfResult(echo), echoMessage)
    assert.equal(structuredMessage(echo.value), echoMessage)

    const fail = await executeOne(ctx, agent, `${MCP_PREFIX}fail`, { message: 'expected-failure' })
    assertFailure(fail)
    assert.equal(fail.error.message, 'fixture failure: expected-failure')
    assert.equal(textOfResult(fail), 'Error: fixture failure: expected-failure')

    const guarded = await executeOne(ctx, agent, GUARDED_TOOL, { message: 'must-not-reach-server' })
    assertFailure(guarded)
    assert.equal(guarded.error.message, GUARD_REASON)
    assert.equal(guarded.error.info, undefined)
    assert.equal(textOfResult(guarded), `Error: ${GUARD_REASON}`)

    const resourceServer = await executeOne(ctx, agent, 'list_mcp_resources', { server: SERVER_NAME })
    assertSuccess(resourceServer)
    assert.ok(textOfResult(resourceServer).includes(`MCP server: ${SERVER_NAME}`))
    assert.ok(textOfResult(resourceServer).includes('"resources":[]'))

    const deniedResourceName = 'spike-other'
    for (const name of RESOURCE_TOOL_NAMES) {
      const args = name === 'read_mcp_resource'
        ? { server: deniedResourceName, uri: 'spike://not-admitted' }
        : { server: deniedResourceName }
      const deniedResource = await executeOne(ctx, agent, name, args)
      assertFailure(deniedResource)
      assert.equal(deniedResource.error.message, `MCP resource server "${deniedResourceName}" is not admitted`)
      assert.equal(textOfResult(deniedResource), `Error: MCP resource server "${deniedResourceName}" is not admitted`)
    }

    const timeoutMessage = 'mcp-timeout-hang'
    const timeoutStartedAt = Date.now()
    const timedOut = await executeOne(ctx, agent, `${MCP_PREFIX}hang`, { message: timeoutMessage })
    const timeoutElapsed = Date.now() - timeoutStartedAt
    assertFailure(timedOut)
    assert.equal(timedOut.error.message, 'Request timed out')
    assert.equal(textOfResult(timedOut), 'Error: Request timed out')
    assert.ok(timeoutElapsed >= TOOL_CALL_TIMEOUT_MS - 50, `timeout fired too early: ${String(timeoutElapsed)}ms`)
    assert.ok(timeoutElapsed < 10_000, `timeout fired too late: ${String(timeoutElapsed)}ms`)

    const afterTimeout = await executeOne(ctx, agent, `${MCP_PREFIX}echo`, { message: 'after-timeout' })
    assertSuccess(afterTimeout)
    assert.equal(textOfResult(afterTimeout), 'after-timeout')

    const preAbortMessage = 'mcp-pre-abort-hang'
    const preAbort = new AbortController()
    preAbort.abort()
    const preAborted = await executeOne(ctx, agent, `${MCP_PREFIX}hang`, { message: preAbortMessage }, preAbort.signal)
    assertFailure(preAborted)
    assert.equal(preAborted.error.message, 'tool call aborted before dispatch')
    assert.equal(preAborted.error.info?.name, 'AbortError')
    assert.equal(preAborted.error.info.code, TOOL_ABORTED_BEFORE_DISPATCH)
    assert.equal(textOfResult(preAborted), 'Error: tool call aborted before dispatch')

    const inFlightMessage = 'mcp-in-flight-abort-hang'
    const inFlight = new AbortController()
    const inFlightResult = executeOne(ctx, agent, `${MCP_PREFIX}hang`, { message: inFlightMessage }, inFlight.signal)
    await waitForLog(
      approvedLog,
      records => toolRecords(records).some(record => record.name === 'hang' && messageOfToolRecord(record) === inFlightMessage),
      'in-flight hang dispatch',
    )
    inFlight.abort()
    const abortedResult = await inFlightResult
    assertFailure(abortedResult)
    assert.ok(abortedResult.error.message.length > 0)
    assert.ok(textOfResult(abortedResult).startsWith('Error: '))

    const afterAbort = await executeOne(ctx, agent, `${MCP_PREFIX}echo`, { message: 'after-abort' })
    assertSuccess(afterAbort)
    assert.equal(textOfResult(afterAbort), 'after-abort')

    const logRecords = await readMcpLog(approvedLog)
    const dispatchedPids = toolPids(logRecords)
    assert.ok(dispatchedPids.length > 0, 'the live fixture must log dispatched tool calls')
    const [livePid] = dispatchedPids
    assert.equal(processAlive(livePid), true, 'the fixture child must still be running before disposal')
    await assertChildHome(livePid, mcpHome)
    assert.equal(toolRecords(logRecords).some(record => record.name === 'guarded'), false, 'a denied guarded call must not reach the server')
    assert.equal(toolRecords(logRecords).some(record => record.name === 'hang' && messageOfToolRecord(record) === preAbortMessage), false, 'a pre-abort call must not reach the server')
    assert.equal(toolRecords(logRecords).filter(record => record.name === 'hang' && messageOfToolRecord(record) === timeoutMessage).length, 1)
    assert.equal(toolRecords(logRecords).filter(record => record.name === 'hang' && messageOfToolRecord(record) === inFlightMessage).length, 1)

    await handle.dispose()
    handle = undefined
    assert.equal(ctx.agents.get(sessionId), undefined)
    await assertMcpDeclarationsRemoved(ctx, agent)

    const exitedPids = await assertFixtureProcessesExited(approvedLog)
    assert.ok(exitedPids.includes(livePid), 'the live fixture PID must be among the exited processes')
    assert.equal(processAlive(livePid), false, 'the live fixture child must be gone after disposal')
  } finally {
    disposeCreatedListener?.()
    await handle?.dispose()
    await spike?.dispose()
    await rm(workspace, { recursive: true, force: true })
    await rm(mcpWorkspace, { recursive: true, force: true })
    await rm(mcpHome, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})
