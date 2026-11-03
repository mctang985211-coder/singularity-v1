import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateInstanceSchema } from '@singularity/protocol'

import { BUCKYBALL_CASES,BUCKYBALL_CHECK_KINDS,BUCKYBALL_RECIPE,BUCKYBALL_STAGES,checkBuckyballEvidence } from '../examples/buckyball-checks.ts'
import type { BuckyballStage } from '../examples/buckyball-checks.ts'
import { writeBuckyballEvidence } from './fixtures/buckyball-evidence.ts'

const stageCases = (stage: BuckyballStage) => BUCKYBALL_CASES.filter(item => item.input.stage === stage)

async function replaceJson(root: string, identity: { path: string; digest: string }, value: unknown) {
  await replaceText(root, identity, JSON.stringify(value))
}
async function replaceText(root: string, identity: { path: string; digest: string }, text: string) {
  await writeFile(join(root, identity.path), text)
  identity.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`
}

void test('finite Buckyball checks compute fixed-suite program errors, native integration identities and workload PPA', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeBuckyballEvidence(root)
  for (const kind of BUCKYBALL_CHECK_KINDS) {
    const result = await checkBuckyballEvidence(root, kind, 'evidence.json', join(root, 'project.json'), undefined,
      kind === 'numerical' || kind === 'host-reference' ? 'campplus' : undefined)
    assert.deepEqual(result.failures, [], `${kind}: ${JSON.stringify(result)}`)
    assert.ok(Number(result.checksRun) > 0)
    assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, result).valid, true)
  }
  for (const stage of BUCKYBALL_STAGES) {
    const result = await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, stage)
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.metrics, { casesRequired: stageCases(stage).length, casesRun: stageCases(stage).length,
      stages: 1, valuesCompared: 4 * stageCases(stage).length, mismatches: 0, maxAbsError: 0 })
    assert.deepEqual((result.cases as { caseId: string }[]).map(item => item.caseId), stageCases(stage).map(item => item.id))
  }
})

void test('numerical executes every frozen input and retains a failing final case', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-suite-execution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidence = await writeBuckyballEvidence(root)
  assert.ok(evidence.numerical)
  const cases = stageCases('campplus')
  await replaceText(root, evidence.numerical.entrypoint, `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.argv.length !== 4 || !fs.existsSync(process.argv[3])) throw new Error('project argv missing');
