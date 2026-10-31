import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { fromJsonSchema, McpServer, ResourceTemplate, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server'
import type { CallToolResult, JsonSchemaType } from '@modelcontextprotocol/server'

export const FIXTURE_INSTRUCTIONS_FRAGMENT = 'SINGULARITY S1-C MCP streamable-http spike fixture.'
export const FIXTURE_INSTRUCTIONS_TAIL = 'hang waits for host cancellation.'
/** The SDK's legacy (pre-2026-07-28) protocol versions; the client must fall back to initialize. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = [...SUPPORTED_PROTOCOL_VERSIONS]

const CLIENT_HEADER_NAME = 'x-singularity-s1-c'
const SERVER_NAME = 'singularity-s1-c-mcp-streamable-http-fixture'
const SERVER_VERSION = '0.0.0'

const SPIKE_INSTRUCTIONS = [
  FIXTURE_INSTRUCTIONS_FRAGMENT,
  'Use echo for a successful structuredContent result,',
  'fail for a server-reported tool error,',
  'guarded to observe whether host guards allow dispatch,',
  'and hang to exercise host timeout and cancellation;',
  FIXTURE_INSTRUCTIONS_TAIL,
].join(' ')

/** Exact server instructions consumed by the A4 frozen manifest tests. */
export const STREAMABLE_HTTP_INSTRUCTIONS = SPIKE_INSTRUCTIONS

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

export type StreamableHttpLogRecord =
  | { readonly type: 'start'; readonly pid: number; readonly port: number; readonly url: string }
  | {
    readonly type: 'request'
    readonly pid: number
    readonly httpMethod: string
    readonly path: string
    readonly rpcMethod: string | null
    readonly rpcId: string | number | null
    readonly tool: string | null
    readonly clientHeader: string | null
    readonly cancelledRequestId: string | number | null
  }
  | { readonly type: 'tool'; readonly pid: number; readonly name: string; readonly args: unknown }
  | { readonly type: 'abort'; readonly pid: number; readonly name: string; readonly message: string | null }
  | { readonly type: 'connection'; readonly pid: number; readonly event: 'open' | 'close'; readonly active: number }
  | { readonly type: 'error'; readonly pid: number; readonly message: string }
  | { readonly type: 'close'; readonly pid: number }

export interface StreamableHttpFixture {
  readonly url: string
  readonly port: number
  readonly enableJsonResponse: boolean
  readonly supportedProtocolVersions: readonly string[]
  readonly records: readonly StreamableHttpLogRecord[]
  readonly requestCount: number
  readonly activeRequests: number
  readonly openedConnections: number
  readonly closedConnections: number
  readonly activeConnections: number
  readonly closed: boolean
  waitFor(
    predicate: (records: readonly StreamableHttpLogRecord[]) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<void>
  waitForIdle(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export interface StreamableHttpFixtureOptions {
  /** Register the A4 static resource and expanded template; S1 defaults to none. */
  readonly resources?: boolean
}

const SECRET_KEY = /(secret|token|password|passwd|api[-_]?key|authorization|credential)/i

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

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.at(0) ?? null
  return value ?? null
}

function rpcIdOf(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function toolNameOf(message: Record<string, unknown>): string | null {
  if (!isRecord(message.params)) return null
  const name = message.params.name
  return typeof name === 'string' ? name : null
}

function cancelledRequestIdOf(message: Record<string, unknown>): string | number | null {
  if (!isRecord(message.params)) return null
  return rpcIdOf(message.params.requestId)
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else if (chunk instanceof Buffer) chunks.push(chunk)
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
    else throw new Error('unexpected request body chunk')
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export async function startStreamableHttpFixture(
  options: StreamableHttpFixtureOptions = {},
): Promise<StreamableHttpFixture> {
  const records: StreamableHttpLogRecord[] = []
  const sockets = new Set<Socket>()
  const enableJsonResponse = true
  const supportedProtocolVersions = [...LEGACY_PROTOCOL_VERSIONS]
  let activeRequests = 0
  let openedConnections = 0
  let closedConnections = 0
  let closed = false
  let port = 0
  let url = ''
  let closing: Promise<void> | undefined

  const writeLog = (record: StreamableHttpLogRecord): void => {
    records.push(record)
  }

  const recordTool = (name: string, args: unknown): void => {
    writeLog({ type: 'tool', pid: process.pid, name, args: redact(args) })
  }

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: SPIKE_INSTRUCTIONS,
      supportedProtocolVersions: [...supportedProtocolVersions],
    },
  )

  mcp.registerTool('echo', {
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

  mcp.registerTool('fail', {
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

  mcp.registerTool('guarded', {
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

  mcp.registerTool('hang', {
    title: 'Hang',
    description: 'Record a tool log entry and wait for host cancellation; exercises host timeout and abort.',
    inputSchema: fromJsonSchema<{ message?: string }>(optionalMessageInputSchema),
  }, ({ message }, ctx) => {
    recordTool('hang', message === undefined ? {} : { message })
    return new Promise<CallToolResult>((resolve) => {
      const abort = (): void => {
        writeLog({ type: 'abort', pid: process.pid, name: 'hang', message: message ?? null })
        resolve({
          content: [{ type: 'text', text: 'fixture hang aborted' }],
          isError: true,
        })
      }
      if (ctx.mcpReq.signal.aborted) {
        abort()
        return
      }
      ctx.mcpReq.signal.addEventListener('abort', abort, { once: true })
    })
  })

  if (options.resources === true) {
    mcp.registerResource(
      'note',
      's4a4://note',
      { title: 'A4 fixture note', mimeType: 'text/plain' },
      uri => ({ contents: [{ uri: uri.href, text: `note:${uri.href}` }] }),
    )
    mcp.registerResource(
      'note-template',
      new ResourceTemplate('s4a4://note/{id}', { list: undefined }),
      { title: 'A4 fixture note template', mimeType: 'text/plain' },
      (uri, variables) => ({
        contents: [{ uri: uri.href, text: `note:${String(variables.id)}` }],
      }),
    )
  }

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse,
    supportedProtocolVersions: [...supportedProtocolVersions],
  })
  await mcp.connect(transport)

  const httpServer = createServer()

  const closeFixture = async (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = (async () => {
      if (closed) return
      closed = true
      try {
        await mcp.close()
      } catch (error) {
        writeLog({
          type: 'error',
          pid: process.pid,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      try {
        await transport.close()
      } catch (error) {
        writeLog({
          type: 'error',
          pid: process.pid,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      const closingServer = new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) {
          resolve()
          return
        }
        httpServer.close(error => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
      if (httpServer.listening) httpServer.closeAllConnections()
      await closingServer
      for (const socket of sockets) socket.destroy()
      writeLog({ type: 'close', pid: process.pid })
    })()
    return closing
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.shouldKeepAlive = false
    res.setHeader('Connection', 'close')
    const path = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname
    const header = headerValue(req.headers[CLIENT_HEADER_NAME])
    const httpMethod = req.method ?? ''

    if (path !== '/mcp') {
      writeLog({
        type: 'request',
        pid: process.pid,
        httpMethod,
        path,
        rpcMethod: null,
        rpcId: null,
        tool: null,
        clientHeader: header,
        cancelledRequestId: null,
      })
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('not found')
      return
    }

    if (httpMethod !== 'POST') {
      writeLog({
        type: 'request',
        pid: process.pid,
        httpMethod,
        path,
        rpcMethod: null,
        rpcId: null,
        tool: null,
        clientHeader: header,
        cancelledRequestId: null,
      })
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('method not allowed')
      return
    }

    const body = await readRequestBody(req)
    const parsed = parseBody(body)
    if (parsed === undefined) {
      writeLog({
        type: 'request',
        pid: process.pid,
        httpMethod,
        path,
        rpcMethod: null,
        rpcId: null,
        tool: null,
        clientHeader: header,
        cancelledRequestId: null,
      })
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      return
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed]
    for (const message of messages) {
      if (!isRecord(message)) {
        writeLog({
          type: 'request',
          pid: process.pid,
          httpMethod,
          path,
          rpcMethod: null,
          rpcId: null,
          tool: null,
          clientHeader: header,
          cancelledRequestId: null,
        })
        continue
      }
      const rpcMethod = typeof message.method === 'string' ? message.method : null
      writeLog({
        type: 'request',
        pid: process.pid,
        httpMethod,
        path,
        rpcMethod,
        rpcId: rpcIdOf(message.id),
        tool: rpcMethod === 'tools/call' ? toolNameOf(message) : null,
        clientHeader: header,
        cancelledRequestId: rpcMethod === 'notifications/cancelled' ? cancelledRequestIdOf(message) : null,
      })
    }

    await transport.handleRequest(req, res, parsed)
  }

  httpServer.on('connection', socket => {
    sockets.add(socket)
    openedConnections += 1
    writeLog({ type: 'connection', pid: process.pid, event: 'open', active: sockets.size })
    socket.once('close', () => {
      sockets.delete(socket)
      closedConnections += 1
      writeLog({ type: 'connection', pid: process.pid, event: 'close', active: sockets.size })
    })
  })

  httpServer.on('request', (req, res) => {
    activeRequests += 1
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      activeRequests -= 1
    }
    res.once('finish', settle)
    res.once('close', settle)
    void handleRequest(req, res).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error))
      writeLog({ type: 'error', pid: process.pid, message: normalized.message })
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('fixture error')
      } else {
        res.destroy(normalized)
      }
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', (error: Error) => { reject(error) })
      httpServer.listen(0, '127.0.0.1', () => { resolve() })
    })
  } catch (error) {
    await closeFixture()
    throw error
  }

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    await closeFixture()
    throw new Error('streamable-http fixture did not expose a TCP address')
  }
  port = address.port
  url = `http://127.0.0.1:${String(port)}/mcp`
  writeLog({ type: 'start', pid: process.pid, port, url })

  const waitFor = async (
    predicate: (records: readonly StreamableHttpLogRecord[]) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate([...records])) return
      await delay(20)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  const waitForIdle = async (timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (activeRequests === 0 && sockets.size === 0) return
      await delay(20)
    }
    throw new Error(`timed out waiting for fixture idle: ${String(activeRequests)} active requests, ${String(sockets.size)} sockets`)
  }

  return {
    get url() { return url },
    get port() { return port },
    enableJsonResponse,
    get supportedProtocolVersions() { return [...supportedProtocolVersions] },
    get records() { return [...records] },
    get requestCount() { return records.filter(record => record.type === 'request').length },
    get activeRequests() { return activeRequests },
    get openedConnections() { return openedConnections },
    get closedConnections() { return closedConnections },
    get activeConnections() { return sockets.size },
    get closed() { return closed },
    waitFor,
    waitForIdle,
    close: closeFixture,
  }
}
