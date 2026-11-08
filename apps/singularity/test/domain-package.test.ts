import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { bindDomainTask,loadDomainPackage,runDomainPackage } from '../src/domain.ts'
import { buildDomainEnvironment } from '../src/env-builder.ts'
import { EXPERIMENT_BUDGET } from '../src/experiment.ts'
import { messageTexts,startChatCompletionsFixture,toolNames,toolSchemaNames,wireText } from './fixtures/chat-completions.ts'

const execute = promisify(execFile)

void test('ordinary env-builder session prepares data that a fresh run loads without domain imports', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-domain-builder-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materials = join(directory, 'materials')
  await mkdir(materials)
  await writeFile(join(materials, 'brief.md'), 'Publish each supplied text unchanged as result.txt.\n')
  for (const [id, text] of [['source', 'alpha\n'], ['transfer', 'beta\n'], ['validation', 'gamma\n']] as const) {
    await writeFile(join(materials, `${id}.txt`), text)
  }
  let builderStep = 0, building = true
  const fixture = await startChatCompletionsFixture((request, index) => {
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `domain-builder-${String(index)}`, name, arguments: JSON.stringify(args) }],
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } })
    if (building) {
      assert.deepEqual(toolSchemaNames(request), ['bash'])
      assert.match(messageTexts(request).join('\n'), /not hot-reloaded/)
      if (builderStep++ > 0) {
        building = false
        return { content: 'Prepared the independent data directory.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      }
      const manifest = { v: 1, id: 'text-publication', task: 'task.json', acceptance: 'checks',
        source: { input: 'cases/source.txt' }, cases: [
          { id: 'transfer', description: 'A different frozen text.', inputs: { input: 'cases/transfer.txt' } },
          { id: 'validation', description: 'Independent validation text.', inputs: { input: 'cases/validation.txt' }, validation: true },
        ] }
      const task = { goal: { summary: 'Publish the supplied text unchanged as result.txt.', deliverable: 'result.txt', scope: ['Exact text publication'], constraints: ['Keep the supplied input unchanged.'] },
        criteria: [{ id: 'exact-text', statement: 'The submitted bytes equal the frozen input.', required: true, check: 'cmp input.txt result.txt' }],
        inputs: [{ id: 'input', path: 'input.txt', access: 'copy-to-work' }],
        outputs: [{ id: 'result', path: 'result.txt', kind: 'file', role: 'deliverable', required: true }] }
      return call('bash', { description: 'Prepare frozen public data and root acceptance.', command: `mkdir -p cases\ncp ${join(materials, 'source.txt')} cases/source.txt\ncp ${join(materials, 'transfer.txt')} cases/transfer.txt\ncp ${join(materials, 'validation.txt')} cases/validation.txt\ncat > domain.json <<'EOF'\n${JSON.stringify(manifest, null, 2)}\nEOF\ncat > task.json <<'EOF'\n${JSON.stringify(task, null, 2)}\nEOF\n` })
    }
    assert.equal(toolSchemaNames(request).includes('singularity_review_submit'), false, 'deterministic root checks need no reviewer')
    if (toolSchemaNames(request).includes('rsi_submit_patch')) {
      return { content: 'No reusable change is justified by this loading fixture.', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
    }
    const calls = toolNames(request)
    if (calls.length === 0) return call('singularity_read', { kind: 'self' })
    if (!calls.includes('singularity_plan')) {
      const pages = (request.messages ?? []).filter(value => value.role === 'tool').map(value => wireText(value.content)).filter(value => value.startsWith('{'))
        .map(value => JSON.parse(value) as { data?: string; nextCursor?: string; contextEpoch: string }).filter(value => typeof value.data === 'string')
      const last = pages.at(-1)
      assert.ok(last)
      if (last.nextCursor !== undefined) return call('singularity_read', { kind: 'self', cursor: last.nextCursor })
      JSON.parse(pages.map(value => value.data).join(''))
      return call('singularity_plan', { sketch: { v: 1,
        objective: 'Publish the exact input.', levels: [0, 1].map(level => ({ level, purpose: 'Copy the declared input to the declared output.', likelyChildren: [], expectedInputs: ['input.txt'], expectedOutputs: ['result.txt'] })), directPlan: [], assumptions: [] } })
    }
    if (!calls.includes('bash')) return call('bash', { description: 'Publish the supplied text.', command: 'cp input.txt result.txt' })
    return call('singularity_submit', { outputIds: ['result'], includeLearningDrafts: false })
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
  const prepared = await buildDomainEnvironment(materials, join(directory, 'nested', 'preparation'), { deadlineAt: Date.now() + 60_000, maxRequests: 10, maxReportedTokens: 100_000 })
  const domain = await loadDomainPackage(prepared.domain)
  assert.equal(new TextDecoder().decode(domain.source.input as Uint8Array), 'alpha\n')
  assert.deepEqual(domain.cases.map(value => new TextDecoder().decode(value.input.input as Uint8Array)), ['beta\n', 'gamma\n'])
  assert.equal(domain.acceptance, 'checks')
  await runDomainPackage(join(directory, 'execution'), prepared.domain, { ...EXPERIMENT_BUDGET,
    rounds: 1, maxActive: 1, maxRequests: 100, maxWallClockMs: 60_000, maxReportedTokens: 1_000_000,
    task: { ...EXPERIMENT_BUDGET.task, maxRuns: 1, maxStepsPerRun: 20, maxTokens: 1_000_000 },
    proposerBudget: { maxSteps: 4, maxTokens: 100_000, maxWallClockMs: 60_000 } })
  const result = JSON.parse(await readFile(join(directory, 'execution/result.json'), 'utf8')) as { failure?: string; outcomes: { source: string }[]; usage: { unknown: number } }
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.outcomes.map(value => value.source), ['verified'])
  assert.equal(result.usage.unknown, 0)
})