fs.appendFileSync('executed.jsonl', JSON.stringify(input) + '\\n');
console.log(JSON.stringify(JSON.stringify(input) === ${JSON.stringify(JSON.stringify(cases.at(-1)?.input))} ? [0,1,8,3] : [0,1,2,3]));`)
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
  const result = await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, 'campplus')
  assert.deepEqual((await readFile(join(root, 'executed.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown), cases.map(item => item.input))
  assert.equal((result.metrics as { casesRun: number }).casesRun, cases.length)
  assert.equal((result.cases as unknown[]).length, cases.length)
  assert.ok((result.failures as string[]).some(failure => failure.includes(cases.at(-1)?.id ?? 'missing-case')))
  assert.equal((result.metrics as { mismatches: number }).mismatches, 1)
})

for (const negative of ['FP32-only', 'unused-ball', 'source-config-mismatch', 'boundary-mismatch', 'wrong-values'] as const) {
  void test(`Buckyball checker rejects ${negative} even with a claimed PASS`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bb-evidence-bad-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const evidence = await writeBuckyballEvidence(root)
    let kind: 'numerical' | 'ppa' = 'ppa'
    assert.ok(evidence.numerical); assert.ok(evidence.ppa)
    if (negative === 'FP32-only') { evidence.numerical.precision = 'FP32'; kind = 'numerical' }
    if (negative === 'unused-ball') evidence.ppa.design.activeInstances = ['UnusedBall']
    if (negative === 'source-config-mismatch') evidence.ppa.design.config = evidence.design.source
    if (negative === 'boundary-mismatch') evidence.ppa.boundary.interface = 'component only'
    if (negative === 'wrong-values') { await writeFile(join(root, 'actual.json'), '[0,0,0,0]'); kind = 'numerical' }
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ ...evidence, verdict: 'PASS' }))
    const result = await checkBuckyballEvidence(root, kind, 'evidence.json', join(root, 'project.json'), undefined, kind === 'numerical' ? 'campplus' : undefined)
    assert.ok((result.failures as unknown[]).length > 0)
    assert.ok((await readFile(join(root, 'evidence.json'), 'utf8')).includes('PASS'))
  })
}

void test('host-reference checks every fixed native vector without compiler or RTL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-host-reference-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { design, hostReference } = await writeBuckyballEvidence(root)
  assert.ok(hostReference)
  await replaceJson(root, hostReference.cases[0].actual, [0.000009, 1.00009, 2, 3])
  await writeFile(join(root, 'host.json'), JSON.stringify({ design, hostReference }))
  await rm(join(root, 'mockbaseline'), { recursive: true })
  const result = await checkBuckyballEvidence(root, 'host-reference', 'host.json', join(root, 'project.json'), undefined, 'campplus')
  assert.deepEqual(result.failures, [])
  assert.deepEqual({ ...(result.metrics as object), maxAbsError: 0 }, { casesRequired: stageCases('campplus').length,
    casesRun: stageCases('campplus').length, stages: 1, valuesCompared: 4 * stageCases('campplus').length, mismatches: 0, maxAbsError: 0 })
  assert.equal('ppa' in result, false)
  const integer = await checkBuckyballEvidence(root, 'host-reference', 'host.json', join(root, 'project.json'), undefined, 'tokenizer.codes')
  assert.ok((integer.failures as string[]).some(failure => failure.includes('integer reference comparison')))
})

for (const negative of ['wrong-values', 'short-array', 'wrong-source-config', 'missing-case', 'duplicate-case', 'fractional-integers', 'unsafe-integers'] as const) {
  void test(`host-reference rejects ${negative} with coherent file hashes`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bb-host-reference-bad-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const { design, hostReference } = await writeBuckyballEvidence(root)
    assert.ok(hostReference)
    const stage = negative.includes('integers') ? 'tokenizer.codes' : 'campplus'
    hostReference.cases = hostReference.cases.filter(item => stageCases(stage).some(value => value.id === item.caseId))
    if (negative === 'wrong-values') await replaceJson(root, hostReference.cases[0].actual, [0, 1, 8, 3])
    if (negative === 'short-array') await replaceJson(root, hostReference.cases[0].actual, [0, 1, 2])
    if (negative === 'wrong-source-config') hostReference.config = design.source
    if (negative === 'missing-case') hostReference.cases.pop()
    if (negative === 'duplicate-case') hostReference.cases.push(hostReference.cases[0])
    if (negative === 'fractional-integers' || negative === 'unsafe-integers') {
      await replaceJson(root, hostReference.cases[0].actual, negative === 'fractional-integers' ? [0, 1.5, 2, 3] : [0, 2 ** 53, 2, 3])
    }
    await writeFile(join(root, 'host.json'), JSON.stringify({ design, hostReference, verdict: 'PASS' }))
    const result = await checkBuckyballEvidence(root, 'host-reference', 'host.json', join(root, 'project.json'), undefined, stage)
    assert.ok((result.failures as string[]).length > 0)
    assert.equal((result.metrics as { casesRun: number }).casesRun, stageCases(stage).length)
    if (negative === 'missing-case') assert.ok((result.failures as string[]).some(value => value.includes('Required frozen reference vector missing')))
    if (negative === 'duplicate-case') assert.ok((result.failures as string[]).includes('reference case IDs are duplicated'))
    assert.ok(!(result.failures as string[]).some(x => x.startsWith('identity mismatch:')))
    assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, result).valid, true)
  })
}

void test('numerical preserves the FP32 tolerance and exact integer contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-numerical-rules-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidence = await writeBuckyballEvidence(root)
  assert.ok(evidence.numerical)
  evidence.design.compiledPrecision = evidence.numerical.precision = 'FP32'
  evidence.numerical.rtol = 1e-4; evidence.numerical.atol = 1e-5
  await replaceJson(root, evidence.design.config, { precision: 'FP32' })
  await writeFile(join(root, 'actual.json'), '[0.000009,1.00009,2,3]')
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
  assert.deepEqual((await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, 'campplus')).failures, [])
  assert.ok(((await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, 'tokenizer.codes')).failures as string[]).length > 0)
  await writeFile(join(root, 'actual.json'), '[0.00002,1,2,3]')
  assert.ok(((await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, 'campplus')).failures as string[]).length > 0)
  evidence.numerical.atol = 1
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
  const relaxed = await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, 'campplus')
  assert.ok((relaxed.failures as string[]).includes('FP32 rules differ from the frozen reference contract'))
})

for (const failure of ['malformed', 'nonfinite', 'empty', 'exit'] as const) {
  void test(`numerical retains every case after candidate ${failure}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bb-program-failure-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const evidence = await writeBuckyballEvidence(root)
    assert.ok(evidence.numerical)
    const program = failure === 'exit' ? 'process.exit(7)' : `console.log(${JSON.stringify(failure === 'malformed' ? 'broken json' : failure === 'nonfinite' ? '[1e400]' : '[]')})`
    await replaceText(root, evidence.numerical.entrypoint, program)
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
    const result = await checkBuckyballEvidence(root, 'numerical', 'evidence.json', join(root, 'project.json'), undefined, 'campplus')
    assert.equal((result.metrics as { casesRun: number }).casesRun, stageCases('campplus').length)
    assert.equal((result.cases as { failure: string }[]).filter(value => value.failure).length, stageCases('campplus').length)
    assert.ok((result.failures as string[]).length >= stageCases('campplus').length)
    assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, result).valid, true)
  })
}

