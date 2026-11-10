import { appendFile } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import { ACCOUNT_QUOTA_EXCEEDED_CODE,QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure,TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Fact,Ref,UsageRecord } from '@singularity/protocol'

/** One native outbound call observed by the accounting meter. */
export interface NativeRequestRecord {
  readonly id: number
  readonly sessionId?: string
  readonly purpose: string
  readonly startedAt: number
  readonly settledAt?: number
  readonly reported?: TokenUsage
  readonly failure?: LlmFailure
}

interface MutableNativeRequestRecord {
  id: number
  sessionId?: string
  purpose: string
  startedAt: number
  settledAt?: number
  reported?: TokenUsage
  failure?: LlmFailure
}

/** Observe every native outbound call, including compaction and verification. */
export function nativeAccounting(ctx: Context, options: {
  deadlineAt: number; maxRequests: number; maxReportedTokens: number
  cancellation: AbortController; log: string
}) {
  const usage = { requests: 0, completed: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cacheUnknown: 0, unknown: 0 }
  const history: MutableNativeRequestRecord[] = []
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
    const purpose = request.purpose ?? 'agent'
    const observed: MutableNativeRequestRecord = {
      id, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }), purpose, startedAt,
    }
    history.push(observed)
    let reported: TokenUsage | undefined
    let failure: LlmFailure | undefined
    console.log(JSON.stringify({ event: 'model-request', id, sessionId: request.sessionId, purpose }))
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') reported = chunk.usage
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          failure = chunk.reason.failure
          if (failure.code === QUOTA_EXCEEDED_CODE || failure.code === ACCOUNT_QUOTA_EXCEEDED_CODE) {
            options.cancellation.abort(failure)
          }
        }
        yield chunk
      }
    } finally {
      const finishedAt = Date.now()
      observed.settledAt = finishedAt
      if (reported !== undefined) observed.reported = reported
      if (failure !== undefined) observed.failure = failure
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
      const record = { event: 'model-settled', id, sessionId: request.sessionId, purpose,
        startedAt, finishedAt, reported, ...(failure === undefined ? {} : { failure }), cumulative: { ...usage } }
      await appendFile(options.log, `${JSON.stringify(record)}\n`)
      console.log(JSON.stringify(record))
    }
  })
  return { usage, available, dispose, records: history as readonly NativeRequestRecord[] }
}

/** Cursor over native starts, committed facts and proposer work for one campaign. */
export interface CampaignLedgerMark {
  readonly v: 1
  readonly nativeId: number
  readonly factSeq: number
  readonly proposerCount: number
}

export interface CampaignLedgerTotals {
  readonly usage: UsageRecord
  readonly nativeRequests: number
  readonly nativeCompleted: number
  readonly runCount: number
  readonly cacheComplete: boolean
}

/**
 * Campaign-local cost folded from one mark. Native records are unique by id;
 * a request already in flight at the mark belongs to the earlier period.
 */
export function campaignLedger(
  accounting: { readonly records: readonly NativeRequestRecord[] },
  facts: () => readonly Fact[],
) {
  const proposers: { readonly ref: Ref; readonly steps: number }[] = []
  return {
    mark(): CampaignLedgerMark {
      const nativeId = accounting.records.reduce((max, record) => Math.max(max, record.id), 0)
      const factSeq = facts().reduce((max, fact) => Math.max(max, fact.seq), -1)
      return Object.freeze({ v: 1 as const, nativeId, factSeq, proposerCount: proposers.length })
    },
    recordProposer(ref: Ref, steps: number): void {
      if (!Number.isSafeInteger(steps) || steps < 0) throw new RangeError('Proposer steps must be a non-negative safe integer')
      proposers.push({ ref, steps })
    },
    foldSince(mark: CampaignLedgerMark): CampaignLedgerTotals {
      if (!Number.isSafeInteger(mark.nativeId) || mark.nativeId < 0
        || !Number.isSafeInteger(mark.factSeq) || mark.factSeq < -1
        || !Number.isSafeInteger(mark.proposerCount) || mark.proposerCount < 0
        || mark.proposerCount > proposers.length) throw new RangeError('Campaign ledger mark is invalid')
      let inputTokens = 0
      let outputTokens = 0
      let unknownRequests = 0
      let nativeRequests = 0
      let nativeCompleted = 0
      let cacheComplete = true
      for (const record of accounting.records) {
        if (record.id <= mark.nativeId) continue
        nativeRequests += 1
        if (record.settledAt === undefined || record.reported === undefined) {
          unknownRequests += 1
          cacheComplete = false
          continue
        }
        nativeCompleted += 1
        const { inputTokens: uncached, outputTokens: output, cacheReadTokens, cacheWriteTokens } = record.reported
        if (!Number.isSafeInteger(cacheReadTokens) || !Number.isSafeInteger(cacheWriteTokens)
          || (cacheReadTokens ?? -1) < 0 || (cacheWriteTokens ?? -1) < 0) cacheComplete = false
        const input = uncached + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
        if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 || input + output <= 0) {
          unknownRequests += 1
          continue
        }
        inputTokens += input
        outputTokens += output
      }
      let runCount = 0
      let steps = 0
      for (const fact of facts()) {
        if (fact.seq <= mark.factSeq) continue
        if (fact.type === 'run/opened') runCount += 1
        else if (fact.type === 'run/closed') steps += fact.data.usage.steps + (fact.data.usage.summary?.steps ?? 0)
      }
      for (const proposer of proposers.slice(mark.proposerCount)) steps += proposer.steps
      return {
        usage: { inputTokens, outputTokens, steps, unknownRequests },
        nativeRequests, nativeCompleted, runCount, cacheComplete,
      }
    },
  }
}
