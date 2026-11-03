import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync,writeFileSync } from 'node:fs'
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import type { TestContext } from 'node:test'

import { AdmissionError,admitRootTask,canonicalize,checkRecipeSchema,parseJsonText,publicCheckReportSchema,seal,sealTaskContract,validateInstanceSchema,validatePublicReceipt } from '@singularity/protocol'
import type { Ref,TaskContract } from '@singularity/protocol'
import { DomainStore,prepareExecutableChecks } from '@singularity/runtime'

import { frontendVerifier } from '../examples/buckyball-acceptance.ts'
import { BUCKYBALL_RECIPE,BUCKYBALL_RECIPE_REF,BUCKYBALL_CHECKER_SOURCE,BUCKYBALL_CHECKER_SOURCE_REF,BUCKYBALL_ORACLE_SOURCE,BUCKYBALL_ORACLE_SOURCE_REF,buckyballCheck,describeBuckyballCheck } from '../examples/buckyball-checks.ts'

import { conv1dTaskSpec,conv1dVerifier,describeConv1dCheck,freezeConv1dChecks } from '../examples/conv1d-checks.ts'
import { writeBuckyballEvidence } from './fixtures/buckyball-evidence.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import { agentOptions,fixtureUsage,makeScenario } from './task-fixture.ts'
import { bootSpikeProfile } from '../src/host-composition.ts'

void test('Buckyball task-goal cannot substitute delivery identities for technical acceptance', () => {
  const delivery = buckyballCheck('delivery'), compiler = buckyballCheck('compiler')
  const criterion = { id: 'task-goal', required: true, statement: 'Check the bounded compiler output.', checks: [delivery] }
  assert.throws(() => describeBuckyballCheck({ check: delivery, spec: { criteria: [criterion] } }), /needs a technical check/)
  assert.doesNotThrow(() => describeBuckyballCheck({ check: compiler, spec: { criteria: [{ ...criterion, checks: [delivery, compiler] }] } }))
  assert.doesNotThrow(() => describeBuckyballCheck({ check: delivery, spec: { criteria: [{ ...criterion, id: 'delivery' }] } }))
})