void test('standalone template has distinct frozen cases and its public acceptance passes and fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-domain-template-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const domain = await loadDomainPackage(fileURLToPath(new URL('../../../domain-tasks/template', import.meta.url)))
  const inputs = [domain.source, ...domain.cases.map(value => value.input)]
  const expected = [
    { rowCount: 5, totals: [{ sku: 'BOLT', quantity: 5 }, { sku: 'NUT', quantity: 7 }, { sku: 'WASHER', quantity: 0 }] },
    { rowCount: 5, totals: [{ sku: 'AXLE', quantity: 8 }, { sku: 'GEAR', quantity: 0 }, { sku: 'PIN', quantity: -2 }] },
    { rowCount: 5, totals: [{ sku: 'A1', quantity: 2 }, { sku: 'M4', quantity: 7 }, { sku: 'Z9', quantity: -2 }] },
  ]
  assert.equal(domain.acceptance, 'checks')
  assert.equal(domain.cases[1]?.validation, true)
  assert.notDeepEqual(domain.source.records, domain.cases[0]?.input.records)
  for (const [index, input] of inputs.entries()) {
    const workspace = join(directory, String(index))
    await mkdir(workspace)
    await writeFile(join(workspace, 'records.csv'), input.records as Uint8Array)
    await writeFile(join(workspace, 'acceptance.py'), input.acceptance as Uint8Array)
    await writeFile(join(workspace, 'report.json'), JSON.stringify(expected[index]))
    await execute('python3', ['acceptance.py'], { cwd: workspace })
    if (index === 0) {
      await writeFile(join(workspace, 'report.json'), JSON.stringify(expected[index]).replace('"quantity":5', '"quantity":5.0'))
      await assert.rejects(execute('python3', ['acceptance.py'], { cwd: workspace }), /integer quantity/)
    }
    await writeFile(join(workspace, 'report.json'), '{"rowCount":0,"totals":[]}')
    await assert.rejects(execute('python3', ['acceptance.py'], { cwd: workspace }), /report mismatch/)
  }
})

void test('domain loader rejects duplicate IDs and check acceptance without a frozen check command', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-domain-boundary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'domain.json'), JSON.stringify({ v: 1, id: 'invalid', task: 'task.json', acceptance: 'checks', source: {}, cases: [
    { id: 'case', description: 'first', inputs: {} }, { id: 'case', description: 'duplicate', inputs: {} },
  ] }))
  await writeFile(join(directory, 'task.json'), JSON.stringify({ goal: { summary: 'x', deliverable: 'x', scope: [], constraints: [] },
    criteria: [{ id: 'required', statement: 'x', required: true }], inputs: [], outputs: [] }))
  await assert.rejects(loadDomainPackage(directory), /requires a check/)
  await writeFile(join(directory, 'task.json'), JSON.stringify({ goal: { summary: 'x', deliverable: 'x', scope: [], constraints: [] },
    criteria: [{ id: 'required', statement: 'x', required: true, check: 'true' }], inputs: [], outputs: [] }))
  await assert.rejects(loadDomainPackage(directory), /duplicate case/)
})

