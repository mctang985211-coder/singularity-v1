import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'

import { campaignLedger,nativeAccounting } from '../src/accounting.ts'
import { bootSpikeProfile } from '../src/host-composition.ts'

void test('native provider balance failure cancels the campaign and prevents another purchase', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-quota-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    request.resume()
    response.writeHead(402, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: { code: 'insufficient_quota', message: 'Insufficient balance: no credits remaining.' },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, 'close') })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const spike = await bootSpikeProfile({ home: join(root, 'dsh'), apiKey: 'fixture-key', baseURL: `http://127.0.0.1:${String(address.port)}/v1` })
  t.after(() => spike.dispose())
  const cancellation = new AbortController()
  const log = join(root, 'requests.jsonl')
  const meter = nativeAccounting(spike.ctx, { cancellation, log, deadlineAt: Date.now() + 60_000, maxRequests: 100, maxReportedTokens: 1_000_000 })
  t.after(meter.dispose)
  const ledger = campaignLedger(meter, () => [])
  const mark = ledger.mark()
  const call = { provider: 'singularity-local', model: 'deepseek-v4.1-flash', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Fixture.' }] }] }
  for await (const chunk of spike.ctx.llm.stream(call)) assert.ok(chunk.type)
  assert.equal(requests, 1)
  assert.equal(cancellation.signal.aborted, true)
  assert.equal((cancellation.signal.reason as { code: string }).code, QUOTA_EXCEEDED_CODE)
  assert.equal(meter.available(), false)
  await assert.rejects(async () => {
    for await (const chunk of spike.ctx.llm.stream(call)) assert.ok(chunk.type)
  }, error => error === cancellation.signal.reason)
  assert.equal(requests, 1, 'no second HTTP request reaches the provider')
  assert.equal(meter.usage.requests, 1)
  assert.equal(meter.records.length, 1)
  const observed = meter.records[0]
  assert.equal(observed.id, 1)
  assert.equal(observed.purpose, 'agent')
  assert.ok(observed.startedAt <= (observed.settledAt ?? 0))
  assert.equal(observed.failure?.code, QUOTA_EXCEEDED_CODE)
  const reportedUsage = observed.reported
  assert.ok(reportedUsage !== undefined)
  assert.equal(reportedUsage.inputTokens, 0)
  assert.equal(reportedUsage.outputTokens, 0)
  assert.deepEqual(ledger.foldSince(mark), {
    usage: { inputTokens: 0, outputTokens: 0, steps: 0, unknownRequests: 1 },
    nativeRequests: 1, nativeCompleted: 1, runCount: 0, cacheComplete: false,
  })
  const row = JSON.parse((await readFile(log, 'utf8')).trim()) as { failure: { code: string; message: string } }
  assert.equal(row.failure.code, QUOTA_EXCEEDED_CODE)
  assert.match(row.failure.message, /Insufficient balance/)
})
