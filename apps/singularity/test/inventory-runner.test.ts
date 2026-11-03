import assert from 'node:assert/strict'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Ref } from '@singularity/protocol'
import { DomainStore } from '@singularity/runtime'

import { runInventoryValidation } from '../examples/inventory-validation.ts'
import { messageTexts,startChatCompletionsFixture,toolNames,toolSchemaNames,wireText } from './fixtures/chat-completions.ts'

void test('example runs empty Method, evolves native skill/MCP bindings, evaluates, activates and consumes the next head', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'inventory-workflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let provider: Ref | undefined
  let mcpSource = await readFile(new URL('../examples/inventory-mcp.ts', import.meta.url), 'utf8')
  for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio', '@singularity/domain-inventory']) {
    mcpSource = mcpSource.replace(`'${name}'`, JSON.stringify(import.meta.resolve(name)))
  }
  mcpSource = mcpSource.replace("name: 'inventory'", "name: 'inventory_bound'")
  const fixture = await startChatCompletionsFixture((request, index) => {
    const texts = messageTexts(request).join('\n')
    const calls = toolNames(request)
    const compact = texts.includes('"ownTemplate":{"id":"inventory-compact-entry"')
    const tokens = compact ? 1000 : 10000
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `workflow-${String(index)}`, name, arguments: JSON.stringify(args) }],
      usage: { promptTokens: tokens, completionTokens: 10, totalTokens: tokens + 10 } })
    if (toolSchemaNames(request).includes('rsi_submit_patch')) {
      if (calls.length === 0) return call('rsi_read', { kind: 'method' })
      const baseText = /"baseMethod":(\{"digest":"[^"]+","id":"[^"]+"\})/.exec(texts)?.[1]
      assert.ok(baseText)
      assert.ok(provider)
      return call('rsi_submit_patch', { patch: { v: 1, base: JSON.parse(baseText) as Ref,
        hypothesis: 'Replace repeated exploratory reads with one reusable direct calculation.', predictedRisks: [], transferPlan: 'All signed CSV cases.',
        changes: [{ op: 'put-template', template: { id: 'inventory-compact-entry', brief: 'Compute and check the declared inventory report.',
          guidance: `Read self, plan, calculate the signed totals and row count from every declared CSV, write report.json and submit.${texts.includes('"roundId":"inventory:round:2"') ? ' Check zero totals before submission.' : ''}`,
          example: { goal: { summary: 'Reconcile a CSV.', deliverable: 'report.json', scope: [], constraints: [] },
            inputs: [{ id: 'transactions', exampleText: 'sku,delta\nA,1\n' }], acceptanceCriteria: [], localOutputs: [] },
          instanceSchema: {}, requiredCriteria: [{ id: 'inventory-exact', statement: 'Exact signed inventory totals.', required: true }],
          requiredOutputs: [{ id: 'report', path: 'report.json', kind: 'file', role: 'deliverable', required: true }],
          acceptancePolicy: provider, children: [], skills: ['inventory-review'], tools: ['inventory-bound-mcp'] } },
          { op: 'put-skill', skill: { id: 'inventory-review', name: 'inventory-review', description: 'Review exact inventory reports.',
            files: { 'SKILL.md': '# Inventory review\n\nCheck the row count and signed, sorted SKU totals before submitting report.json.' } } },
          { op: 'put-mcp-server', server: { id: 'inventory-bound-mcp', name: 'inventory_bound', kind: 'mcp-server', description: 'Bound inventory arithmetic.',
            server: { files: { 'server.ts': mcpSource }, transport: 'stdio', capabilities: ['public-inventory-arithmetic'],
              manifest: { serverName: 'inventory_bound', transport: 'stdio', instructions: 'Reconcile public signed inventory CSVs. Pass CSV contents, not filesystem paths. Write the returned report in your own workspace.',
                entrypoint: 'server.ts', limits: { maxBundleBytes: 1024 * 1024 } },
              config: { transport: 'stdio', command: process.execPath, args: ['server.ts'], env: {}, toolCallTimeoutMs: 30_000, maxInstructionBytes: 8192 },
              exposedTools: [{ name: 'reconcile', description: 'Sum signed inventory transactions across supplied CSVs, retaining zero and negative totals and ascending SKU order.',
                parameters: { type: 'object', additionalProperties: false, properties: { csvs: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['csvs'] } }] } } },
          { op: 'set-entry', templateId: 'inventory-compact-entry' }] } })
    }
    if (calls.length === 0) return call('singularity_read', { kind: 'self' })
    const selfText = (request.messages ?? []).filter(message => message.role === 'tool').map(message => wireText(message.content))
      .find(text => text.includes('"contractDigest"'))
    assert.ok(selfText)
    const { data } = JSON.parse(selfText) as { data: { taskId: string; runId: string; contractDigest: string; contextEpoch: string; acceptance: { provider: Ref } } }
    provider = data.acceptance.provider
    if (calls.length === 1) return call('singularity_plan', { sketch: { v: 1, taskId: data.taskId, runId: data.runId,
      sourceContract: data.contractDigest, contextEpoch: data.contextEpoch, objective: 'Produce the exact report.',
      levels: [0, 1].map(level => ({ level, purpose: 'Compute this report.', likelyChildren: [], expectedInputs: [], expectedOutputs: [] })),
      directPlan: [], assumptions: [] } })
    if (calls.length === 2) return call('skill', { name: compact ? 'inventory-review' : 'inventory-reconciliation' })
    if (calls.length === 3) return call(compact ? 'mcp__inventory_bound__reconcile' : 'mcp__inventory__reconcile', { csvs: ['sku,delta\nA,1\nA,-1\nB,-2\n'] })
    if (calls.length === 4) {
      assert.match(texts, /"quantity":-2/)
      if (compact) assert.ok(texts.includes('# Inventory review'))
      return call('bash', { command: `python3 - <<'PY'\nimport csv,json,glob\nrows=[r for p in sorted(glob.glob('*.csv')) for r in csv.DictReader(open(p))]\ntotals={}\nfor r in rows: totals[r['sku']]=totals.get(r['sku'],0)+int(r['delta'])\njson.dump({'rowCount':len(rows),'totals':[{'sku':s,'quantity':q} for s,q in sorted(totals.items())]},open('report.json','w'))\nPY` })
    }
    return call('singularity_submit', { outputIds: ['report'], includeLearningDrafts: false })
  })
  t.after(() => fixture.close())
  const previousUrl = process.env.SINGULARITY_SPIKE_BASE_URL, previousKey = process.env.SINGULARITY_SPIKE_API_KEY
  process.env.SINGULARITY_SPIKE_BASE_URL = fixture.baseURL
  process.env.SINGULARITY_SPIKE_API_KEY = 'fixture-key'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SINGULARITY_SPIKE_BASE_URL
    else process.env.SINGULARITY_SPIKE_BASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SINGULARITY_SPIKE_API_KEY
    else process.env.SINGULARITY_SPIKE_API_KEY = previousKey
  })
  const output = join(root, 'execution')
  await runInventoryValidation(output, 2, undefined, { initialMethod: 'empty', publicResources: true, activateWinners: true,
    objective: 'reported-tokens', maxActive: 1, task: { maxRuns: 1 }, deadlineAt: Date.now() + 100_000 })
  const first = JSON.parse(await readFile(join(output, 'round-1.json'), 'utf8')) as {
    baseMethod: Ref; activation: unknown; activeMethod: Ref; evaluation: { comparison: { outcome: string; complete: boolean } }
  }
  const second = JSON.parse(await readFile(join(output, 'round-2.json'), 'utf8')) as typeof first
  assert.ok(first.evaluation, JSON.stringify(first))
  assert.equal(first.evaluation.comparison.outcome, 'improved')
  assert.equal(first.evaluation.comparison.complete, true)
  assert.ok(first.activation)
  assert.notEqual(first.activeMethod.digest, first.baseMethod.digest)
  assert.deepEqual(second.baseMethod, first.activeMethod)
  assert.ok(second.evaluation, JSON.stringify(second))
  assert.equal(second.evaluation.comparison.outcome, 'no-improvement')
  assert.equal(second.activation, undefined)
  const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8')) as {
    publishedWork: { method: Ref; classification: string; evidenceRef: Ref }
  }
  assert.deepEqual(result.publishedWork.method, first.activeMethod)
  assert.equal(result.publishedWork.classification, 'verified')
  assert.ok(result.publishedWork.evidenceRef)
  const archive = await DomainStore.open(join(output, 'domain'))
  try {
    const facts = await archive.replay()
    assert.equal(facts.filter(fact => fact.type === 'method/activated').length, 2)
    assert.equal(facts.filter(fact => fact.type === 'rsi/round-closed').length, 2)
  } finally { await archive.close() }
})
