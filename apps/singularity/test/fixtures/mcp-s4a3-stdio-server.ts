import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { fromJsonSchema, McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import type { JsonSchemaType } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

/**
 * Deterministic S4-A3 stdio fixture. It is materialized from the frozen Method
 * bundle, so it logs under its own cwd and never receives a host log path.
 */
const INSTRUCTIONS = [
  'SINGULARITY S4-A3 MCP stdio fixture.',
  'Use echo for a successful structuredContent result,',
  'echo_extra to prove the frozen exposedTools surface is exact,',
  'and the note resources to exercise native resource tools.',
].join(' ')

const LOG_PATH = '__S4A3_MCP_LOG__'
const logPath = LOG_PATH.startsWith('/') ? LOG_PATH : join(process.cwd(), 'mcp-server.log')
mkdirSync(dirname(logPath), { recursive: true })
const START_DELAY_MS = 0
const SIBLING_PATH = ''

type LogRecord =
  | {
    readonly type: 'start'
    readonly pid: number
    readonly cwd: string
    readonly cwdMode: number
    readonly rootMode: number
  }
  | { readonly type: 'sibling'; readonly pid: number; readonly exists: boolean }
  | {
    readonly type: 'env'
    readonly pid: number
    readonly home: string | null
    readonly sshAuthSock: string | null
    readonly gpgAgentInfo: string | null
    readonly kubeconfig: string | null
    readonly dockerHost: string | null
    readonly xdgConfigHome: string | null
    readonly xdgCacheHome: string | null
    readonly xdgDataHome: string | null
    readonly xdgStateHome: string | null
    readonly xdgRuntimeDir: string | null
    readonly tmpDir: string | null
  }
  | { readonly type: 'tool'; readonly name: string; readonly args: unknown; readonly pid: number }
  | { readonly type: 'resource'; readonly method: string; readonly uri: string | null; readonly pid: number }
  | { readonly type: 'exit'; readonly pid: number; readonly code: number }

let exitRecorded = false

function writeLog(record: LogRecord): void {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
}

function recordExit(code: number): void {
  if (exitRecorded) return
  exitRecorded = true
  try {
    writeLog({ type: 'exit', pid: process.pid, code })
  } catch {
    // Exit logging is best-effort; a closed log target must not block shutdown.
  }
}

process.once('SIGTERM', () => {
  recordExit(0)
  process.exit(0)
})
process.once('SIGINT', () => {
  recordExit(0)
  process.exit(0)
})
process.on('exit', code => {
  recordExit(code)
})

writeLog({
  type: 'start',
  pid: process.pid,
  cwd: process.cwd(),
  cwdMode: statSync(process.cwd()).mode & 0o777,
  rootMode: statSync(join(process.cwd(), '..')).mode & 0o777,
})

if (SIBLING_PATH.length > 0) {
  writeLog({
    type: 'sibling',
    pid: process.pid,
    exists: existsSync(join(process.cwd(), SIBLING_PATH)),
  })
}

function envValue(name: string): string | null {
  return process.env[name] ?? null
}

writeLog({
  type: 'env',
  pid: process.pid,
  home: envValue('HOME'),
  sshAuthSock: envValue('SSH_AUTH_SOCK'),
  gpgAgentInfo: envValue('GPG_AGENT_INFO'),
  kubeconfig: envValue('KUBECONFIG'),
  dockerHost: envValue('DOCKER_HOST'),
  xdgConfigHome: envValue('XDG_CONFIG_HOME'),
  xdgCacheHome: envValue('XDG_CACHE_HOME'),
  xdgDataHome: envValue('XDG_DATA_HOME'),
  xdgStateHome: envValue('XDG_STATE_HOME'),
  xdgRuntimeDir: envValue('XDG_RUNTIME_DIR'),
  tmpDir: envValue('TMPDIR'),
})

const messageInputSchema: JsonSchemaType = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description: 'Text echoed back in content and structuredContent.',
    },
  },
  required: ['message'],
}

const messageOutputSchema: JsonSchemaType = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
}

await new Promise(resolve => setTimeout(resolve, START_DELAY_MS))

serveStdio(() => {
  const server = new McpServer(
    { name: 'singularity-s4-a3-mcp-stdio-fixture', version: '0.0.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: INSTRUCTIONS,
    },
  )

  server.registerTool('echo', {
    title: 'Echo',
    description: 'Return the supplied message as text content and structuredContent.',
    inputSchema: fromJsonSchema<{ message: string }>(messageInputSchema),
    outputSchema: fromJsonSchema<{ message: string }>(messageOutputSchema),
  }, ({ message }) => {
    writeLog({ type: 'tool', name: 'echo', args: { message }, pid: process.pid })
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: { message },
    }
  })

  server.registerTool('echo_extra', {
    title: 'Echo extra',
    description: 'Return the supplied message from a tool that may be absent from a frozen asset.',
    inputSchema: fromJsonSchema<{ message: string }>(messageInputSchema),
    outputSchema: fromJsonSchema<{ message: string }>(messageOutputSchema),
  }, ({ message }) => {
    writeLog({ type: 'tool', name: 'echo_extra', args: { message }, pid: process.pid })
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: { message },
    }
  })

  server.registerResource(
    'note',
    's4a3://note',
    { title: 'Fixture note', mimeType: 'text/plain' },
    uri => {
      writeLog({ type: 'resource', method: 'resources/read', uri: uri.href, pid: process.pid })
      return { contents: [{ uri: uri.href, text: `note:${uri.href}` }] }
    },
  )

  server.registerResource(
    'note-template',
    new ResourceTemplate('s4a3://note/{id}', { list: undefined }),
    { title: 'Fixture note template', mimeType: 'text/plain' },
    (uri, variables) => {
      writeLog({ type: 'resource', method: 'resources/read', uri: uri.href, pid: process.pid })
      return { contents: [{ uri: uri.href, text: `note:${String(variables.id)}` }] }
    },
  )

  return server
})
