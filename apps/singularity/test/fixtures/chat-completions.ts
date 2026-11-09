import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One model response the fixture emits for a captured request. */
export interface FixtureReply {
  readonly reasoning?: string
  readonly content?: string
  readonly toolCalls?: readonly FixtureToolCall[]
  readonly usage?: FixtureUsage
  readonly finishReason?: 'stop' | 'tool_calls' | 'length'
  /** Never answer; the request stays pending until the test tears the fixture down. */
  readonly hang?: true
  /** Answer with an HTTP error instead of an SSE stream. */
  readonly httpError?: true
}

export interface FixtureToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** OpenAI chat-completions usage counters the adapter maps onto DSH token usage. */
export interface FixtureUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly cachedTokens?: number
  readonly reasoningTokens?: number
}

export interface WireContentPart {
  readonly type?: string
  readonly text?: string
}

export interface WireChatMessage {
  readonly role?: string
  readonly content?: string | readonly WireContentPart[] | null
  readonly tool_calls?: readonly {
    readonly function?: {
      readonly name?: string
      readonly arguments?: string
    }
  }[]
}

export interface WireToolFunction {
  readonly name?: string
  readonly parameters?: unknown
}

export interface WireTool {
  readonly type?: string
  readonly function?: WireToolFunction
}

/** Parsed request body captured for assertions about the actual model request. */
export interface CapturedChatRequest {
  readonly model?: unknown
  readonly messages?: readonly WireChatMessage[]
  readonly tools?: readonly WireTool[]
  readonly reasoning_effort?: unknown
  readonly stream?: unknown
  readonly stream_options?: unknown
  readonly [key: string]: unknown
}

/** Text content of one captured message, whether string or content parts. */
export function wireText(content: WireChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return content.map(part => part.text ?? '').join('')
}

/** All non-empty message text and tool-call argument text in a captured request. */
export function messageTexts(request: CapturedChatRequest): string[] {
  const texts: string[] = []
  for (const message of request.messages ?? []) {
    const text = wireText(message.content)
    if (text.length > 0) texts.push(text)
    for (const call of message.tool_calls ?? []) {
      if (call.function?.arguments !== undefined) texts.push(call.function.arguments)
    }
  }
  return texts
}

/** Names of tools the model actually called in a captured request. */
export function toolNames(request: CapturedChatRequest): string[] {
  const names: string[] = []
  for (const message of request.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      if (call.function?.name !== undefined) names.push(call.function.name)
    }
  }
  return names
}

/** Names of tool schemas declared to the model in a captured request. */
export function toolSchemaNames(request: CapturedChatRequest): string[] {
  return (request.tools ?? [])
    .map(tool => tool.function?.name)
    .filter((name): name is string => name !== undefined)
}

/**
 * Extract the runtime-owned context epoch from a prior tool result. Tests never
 * guess this value: they only forward what the runtime already delivered.
 */
export function contextEpochFrom(request: CapturedChatRequest): string | undefined {
  for (const text of messageTexts(request)) {
    const patterns = [
      /"contextEpoch"\s*:\s*"([^"]+)"/,
      /\\"contextEpoch\\"\s*:\s*\\"([^"\\]+)\\"/,
      /contextEpoch\s*[:=]\s*"([^"]+)"/,
      /contextEpoch[^A-Za-z0-9]{0,4}([A-Za-z0-9][A-Za-z0-9:_-]{7,})/,
    ]
    for (const pattern of patterns) {
      const match = pattern.exec(text)
      if (match?.[1] !== undefined) return match[1]
    }
  }
  return undefined
}

export interface ChatCompletionsFixture {
  readonly baseURL: string
  readonly requests: readonly CapturedChatRequest[]
  close(): Promise<void>
}

const DEFAULT_MODEL = 'deepseek-v4.1-flash'
const COMPLETION_ID_PREFIX = 'chatcmpl-singularity-spike'
const CREATED_AT = 1

interface ChunkChoiceDelta {
  readonly role?: 'assistant'
  readonly content?: string | null
  readonly reasoning_content?: string
  readonly tool_calls?: readonly {
    readonly index: number
    readonly id: string
    readonly type: 'function'
    readonly function: {
      readonly name: string
      readonly arguments: string
    }
  }[]
}

function chunk(id: string, model: string, delta: ChunkChoiceDelta, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: CREATED_AT,
    model,
    system_fingerprint: 'fp_singularity_spike',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function usageChunk(id: string, model: string, usage: FixtureUsage): string {
  const promptDetails = usage.cachedTokens === undefined
    ? {}
    : { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }
  const completionDetails = usage.reasoningTokens === undefined
    ? {}
    : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: CREATED_AT,
    model,
    system_fingerprint: 'fp_singularity_spike',
    choices: [],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...promptDetails,
      ...completionDetails,
    },
  })}\n\n`
}

/** Render one scripted reply as an openai-completions SSE stream. */
function replyChunks(id: string, model: string, reply: FixtureReply): string[] {
  const chunks: string[] = []
  const toolCalls = reply.toolCalls ?? []
  const first: ChunkChoiceDelta = {
    role: 'assistant',
    ...reply.reasoning === undefined ? {} : { reasoning_content: reply.reasoning },
    ...reply.content === undefined ? {} : { content: reply.content },
    ...reply.content === undefined && toolCalls.length === 0 && reply.reasoning === undefined
      ? { content: '' }
      : {},
  }
  chunks.push(chunk(id, model, first))
  if (toolCalls.length > 0) {
    chunks.push(chunk(id, model, {
      tool_calls: toolCalls.map((toolCall, index) => ({
        index,
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: toolCall.arguments },
      })),
    }))
    chunks.push(chunk(id, model, {}, reply.finishReason ?? 'tool_calls'))
  } else {
    chunks.push(chunk(id, model, {}, reply.finishReason ?? 'stop'))
  }
  if (reply.usage !== undefined) chunks.push(usageChunk(id, model, reply.usage))
  return chunks
}

/**
 * Chooses the reply for one captured request. The request index is the number
 * of requests already captured, so a script can react to actual wire content.
 */
export type ChatCompletionReplyScript = (
  request: CapturedChatRequest,
  index: number,
) => FixtureReply

/**
 * Local openai-completions endpoint. Replies are either scripted per request
 * index or selected by a dynamic script; every parsed request is retained so
 * tests can assert the actual wire request.
 */
export async function startChatCompletionsFixture(
  replies: readonly FixtureReply[] | ChatCompletionReplyScript,
): Promise<ChatCompletionsFixture> {
  const replyFor: ChatCompletionReplyScript = typeof replies === 'function'
    ? replies
    : (_request, index) => replies[index] ?? { content: `unexpected request ${String(index + 1)}` }
  const requests: CapturedChatRequest[] = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (part: string) => { body += part })
    request.on('end', () => {
      let parsed: CapturedChatRequest
      try {
        parsed = JSON.parse(body) as CapturedChatRequest
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid JSON"}')
        return
      }
      const index = requests.length
      requests.push(parsed)
      const reply = replyFor(parsed, index)
      if (reply.httpError) {
        response.writeHead(500).end('{"error":{"message":"fixture failure"}}')
        return
      }
      if (reply.hang) {
        const timer = setTimeout(() => { response.destroy() }, 4000)
        response.once('close', () => { clearTimeout(timer) })
        return
      }
      const model = typeof parsed.model === 'string' ? parsed.model : DEFAULT_MODEL
      const id = `${COMPLETION_ID_PREFIX}-${String(index + 1)}`
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const data of replyChunks(id, model, reply)) response.write(data)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve() })
      })
    },
  }
}