async function conv1dFixture(t: TestContext, timeoutMs: number, scriptSource?: string) {
  const root = await mkdtemp(join(tmpdir(), 'check-execution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await DomainStore.open(join(root, 'domain'))
  t.after(() => store.close())
  const put = (id: string, value: unknown) => store.putObject(id, new TextEncoder().encode(canonicalize(value)))
  const original = await freezeConv1dChecks(store)
  const script = scriptSource === undefined ? original.script : await store.putObject('slow-checker', new TextEncoder().encode(scriptSource))
  const recipe = checkRecipeSchema.parse(parseJsonText(new TextDecoder().decode((await store.readObject(original.recipeRef)).bytes)))
  const recipeRef = await put('short-deadline:recipe', { ...recipe, dependencies: [script], maxWallClockMs: timeoutMs })
  const policy = await put('short-deadline:policy', { checkRecipes: [recipeRef], checkResources: [script] })
  const method = await put('method', {}), seed = await put('seed', {}), profile = await put('profile', {}), requestRef = await put('request', {})
  const spec = conv1dTaskSpec(recipeRef)
  spec.criteria[0].id = 'criterion/with separator'
  spec.criteria[0].checks[0].checkId = 'suite/../all'
  const task = admitRootTask({ taskId: 'execution', spec, method, template: { id: 'local', digest: method.digest }, acceptance: policy,
    resources: { baseTools: [], skills: [], mcpServers: [] }, origin: { kind: 'root', purpose: 'work', requestRef }, environment: { seed, profile },
    limits: { maxRuns: 1, maxStepsPerRun: 10, maxTokens: 1000, deadlineAt: Date.now() + 60_000, maxDepth: 0, maxTasks: 1, maxBatchChildren: 1 } })
  const readReport = async (ref: Ref) => publicCheckReportSchema.parse(
    parseJsonText(new TextDecoder().decode((await store.readObject(ref)).bytes)))
  return { root, store, original, script, recipe, recipeRef, policy, put, task, readReport }
}

const slowChecker = `import os, signal, time
from pathlib import Path
def stop(signum, frame):
    time.sleep(0.1)
    Path('checker-stopped').write_text('closed')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
Path('checker-pid').write_text(str(os.getpid()))
time.sleep(30)
`

void test('a recipe execution timeout waits for its real checker to exit and returns an unscored invalid result', { timeout: 15_000 }, async t => {
  const f = await conv1dFixture(t, 500, slowChecker)
  const operationId = 'owned-timeout:verify'
  const workspace = join(f.root, 'reviews', Buffer.from(operationId).toString('hex'))
  const receipt = await conv1dVerifier({ root: join(f.root, 'reviews'), writer: f.store, recipeRef: f.recipeRef, script: f.script })({
    task: f.task, operationId, inputs: [], outputs: [], signal: new AbortController().signal,
    readObject: (ref, domain) => f.store.readObject(ref, domain),
  })
  assert.equal(await readFile(join(workspace, 'checker-stopped'), 'utf8'), 'closed', 'verification awaits process close after its SIGTERM handler')
  const pid = Number(await readFile(join(workspace, 'checker-pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(receipt.criteria[0].verdict, 'invalid')
  assert.equal(receipt.criteria[0].metric, undefined)
  const report = await f.readReport(receipt.criteria[0].checks[0].reportRef)
  assert.equal(report.timedOut, true)
  assert.equal(report.verdict, 'invalid')
  assert.equal(validateInstanceSchema(f.recipe.resultSchema, report.data).valid, true)
  assert.deepEqual(report.exit, { code: 0, signal: null }, 'raw checker exit stays distinct from the execution timeout')
  assert.equal(validatePublicReceipt(receipt, { provider: f.policy, operationId, contractDigest: f.task.digest,
    inputDigests: [], outputDigests: [], requiredCriteria: f.task.spec.criteria }).verdict, 'invalid')
})

void test('operator cancellation preserves its original reason after the checker exits; unrelated failures stay host errors', { timeout: 15_000 }, async t => {
  const f = await conv1dFixture(t, 10_000, slowChecker)
  const cancel = new AbortController(), reason = new Error('operator stopped verification')
  const operationId = 'operator-cancel:verify'
  const workspace = join(f.root, 'reviews', Buffer.from(operationId).toString('hex'))
  const verify = conv1dVerifier({ root: join(f.root, 'reviews'), writer: f.store, recipeRef: f.recipeRef, script: f.script })
  const pending = verify({ task: f.task, operationId, inputs: [], outputs: [], signal: cancel.signal,
    readObject: (ref, domain) => f.store.readObject(ref, domain) })
  const rejected = assert.rejects(pending, error => error === reason)
  for (let attempt = 0; ; attempt += 1) {
    try { await readFile(join(workspace, 'checker-pid')); break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 100) throw error }
    await delay(10)
  }
  cancel.abort(reason)
  await rejected
  assert.equal(await readFile(join(workspace, 'checker-stopped'), 'utf8'), 'closed')
  const hostFailure = new DOMException('upstream timeout, outside this recipe deadline', 'TimeoutError')
  await assert.rejects(verify({ task: f.task, operationId: 'host-failure:verify', inputs: [], outputs: [], signal: new AbortController().signal,
    readObject: () => Promise.reject(hostFailure) }), error => error === hostFailure)
})

void test('Conv1D checks keep legal criterion/check separators in identities and encode their report filenames', { timeout: 30_000 }, async t => {
  const f = await conv1dFixture(t, 10_000)
  const bytes = await readFile(new URL('./fixtures/conv1d/candidate_good.py', import.meta.url))
  const object = await f.store.putObject('candidate', bytes)
  const output = await f.put('execution:output:result', seal('object', { v: 1, kind: 'tree', files: [{ path: 'candidate.py', bytes: bytes.byteLength, object }] }))
  const operationId = 'encoded:verify'
  const receipt = await conv1dVerifier({ root: join(f.root, 'reviews'), writer: f.store, recipeRef: f.recipeRef, script: f.original.script })({
    task: f.task, operationId, inputs: [], outputs: [output], signal: new AbortController().signal,
    readObject: (ref, domain) => f.store.readObject(ref, domain),
  })
  assert.equal(receipt.criteria[0].verdict, 'pass')
  const criterion = f.task.spec.criteria[0], check = criterion.checks[0]
  const report = await f.readReport(receipt.criteria[0].checks[0].reportRef)
  assert.equal(report.criterionId, criterion.id)
  assert.equal(report.checkId, check.checkId)
  const file = join(f.root, 'reviews', Buffer.from(operationId).toString('hex'), 'checks', encodeURIComponent(criterion.id), `${encodeURIComponent(check.checkId)}.json`)
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { verdict: string }).verdict, 'pass')
  const preview = describeConv1dCheck({ check, recipeRef: f.recipeRef, recipe: {} as never, spec: f.task.spec, limits: f.task.limits })
  assert.equal(preview.displayCommand.at(-1), `checks/${encodeURIComponent(check.checkId)}.json`)
  await assert.rejects(prepareExecutableChecks({ reader: f.store, acceptance: f.policy, limits: f.task.limits, describeCheck: describeConv1dCheck,
    spec: { ...f.task.spec, criteria: [{ ...criterion, checks: [{ ...check, params: { candidate: 'result/../candidate.py', suite: 'all' } }] }] } }),
  error => error instanceof AdmissionError && error.code === 'INVALID_ARGUMENT')
})

void test('Buckyball executes encoded report filenames and classifies its own check deadline as invalid', { timeout: 30_000 }, async t => {
  const criterionId = 'criterion/with separator', checkId = 'numerical/../comparison'
  const workspace = await mkdtemp(join(tmpdir(), 'bb-check-execution-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const storeRoot = join(workspace, 'domain')
  let reviewRoot: string
  const fixture = await startChatCompletionsFixture((_request, index) => {
    assert.equal(readFileSync(join(reviewRoot, 'check-recipe.json'), 'utf8'), canonicalize(BUCKYBALL_RECIPE), 'the reviewer can read the frozen schema before its first request')
    assert.deepEqual(new Uint8Array(readFileSync(join(reviewRoot, 'frozen-checker.ts'))), BUCKYBALL_CHECKER_SOURCE)
    assert.deepEqual(new Uint8Array(readFileSync(join(reviewRoot, 'buckyball-oracle.py'))), BUCKYBALL_ORACLE_SOURCE)
    writeFileSync(join(reviewRoot, 'frozen-checker.ts'), 'throw new Error("Modified preview must not execute")')
    writeFileSync(join(reviewRoot, 'buckyball-oracle.py'), 'raise Exception("Modified preview must not execute")')
    return { toolCalls: [{ id: `review-${String(index)}`, name: 'buckyball_review_submit',
      arguments: JSON.stringify({ result: { criteria: [{ id: criterionId, verdict: 'pass', reason: 'Synthetic check execution fixture.' }] } }) }], usage: fixtureUsage(index) }
  })
  const spike = await bootSpikeProfile({ home: join(workspace, 'dsh'), baseURL: fixture.baseURL, apiKey: 'fixture-key',
    patchFiles: [fileURLToPath(new URL('../examples/buckyball.patch.yml', import.meta.url))] })
  try {
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'bb-check-execution', maxRuns: 1 })
    const store = await DomainStore.open(storeRoot)
    try {
      assert.deepEqual(await store.putObject(BUCKYBALL_RECIPE_REF.id, new TextEncoder().encode(canonicalize(BUCKYBALL_RECIPE))), BUCKYBALL_RECIPE_REF)
      assert.deepEqual(await store.putObject(BUCKYBALL_CHECKER_SOURCE_REF.id, BUCKYBALL_CHECKER_SOURCE), BUCKYBALL_CHECKER_SOURCE_REF)
      assert.deepEqual(await store.putObject(BUCKYBALL_ORACLE_SOURCE_REF.id, BUCKYBALL_ORACLE_SOURCE), BUCKYBALL_ORACLE_SOURCE_REF)
      const check = { ...buckyballCheck('numerical'), checkId }
      const { digest, ...payload } = scenario.contract
      void digest
      const task = sealTaskContract({ ...payload, spec: { ...payload.spec, criteria: [{ id: criterionId,
        statement: 'Synthetic finite execution fixture.', required: true, checks: [check] }] } })
      const reviews = join(workspace, 'reviews'), baseline = join(workspace, 'baseline')
      await mkdir(baseline)
      const verify = frontendVerifier(spike.ctx, { root: reviews, baseline, project: join(reviews, Buffer.from('bb-encoded:verify').toString('hex'), 'reproduced/project.json'), agentOptions: agentOptions(), writer: store, frozenSkills: [] })
      const invoke = async (operationId: string, currentTask: TaskContract) => {
        const root = join(reviews, Buffer.from(operationId).toString('hex'))
        reviewRoot = root
        await writeBuckyballEvidence(join(root, 'reproduced'))
        return { root, request: { task: currentTask, operationId, inputs: [], outputs: [], signal: new AbortController().signal,
          readObject: (ref: Parameters<DomainStore['readObject']>[0], domain: Parameters<DomainStore['readObject']>[1]) => store.readObject(ref, domain) } }
      }
      const success = await invoke('bb-encoded:verify', task)
      const receipt = await verify(success.request)
      assert.equal(receipt.criteria[0].verdict, 'pass')
      assert.deepEqual(new Uint8Array(await readFile(join(success.root, 'frozen-checker.ts'))), BUCKYBALL_CHECKER_SOURCE)
      const reportPath = join(success.root, 'checks', encodeURIComponent(criterionId), `${encodeURIComponent(checkId)}.json`)
      assert.deepEqual((JSON.parse(await readFile(reportPath, 'utf8')) as { failures: unknown[] }).failures, [])
      const substitution = await invoke('bb-oracle-substitution:verify', task)
      const evidencePath = join(substitution.root, 'reproduced/evidence.json')
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as { numerical: { actual: { path: string; digest: string } }[] }
      const actual = evidence.numerical[0].actual, replacement = '[0,1,8,3]'
      await writeFile(join(substitution.root, 'reproduced', actual.path), replacement)
      actual.digest = `sha256:${createHash('sha256').update(replacement).digest('hex')}`
      Object.assign(evidence.numerical[0], { reference: actual })
      await writeFile(evidencePath, JSON.stringify(evidence))
      const rejected = await verify(substitution.request)
      assert.equal(rejected.criteria[0].verdict, 'fail', 'reviewer PASS cannot override native oracle mismatch')
      assert.equal(rejected.criteria[0].checks[0].verdict, 'fail')
      const rejectedReport = publicCheckReportSchema.parse(parseJsonText(new TextDecoder().decode((await store.readObject(rejected.criteria[0].checks[0].reportRef)).bytes)))
      assert.equal((rejectedReport.data.metrics as { mismatches: number }).mismatches, 1)
      const malformed = await invoke('bb-oracle-shape:verify', task)
      const malformedPath = join(malformed.root, 'reproduced/evidence.json')
      const malformedEvidence = JSON.parse(await readFile(malformedPath, 'utf8')) as { numerical: { input: { path: string; digest: string } }[] }
      const input = malformedEvidence.numerical[0].input
      const malformedInput = JSON.stringify({ stage: 'campplus', seed: 0, tensors: { feats: { shape: [1, 2, 80], values: [0] } } })
      await writeFile(join(malformed.root, 'reproduced', input.path), malformedInput)
      input.digest = `sha256:${createHash('sha256').update(malformedInput).digest('hex')}`
      await writeFile(malformedPath, JSON.stringify(malformedEvidence))
      const badShape = await verify(malformed.request)
      assert.equal(badShape.criteria[0].verdict, 'fail', 'invalid tensor dimensions produce a public failure report')
      const shapeReport = publicCheckReportSchema.parse(parseJsonText(new TextDecoder().decode((await store.readObject(badShape.criteria[0].checks[0].reportRef)).bytes)))
      assert.match(JSON.stringify(shapeReport.data.failures), /Tensor shape does not match value count/)
      const hostFailure = await invoke('bb-missing-native:verify', task)
      const projectPath = join(success.root, 'reproduced/project.json')
      const projectBytes = await readFile(projectPath)
      const project = JSON.parse(projectBytes.toString('utf8')) as { referencePython: string }
      await writeFile(projectPath, JSON.stringify({ ...project, referencePython: join(workspace, 'missing-native-python') }))
      try {
        await assert.rejects(verify(hostFailure.request), error => error instanceof Error && error.message.includes('missing-native-python') && error.message.includes('ENOENT'))
      } finally { await writeFile(projectPath, projectBytes) }
      assert.equal(describeBuckyballCheck({ check, spec: { criteria: [] } }).displayCommand.at(-1), `checks/${encodeURIComponent(checkId)}.json`)
      const timedTask = sealTaskContract({ ...payload, spec: task.spec, limits: { ...task.limits, deadlineAt: Date.now() + 1500 } })
      const timeout = await invoke('bb-timeout:verify', timedTask)
      const source = join(timeout.root, 'reproduced', 'source.txt')
      await rm(source)
      await promisify(execFile)('mkfifo', [source])
      const invalid = await verify(timeout.request)
      assert.equal(invalid.criteria[0].verdict, 'invalid')
      const report = publicCheckReportSchema.parse(parseJsonText(new TextDecoder().decode((await store.readObject(invalid.criteria[0].checks[0].reportRef)).bytes)))
      assert.equal(report.timedOut, true)
      assert.equal(report.verdict, 'invalid')
      assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, report.data).valid, true)
      assert.equal(report.recipeRef.digest, BUCKYBALL_RECIPE_REF.digest)
    } finally { await store.close() }
  } finally { await spike.dispose(); await fixture.close() }
})