void test('performance domains require a frozen metric check in source and every transfer case', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-performance-domain-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const metric = { criterion: 'performance', name: 'speedup', unit: 'ratio' }
  const draft = { goal: { summary: 'Optimize a correct implementation.', deliverable: 'result', scope: [], constraints: [] },
    criteria: [{ id: 'performance', statement: 'Measure the correct result.', required: true, check: 'python3 measure.py', checkOutput: 'metric-json' }], inputs: [], outputs: [] }
  await writeFile(join(directory, 'domain.json'), JSON.stringify({ v: 1, id: 'performance', task: 'task.json', acceptance: 'checks', metric,
    source: {}, cases: [{ id: 'transfer', description: 'Transfer.', inputs: {}, task: 'transfer.json' }] }))
  await writeFile(join(directory, 'task.json'), JSON.stringify(draft))
  await writeFile(join(directory, 'transfer.json'), JSON.stringify(draft))
  const domain = await loadDomainPackage(directory)
  assert.deepEqual(domain.metric, metric)
  assert.equal(domain.cases[0]?.task.criteria[0]?.checkOutput, 'metric-json')
  await writeFile(join(directory, 'transfer.json'), JSON.stringify({ ...draft,
    criteria: [{ ...draft.criteria[0], checkOutput: undefined }] }))
  await assert.rejects(loadDomainPackage(directory), /required metric-json check/)
  await writeFile(join(directory, 'task.json'), JSON.stringify({ ...draft,
    criteria: [{ ...draft.criteria[0], check: undefined }] }))
  await assert.rejects(loadDomainPackage(directory), /check/)
})

void test('MXMM numeric reference accepts exact values and rejects wrong values; command-only consumer fails final acceptance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-buckyball-consumer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const domain = await loadDomainPackage(fileURLToPath(new URL('../../../domain-tasks/buckyball', import.meta.url)))
  assert.equal(domain.acceptance, 'checks')
  const project = JSON.parse(new TextDecoder().decode(domain.source.project as Uint8Array)) as {
    case: { shapes: [number, number, number][] }
  }
  project.case.shapes = [[16, 16, 32]]
  await mkdir(join(directory, 'ball'))
  await writeFile(join(directory, 'project.json'), JSON.stringify(project))
  await writeFile(join(directory, 'acceptance.py'), domain.source.acceptance as Uint8Array)
  await writeFile(join(directory, 'bemu.py'), domain.source['bemu-tools'] as Uint8Array)
  await writeFile(join(directory, 'ball/mxmm.py'), `import json, runpy, struct, sys
sys.path.insert(0, '.')
contract = runpy.run_path('acceptance.py')
request = json.load(open(sys.argv[1]))
results = []
for call in request['calls']:
    decoded = contract['decode_bytes'](call)
    values = []
    for row in range(call['m']):
        for column in range(call['n']):
            exact, _magnitude, exponent = contract['exact_cell'](call, decoded, row, column)
            values.append(struct.unpack('<f', struct.pack('<I', contract['rne32'](exact, exponent)))[0])
    command = {'name': call['id'], 'argv': ['bbdev', 'bebop-bemu', '--sim', '--chip', 'poly', '--core-index', '2', '--binary', 'fixture'], 'cwd': '.', 'exit': 0, 'stdout': '', 'stderr': ''}
    results.append({'id': call['id'], 'c': values, 'guard': call['guard'], 'command': command})
regressions = [{'name': name, 'argv': ['bbdev', 'bebop-bemu', '--sim', '--chip', 'poly', '--core-index', '2', '--binary', name], 'cwd': '.', 'exit': 0, 'stdout': '', 'stderr': ''} for name in contract['REGRESSIONS']]
json.dump({'v': 1, 'calls': results, 'regressions': regressions}, open(sys.argv[2], 'w'))
`)
  const numericOnly = `import json, runpy, subprocess, sys
c = runpy.run_path('acceptance.py')
p = json.load(open('project.json')); r = c['build_request'](p)
json.dump(r, open('request.json', 'w'))
subprocess.run([sys.executable, 'ball/mxmm.py', 'request.json', 'response.json'], check=True)
c['verify_response'](p, r, json.load(open('response.json')))
`
  await execute('python3', ['-c', numericOnly], { cwd: directory })
  await assert.rejects(execute('python3', ['acceptance.py'], { cwd: directory }), /bemu/)
  const source = await readFile(join(directory, 'ball/mxmm.py'), 'utf8')
  await writeFile(join(directory, 'ball/mxmm.py'), source.replace('values.append(struct.unpack', 'values.append(1e30 if row == 0 and column == 0 else struct.unpack'))
  await assert.rejects(execute('python3', ['-c', numericOnly], { cwd: directory }))
})

