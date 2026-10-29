import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import type { JsonSchemaType } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

/**
 * Deterministic stdio fixture for the S1-B MCP spike. The same factory serves
 * the client's disposable version-negotiation probe sibling and the live
 * connection, so each spawned process logs its own start/tool/exit records.
 */
const SPIKE_INSTRUCTIONS = [
  'SINGULARITY S1-B MCP stdio spike fixture.',
  'Use echo for a successful structuredContent result,',
  'fail for a server-reported tool error,',
  'guarded to observe whether host guards allow dispatch,',
  'and hang to exercise host timeout and cancellation; hang never returns.',
].join(' ')

const logPath = process.argv.at(2)
if (logPath === undefined || logPath.length === 0) {
  process.stderr.write('mcp-stdio-server: argv[2] must be the JSONL log path\n')
  process.exit(2)
}

const logFile: string = logPath
mkdirSync(dirname(logFile), { recursive: true })

type LogRecord =
  | { readonly type: 'start'; readonly pid: number; readonly cwd: string }
  | { readonly type: 'tool'; readonly name: string; readonly args: unknown; readonly pid: number }
  | { readonly type: 'exit'; readonly pid: number; readonly code: number }

const SECRET_KEY = /(secret|token|password|passwd|api[-_]?key|authorization|credential)/i

let exitRecorded = false

function writeLog(record: LogRecord): void {
  appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep diagnostics useful while never copying credential-shaped fields. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) items.push(redact(item))
    return items
  }
  if (!isRecord(value)) return value
  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item)
  }
  return redacted
}

function recordTool(name: string, args: unknown): void {
  writeLog({ type: 'tool', name, args: redact(args), pid: process.pid })
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

writeLog({ type: 'start', pid: process.pid, cwd: process.cwd() })

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

const optionalMessageInputSchema: JsonSchemaType = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description: 'Optional diagnostic text recorded in the fixture log.',
    },
  },
}

const messageOutputSchema: JsonSchemaType = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
}

serveStdio(() => {
  const server = new McpServer(
    { name: 'singularity-s1-b-mcp-stdio-fixture', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions: SPIKE_INSTRUCTIONS,
    },
  )

  server.registerTool('echo', {
    title: 'Echo',
    description: 'Return the supplied message as text content and structuredContent.',
    inputSchema: fromJsonSchema<{ message: string }>(messageInputSchema),
    outputSchema: fromJsonSchema<{ message: string }>(messageOutputSchema),
  }, ({ message }) => {
    recordTool('echo', { message })
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: { message },
    }
  })

  server.registerTool('fail', {
    title: 'Fail',
    description: 'Return an MCP tool-level error result without structuredContent.',
    inputSchema: fromJsonSchema<{ message?: string }>(optionalMessageInputSchema),
  }, ({ message }) => {
    recordTool('fail', message === undefined ? {} : { message })
    return {
      content: [{ type: 'text', text: `fixture failure: ${message ?? 'no message'}` }],
      isError: true,
    }
  })

  server.registerTool('guarded', {
    title: 'Guarded',
    description: 'Record a tool log entry and return the supplied message; a host guard should block dispatch.',
    inputSchema: fromJsonSchema<{ message: string }>(messageInputSchema),
    outputSchema: fromJsonSchema<{ message: string }>(messageOutputSchema),
  }, ({ message }) => {
    recordTool('guarded', { message })
    return {
      content: [{ type: 'text', text: message }],
      structuredContent: { message },
    }
  })

  server.registerTool('hang', {
    title: 'Hang',
    description: 'Record a tool log entry and never resolve; exercises host timeout and cancellation.',
    inputSchema: fromJsonSchema<{ message?: string }>(optionalMessageInputSchema),
  }, ({ message }) => {
    recordTool('hang', message === undefined ? {} : { message })
    return new Promise<never>(() => {})
  })

  return server
})
