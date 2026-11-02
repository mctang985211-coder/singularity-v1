import assert from 'node:assert/strict'
import { mkdir,readFile,readdir } from 'node:fs/promises'
import { createServer } from 'node:http'

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'

import type { TaskExample,ToolAsset } from '@singularity/protocol'

import { messageTexts } from './fixtures/chat-completions.ts'

import type { StreamableHttpLogRecord } from './fixtures/mcp-streamable-http.ts'
import { STREAMABLE_HTTP_INSTRUCTIONS } from './fixtures/mcp-streamable-http.ts'
import type { McpServerFixture,ScriptedReply,SkillFixture,WireRequest } from './task-fixture.ts'
import { fixtureUsage } from './task-fixture.ts'

// ---------------------------------------------------------------------------
// S4-A1 — Method revision pin and current-layer guidance
// ---------------------------------------------------------------------------

export const S4A1_CURRENT_MARKER = 'S4-A1 CURRENT GUIDANCE MARKER'

export const S4A1_OTHER_MARKER = 'S4-A1 OTHER GUIDANCE MARKER'

// ---------------------------------------------------------------------------
// S4-A2 — Method skill binding, native discovery, and read guard
// ---------------------------------------------------------------------------

export const S4A2_SKILL_NAME = 's4a2-bounded-skill'

export const S4A2_SKILL_BODY = '# S4A2 bounded skill body\n\nFollow the frozen instructions.'

export const S4A2_SKILL_DESCRIPTION = 'Use the frozen S4-A2 skill while validating scoped discovery.'

export const S4A2_REFERENCE_BODY = 'S4A2 REFERENCE NOTES'

export function s4a2Skill(): SkillFixture {
  return {
    id: 'skill:s4a2',
    name: S4A2_SKILL_NAME,
    description: S4A2_SKILL_DESCRIPTION,
    content: S4A2_SKILL_BODY,
    extraFiles: [{ path: 'refs/notes.txt', content: S4A2_REFERENCE_BODY }],
  }
}

export function s4a2SecondSkill(): SkillFixture {
  return {
    id: 'skill:s4a2-b',
    name: 's4a2-second-skill',
    description: 'Use the second frozen S4-A2 skill for scoped discovery.',
    content: '# S4A2 second skill body\n',
  }
}

// ---------------------------------------------------------------------------
// S4-A3 — Method MCP stdio binding, native mount, guard, and lifecycle
// ---------------------------------------------------------------------------

const S4A3_APP_ROOT = fileURLToPath(new URL('..', import.meta.url))

// Each test runner process observes only its own materialization roots.
export const S4A3_TMP_ROOT = join(S4A3_APP_ROOT, '.tmp', 's4a3-tests', String(process.pid))

const S4A3_FIXTURE_URL = new URL('./fixtures/mcp-s4a3-stdio-server.ts', import.meta.url)

export const S4A3_INSTRUCTIONS = [
  'SINGULARITY S4-A3 MCP stdio fixture.',
  'Use echo for a successful structuredContent result,',
  'echo_extra to prove the frozen exposedTools surface is exact,',
  'and the note resources to exercise native resource tools.',
].join(' ')

export const S4A3_RESOURCE_TOOL_NAMES = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const

export const S4A3_MESSAGE_PARAMETERS = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'Text echoed back in content and structuredContent.',
    },
  },
  required: ['message'],
  additionalProperties: false,
}

export const S4A3_MESSAGE_OUTPUT = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
}

export function s4a3ExposedTools(): ToolAsset['server']['exposedTools'] {
  return [
    {
      name: 'echo',
      description: 'Return the supplied message as text content and structuredContent.',
      parameters: S4A3_MESSAGE_PARAMETERS,
      output: S4A3_MESSAGE_OUTPUT,
    },
    {
      name: 'echo_extra',
      description: 'Return the supplied message from a tool that may be absent from a frozen asset.',
      parameters: S4A3_MESSAGE_PARAMETERS,
      output: S4A3_MESSAGE_OUTPUT,
    },
  ]
}

