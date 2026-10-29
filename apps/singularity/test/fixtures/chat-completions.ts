import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedChatRequest {
  readonly model?: unknown
  readonly messages?: unknown
  readonly tools?: unknown
  readonly reasoning_effort?: unknown
  readonly [key: string]: unknown
}

export interface ChatCompletionsFixture {
  readonly baseURL: string
  readonly requests: readonly CapturedChatRequest[]
  close(): Promise<void>
}

function chunk(model: string, delta: object, finishReason: string | null = null) {
  return `${JSON.stringify({
    id: 'chatcmpl-singularity-spike',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

export async function startChatCompletionsFixture(): Promise<ChatCompletionsFixture> {
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
      const parsed = JSON.parse(body) as CapturedChatRequest
      requests.push(parsed)
      const model = typeof parsed.model === 'string' ? parsed.model : 'deepseek-v4.1-flash'
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      if (requests.length === 1) {
        response.write(`data: ${chunk(model, {
          role: 'assistant',
          content: null,
          tool_calls: [{
            index: 0,
            id: 'call-spike-finish',
            type: 'function',
            function: { name: 'spike_finish', arguments: '' },
          }],
        })}`)
        response.write(`data: ${chunk(model, {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"message":"fixture-complete"}' },
          }],
        })}`)
        response.write(`data: ${chunk(model, {}, 'tool_calls')}`)
      } else {
        response.write(`data: ${chunk(model, { role: 'assistant', content: 'unexpected second request' }, 'stop')}`)
      }
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-singularity-spike',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 17,
          total_tokens: 140,
          prompt_cache_hit_tokens: 20,
          prompt_cache_miss_tokens: 103,
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve() })
      })
    },
  }
}