void test('compiler scope checks reachable native mappings and the generated registry without requiring RTL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-compiler-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { design, compiler } = await writeBuckyballEvidence(root)
  assert.ok(compiler)
  await writeFile(join(root, 'compiler.json'), JSON.stringify({ design, compiler }))
  await rm(join(root, 'frontend.yosys.json'))
  const result = await checkBuckyballEvidence(root, 'compiler', 'compiler.json', join(root, 'project.json'))
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.metrics, { routes: 1, recipeOperations: 1, mappedOperations: 1, targets: 1 })
  assert.equal('ppa' in result, false)
})

for (const negative of ['detached-recipe', 'detached-mapped', 'wrong-target', 'wrong-registry', 'wrong-source-config'] as const) {
  void test(`compiler scope rejects ${negative} despite a claimed successful build`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bb-compiler-scope-bad-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const { design, compiler } = await writeBuckyballEvidence(root)
    assert.ok(compiler)
    if (negative.startsWith('detached-')) {
      const identity = negative === 'detached-recipe' ? compiler.recipe : compiler.graph
      const original = JSON.parse(await readFile(join(root, identity.path), 'utf8')) as { entrypoints: { main: unknown[] } }
      await replaceJson(root, identity, { entrypoints: { main: [], unreachable: original.entrypoints.main }, claimedPass: true })
    }
    if (negative === 'wrong-target') {
      const build = JSON.parse(await readFile(join(root, compiler.buildReport.path), 'utf8')) as object
      await replaceJson(root, compiler.buildReport, { ...build, compilerCommand: ['buddy-opt', '--target=unregistered'] })
    }
    if (negative === 'wrong-registry') await replaceJson(root, compiler.compiler, { targets: [] })
    if (negative === 'wrong-source-config') {
      const build = JSON.parse(await readFile(join(root, compiler.buildReport.path), 'utf8')) as object
      await replaceJson(root, compiler.buildReport, { ...build, sourceDigest: design.config.digest })
    }
    await writeFile(join(root, 'compiler.json'), JSON.stringify({ design, compiler, verdict: 'PASS' }))
    const result = await checkBuckyballEvidence(root, 'compiler', 'compiler.json', join(root, 'project.json'))
    assert.ok((result.failures as string[]).length > 0)
    assert.ok(!(result.failures as string[]).some(x => x.startsWith('identity mismatch:')))
    assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, result).valid, true)
  })
}

void test('synthesis scope computes component estimates from raw reports without producing workload PPA', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-synthesis-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { design, synthesis } = await writeBuckyballEvidence(root)
  assert.ok(synthesis)
  await replaceJson(root, synthesis.report, { ...JSON.parse(await readFile(join(root, synthesis.report.path), 'utf8')) as object,
    powerMw: 9999, criticalPathNs: 9999, areaUm2: 9999, verdict: 'PASS' })
  await writeFile(join(root, 'synthesis.json'), JSON.stringify({ design, synthesis }))
  await rm(join(root, 'mockbaseline'), { recursive: true })
  const result = await checkBuckyballEvidence(root, 'synthesis', 'synthesis.json', join(root, 'project.json'))
  assert.deepEqual(result.failures, [])
  assert.equal('ppa' in result, false)
  const metrics = result.metrics as Record<string, unknown>
  assert.equal(metrics.scope, 'component-logic-synthesis')
  assert.deepEqual([metrics.powerMw, metrics.criticalPathNs, metrics.areaUm2, metrics.modules, metrics.activeInstances], [10, 2, 100, 3, 1])
  synthesis.design.rtlTop = 'Conv1dBall'; synthesis.design.activeInstances = ['.']
  const report = JSON.parse(await readFile(join(root, synthesis.report.path), 'utf8')) as object
  await replaceJson(root, synthesis.report, { ...report, rtlTop: synthesis.design.rtlTop, activeInstances: ['.'] })
  await writeFile(join(root, 'synthesis.json'), JSON.stringify({ design, synthesis }))
  const leaf = await checkBuckyballEvidence(root, 'synthesis', 'synthesis.json', join(root, 'project.json'))
  assert.deepEqual(leaf.failures, [], 'a standalone top is an explicit component boundary')
  assert.equal('ppa' in leaf, false)
})