export async function s4a3Server(
  logPath: string,
  options: {
    readonly serverName?: string
    readonly exposedTools?: ToolAsset['server']['exposedTools']
    readonly instructions?: string
    readonly source?: string
    readonly startDelayMs?: number
    readonly siblingCheckPath?: string
  } = {},
): Promise<McpServerFixture> {
  const source = options.source ?? (await readFile(S4A3_FIXTURE_URL, 'utf8'))
  return {
    serverName: options.serverName ?? 'calc',
    exposedTools: options.exposedTools ?? s4a3ExposedTools(),
    instructions: options.instructions ?? S4A3_INSTRUCTIONS,
    capabilities: ['tools', 'resources'],
    source: source
      .replace("'__S4A3_MCP_LOG__'", JSON.stringify(logPath))
      .replace('const START_DELAY_MS = 0', `const START_DELAY_MS = ${String(options.startDelayMs ?? 0)}`)
      .replace("const SIBLING_PATH = ''", `const SIBLING_PATH = ${JSON.stringify(options.siblingCheckPath ?? '')}`),
  }
}

export async function withS4a3Tmp<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR
  await mkdir(S4A3_TMP_ROOT, { recursive: true })
  process.env.TMPDIR = S4A3_TMP_ROOT
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}

interface S4A3LogRecord {
  readonly type: 'start' | 'tool' | 'resource' | 'exit' | 'env' | 'sibling'
  readonly pid: number
  readonly name?: string
  readonly method?: string
  readonly uri?: string | null
  readonly cwd?: string
  readonly cwdMode?: number
  readonly rootMode?: number
  readonly exists?: boolean
  readonly code?: number
  readonly home?: string | null
  readonly apiKey?: string | null
  readonly dshValue?: string | null
  readonly sshAuthSock?: string | null
  readonly gpgAgentInfo?: string | null
  readonly kubeconfig?: string | null
  readonly dockerHost?: string | null
  readonly xdgConfigHome?: string | null
  readonly xdgCacheHome?: string | null
  readonly xdgDataHome?: string | null
  readonly xdgStateHome?: string | null
  readonly xdgRuntimeDir?: string | null
  readonly tmpDir?: string | null
}

async function readS4a3Log(path: string): Promise<S4A3LogRecord[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const records: S4A3LogRecord[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const value = JSON.parse(line) as S4A3LogRecord
      if (typeof value.type === 'string' && typeof value.pid === 'number') records.push(value)
    } catch {
      // Ignore a partially written final line.
    }
  }
  return records
}

export function s4a3ProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