void test('transfer cases keep distinct TaskSpecs and execute SMatMul and inventory acceptance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singularity-transfer-consumers-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const domain = await loadDomainPackage(fileURLToPath(new URL('../../../domain-tasks/buckyball', import.meta.url)))
  const smatmul = domain.cases.find(value => value.id === 'smatmul-bias')
  const inventory = domain.cases.find(value => value.id === 'inventory-transfer')
  assert.ok(smatmul && inventory)
  assert.equal(smatmul.acceptance, 'checks')
  assert.equal(inventory.acceptance, 'checks')
  assert.equal(inventory.validation, true)
  const refs = (input: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.keys(input).map(id => [id, { id, digest: `sha256:${'0'.repeat(64)}` }]))
  const smatmulSpec = bindDomainTask(smatmul.task, refs(smatmul.input))
  const inventorySpec = bindDomainTask(inventory.task, refs(inventory.input))
  assert.notEqual(smatmulSpec.goal.summary, inventorySpec.goal.summary)
  assert.notEqual(smatmulSpec.criteria[0]?.id, inventorySpec.criteria[0]?.id)

  const smatmulRoot = join(directory, 'smatmul')
  await mkdir(join(smatmulRoot, 'ball'), { recursive: true })
  await writeFile(join(smatmulRoot, 'project.json'), smatmul.input.project as Uint8Array)
  await writeFile(join(smatmulRoot, 'acceptance.py'), smatmul.input.acceptance as Uint8Array)
  await writeFile(join(smatmulRoot, 'bemu.py'), smatmul.input['bemu-tools'] as Uint8Array)
  const runner = `import json, runpy, sys
sys.path.insert(0, '.')
contract = runpy.run_path('acceptance.py')
request = json.load(open(sys.argv[1]))
expected = contract['expected'](request)
command = {'name': 'smatmul-bias', 'argv': ['bbdev', 'bebop-bemu', '--sim', '--chip', 'pebble', '--core-index', '0', '--binary', 'smatmul-fixture'], 'cwd': '.', 'exit': 0, 'stdout': '', 'stderr': ''}
regressions = [{'name': name, 'argv': ['bbdev', 'bebop-bemu', '--sim', '--chip', 'pebble', '--core-index', '0', '--binary', name], 'cwd': '.', 'exit': 0, 'stdout': '', 'stderr': ''} for name in contract['REGRESSIONS']]
json.dump({'v': 1, 'c': expected, 'guard': request['guard'], 'command': command, 'regressions': regressions}, open(sys.argv[2], 'w'))
`
  await writeFile(join(smatmulRoot, 'ball/smatmul.py'), runner)
  const numericOnly = `import json, runpy, subprocess, sys
c = runpy.run_path('acceptance.py'); r = c['build_request'](json.load(open('project.json')))
json.dump(r, open('request.json', 'w'))
subprocess.run([sys.executable, 'ball/smatmul.py', 'request.json', 'response.json'], check=True)
c['verify_response'](r, json.load(open('response.json')))
`
  await execute('python3', ['-c', numericOnly], { cwd: smatmulRoot })
  await assert.rejects(execute('python3', ['acceptance.py'], { cwd: smatmulRoot }), /bemu/)
  await writeFile(join(smatmulRoot, 'ball/smatmul.py'), runner.replace("'c': expected", "'c': [expected[0] + 1] + expected[1:]"))
  await assert.rejects(execute('python3', ['-c', numericOnly], { cwd: smatmulRoot }))

  const inventoryRoot = join(directory, 'inventory')
  await mkdir(inventoryRoot)
  await writeFile(join(inventoryRoot, 'records.csv'), inventory.input.records as Uint8Array)
  await writeFile(join(inventoryRoot, 'acceptance.py'), inventory.input.acceptance as Uint8Array)
  const report = { rowCount: 7, totals: [
    { sku: 'BOLT', quantity: -2 }, { sku: 'GADGET', quantity: 6 },
    { sku: 'NUT', quantity: 7 }, { sku: 'WIDGET', quantity: 0 },
  ] }
  await writeFile(join(inventoryRoot, 'report.json'), JSON.stringify(report))
  await execute('python3', ['acceptance.py'], { cwd: inventoryRoot })
  await writeFile(join(inventoryRoot, 'report.json'), JSON.stringify({ rowCount: 0, totals: [] }))
  await assert.rejects(execute('python3', ['acceptance.py'], { cwd: inventoryRoot }), /report mismatch/)
})