for (const negative of ['wrong-boundary', 'wrong-library', 'wrong-instance', 'wrong-source-config', 'missing-units'] as const) {
  void test(`synthesis scope rejects ${negative} despite coherent file hashes`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bb-synthesis-scope-bad-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const { design, synthesis } = await writeBuckyballEvidence(root)
    assert.ok(synthesis)
    if (negative === 'wrong-boundary') synthesis.boundary.interface = 'different boundary'
    if (negative === 'wrong-library') {
      synthesis.boundary.corner = 'another corner'
      const report = JSON.parse(await readFile(join(root, synthesis.report.path), 'utf8')) as object
      await replaceJson(root, synthesis.report, { ...report, boundary: synthesis.boundary })
    }
    if (negative === 'wrong-instance') {
      synthesis.design.activeInstances = ['not-instantiated']
      const report = JSON.parse(await readFile(join(root, synthesis.report.path), 'utf8')) as object
      await replaceJson(root, synthesis.report, { ...report, activeInstances: synthesis.design.activeInstances })
    }
    if (negative === 'wrong-source-config') synthesis.design.source = design.config
    if (negative === 'missing-units') {
      const text = 'data arrival time 2\n'
      await writeFile(join(root, synthesis.rawReports.timing.path), text)
      synthesis.rawReports.timing.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`
    }
    await writeFile(join(root, 'synthesis.json'), JSON.stringify({ design, synthesis, verdict: 'PASS' }))
    if (negative === 'missing-units') await assert.rejects(checkBuckyballEvidence(root, 'synthesis', 'synthesis.json', join(root, 'project.json')), /must declare ns and um2 units/)
    else {
      const result = await checkBuckyballEvidence(root, 'synthesis', 'synthesis.json', join(root, 'project.json'))
      assert.ok((result.failures as string[]).length > 0)
      assert.ok(!(result.failures as string[]).some(x => x.startsWith('identity mismatch:')))
      assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, result).valid, true)
    }
  })
}

for (const negative of ['detached-recipe-op', 'detached-mapped-op', 'empty-actual-route', 'unrelated-module', 'target-mismatch'] as const) {
  void test(`Buckyball integration rejects ${negative} despite matching names and file identities`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bb-route-bad-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const evidence = await writeBuckyballEvidence(root)
    assert.ok(evidence.integration)
    const integration = evidence.integration, route = integration.routes[0]
    const replace = async (identity: { path: string; digest: string }, value: unknown) => {
      const text = JSON.stringify(value)
      await writeFile(join(root, identity.path), text)
      identity.digest = `sha256:${createHash('sha256').update(text).digest('hex')}`
    }
    let reason: RegExp
    if (negative === 'unrelated-module') {
      route.rtlBall = 'Core'
      route.instance = 'core_0'
      reason = /RTL instance differs from registered Ball class/
    } else if (negative === 'target-mismatch') {
      const build = JSON.parse(await readFile(join(root, integration.buildReport.path), 'utf8')) as Record<string, unknown>
      await replace(integration.buildReport, { ...build, compilerCommand: ['buddy-opt', '--target', 'poly'] })
      reason = /generated graph does not map/
    } else if (negative === 'empty-actual-route') {
      const rtl = JSON.parse(await readFile(join(root, integration.rtl.path), 'utf8')) as { modules: Record<string, { cells: Record<string, unknown> }> }
      rtl.modules[route.rtlTop].cells = {}
      await replace(integration.rtl, rtl)
      reason = /no reachable Core\/Ball instance/
    } else {
      const mapped = negative === 'detached-mapped-op'
      const identity = mapped ? integration.graph : integration.recipe
      await replace(identity, { entrypoints: { main: [], detached: [{ name: mapped ? route.mappedOperation : route.operation,
        target: mapped ? route.compilerTarget : null }] }, claimedRoute: route })
      reason = mapped ? /generated graph does not map/ : /recipe entrypoint does not call/
    }
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
    for (const kind of ['integration', 'implementation', 'ppa'] as const) {
      const result = await checkBuckyballEvidence(root, kind, 'evidence.json', join(root, 'project.json'))
      assert.ok((result.failures as string[]).some(failure => reason.test(failure)), `${kind}: ${JSON.stringify(result)}`)
      assert.ok(!(result.failures as string[]).some(failure => failure.startsWith('identity mismatch:')), 'negative control keeps every file identity current')
    }
  })
}
