import { appendFile } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Observe every native outbound call, including compaction and verification. */
export function nativeAccounting(ctx: Context, options: {
  deadlineAt: number; maxRequests: number; maxReportedTokens: number
  cancellation: AbortController; log: string
}) {
  const usage = { requests: 0, completed: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cacheUnknown: 0, unknown: 0 }
  const available = () => !options.cancellation.signal.aborted && Date.now() < options.deadlineAt
    && usage.requests < options.maxRequests
    && usage.inputTokens + usage.outputTokens < options.maxReportedTokens
  const dispose = ctx.on('llm/stream', async function* (request, next) {
    if (!available()) {
      options.cancellation.abort('campaign-budget-exhausted')
      throw options.cancellation.signal.reason
    }
    const id = ++usage.requests
    const startedAt = Date.now()
    let reported: TokenUsage | undefined
    console.log(JSON.stringify({ event: 'model-request', id, sessionId: request.sessionId, purpose: request.purpose ?? 'agent' }))
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') reported = chunk.usage
        yield chunk
      }
    } finally {
      const input = reported === undefined ? 0 : reported.inputTokens + (reported.cacheReadTokens ?? 0) + (reported.cacheWriteTokens ?? 0)
      const output = reported?.outputTokens ?? 0
      if (Number.isSafeInteger(reported?.cacheReadTokens) && Number.isSafeInteger(reported?.cacheWriteTokens)
        && (reported?.cacheReadTokens ?? -1) >= 0 && (reported?.cacheWriteTokens ?? -1) >= 0) {
        usage.cacheReadTokens += reported?.cacheReadTokens ?? 0
        usage.cacheWriteTokens += reported?.cacheWriteTokens ?? 0
      } else {
        usage.cacheUnknown += 1
      }
      usage.completed += 1
      if (input + output <= 0) {
        // Unknown usage is observational only. DSH owns transport retry;
        // Singularity does not cancel a Task or reserve a fake token cost.
        usage.unknown += 1
      } else {
        usage.inputTokens += input
        usage.outputTokens += output
      }
      const record = { event: 'model-settled', id, sessionId: request.sessionId, purpose: request.purpose ?? 'agent',
        startedAt, finishedAt: Date.now(), reported, cumulative: { ...usage } }
      await appendFile(options.log, `${JSON.stringify(record)}\n`)
      console.log(JSON.stringify(record))
    }
  })
  return { usage, available, dispose }
}