export async function waitForS4a3Log(
  path: string,
  predicate: (records: readonly S4A3LogRecord[]) => boolean,
  label: string,
): Promise<readonly S4A3LogRecord[]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const records = await readS4a3Log(path)
    if (predicate(records)) return records
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${label}`)
}

export function mcpToolReply(
  name: string,
  args: unknown,
  id: string,
  index: number,
): ScriptedReply {
  return {
    reasoning: `Invoke ${name} through the frozen MCP binding.`,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    usage: fixtureUsage(index),
  }
}

export async function s4a3RootLeftovers(): Promise<string[]> {
  try {
    return (await readdir(S4A3_TMP_ROOT)).filter(name => name.startsWith('singularity-mcp-'))
  } catch {
    return []
  }
}

export async function waitForS4a3RootsGone(label: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await s4a3RootLeftovers()).length === 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`timed out waiting for ${label}`)
}

// ---------------------------------------------------------------------------
// S4-A4 — Method streamable-http MCP
// ---------------------------------------------------------------------------

export const S4A4_SERVER_NAME = 'calc-http'

export const S4A4_RESOURCE_TOOL_NAMES = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const

export function s4a4ExposedTools(): ToolAsset['server']['exposedTools'] {
  return [
    {
      name: 'echo',
      description: 'Return the supplied message as text content and structuredContent.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', description: 'Text echoed back in content and structuredContent.' } },
        required: ['message'],
      },
    },
    {
      name: 'fail',
      description: 'Return an MCP tool-level error result without structuredContent.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', description: 'Optional diagnostic text recorded in the fixture log.' } },
      },
    },
    {
      name: 'guarded',
      description: 'Record a tool log entry and return the supplied message; a host guard should block dispatch.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', description: 'Text echoed back in content and structuredContent.' } },
        required: ['message'],
      },
    },
    {
      name: 'hang',
      description: 'Record a tool log entry and wait for host cancellation; exercises host timeout and abort.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', description: 'Optional diagnostic text recorded in the fixture log.' } },
      },
    },
  ]
}

export function s4a4Server(
  url: string,
  options: {
    readonly exposedTools?: ToolAsset['server']['exposedTools']
    readonly instructions?: string
    readonly toolCallTimeoutMs?: number
  } = {},
): McpServerFixture {
  return {
    serverName: S4A4_SERVER_NAME,
    transport: 'streamable-http',
    url,
    exposedTools: options.exposedTools ?? s4a4ExposedTools(),
    instructions: options.instructions ?? STREAMABLE_HTTP_INSTRUCTIONS,
    capabilities: ['tools', 'resources', 'resource-templates'],
    source: '// frozen S4-A4 HTTP source\n',
    entrypoint: 'src/server.ts',
    toolCallTimeoutMs: options.toolCallTimeoutMs,
  }
}

function s4a4RequestRecords(records: readonly StreamableHttpLogRecord[]): readonly Extract<StreamableHttpLogRecord, { type: 'request' }>[] {
  return records.filter((record): record is Extract<StreamableHttpLogRecord, { type: 'request' }> => record.type === 'request')
}

export function s4a4RpcMethods(records: readonly StreamableHttpLogRecord[]): (string | null)[] {
  return s4a4RequestRecords(records).map(record => record.rpcMethod)
}

export async function reserveClosedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: Error) => { reject(error) })
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

export function s4a4DirectConfig(url: string): StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName: S4A4_SERVER_NAME,
    url,
    headers: {},
    toolCallTimeoutMs: 5_000,
    failOnStartupError: true,
    maxInstructionBytes: 32_768,
    reconnect: { enabled: false },
  }
}

// ---------------------------------------------------------------------------
// S4-B1 — decompose prepare delivery and persisted receipt
// ---------------------------------------------------------------------------

export const S4B1_BINDING = 'binding:s4b1-probe'

export const S4B1_EXAMPLE_MARKER = 'S4B1 complete frozen child example'

export function s4b1Example(): TaskExample {
  return { acceptanceChecks: [],
    goal: {
      summary: `${S4B1_EXAMPLE_MARKER}: inspect the supplied sample and report one result.`,
      deliverable: 'A short result and a local note.',
      scope: ['single child sample'],
      constraints: ['Use the frozen example only; this prepare slice creates no child task.'],
    },
    localCriteria: [{
      id: 's4b1-local-criterion',
      statement: 'The local note records the observed sample.',
    }],
    inputs: [{
      id: 's4b1-sample',
      exampleText: 'sample input for the frozen child example',
    }],
    localOutputs: [{
      id: 's4b1-notes',
      path: 'notes.txt',
      kind: 'file',
      description: 'Local note for the child example.',
    }],
  }
}

// ---------------------------------------------------------------------------
// S4-B2 — decompose commit, atomic children-admitted, parent yield
// ---------------------------------------------------------------------------

export const S4B2_BINDING = 'binding:s4b2-probe'

export const S4B2_EXAMPLE_MARKER = 'S4B2 complete frozen child example'

export function s4b2Example(): TaskExample {
  return { acceptanceChecks: [],
    goal: {
      summary: `${S4B2_EXAMPLE_MARKER}: inspect the supplied sample and report one result.`,
      deliverable: 'A short result and a local note.',
      scope: ['single committed child sample'],
      constraints: ['Commit only after this complete example was delivered on a later model step.'],
    },
    localCriteria: [{
      id: 's4b2-local-criterion',
      statement: 'The local note records the observed sample.',
    }],
    inputs: [{
      id: 's4b2-sample',
      exampleText: 'sample input for the frozen B2 child example',
    }],
    localOutputs: [{
      id: 's4b2-notes',
      path: 'notes.txt',
      kind: 'file',
      description: 'Local note for the committed child example.',
    }],
  }
}

export function previewDigestFrom(request: WireRequest): string | undefined {
  for (const text of messageTexts(request)) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const previewRef = (value as { readonly previewRef?: unknown }).previewRef
    if (typeof previewRef !== 'object' || previewRef === null) continue
    const digest = (previewRef as { readonly digest?: unknown }).digest
    if (typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)) return digest
  }
  return undefined
}
