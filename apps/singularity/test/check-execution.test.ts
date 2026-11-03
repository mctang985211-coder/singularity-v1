import assert from 'node:assert/strict'
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { mkdtemp,mkdir,readFile,readdir,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { TestContext } from 'node:test'

import { AdmissionError,admitRootTask,canonicalize,checkRecipeSchema,parseJsonText,publicCheckReportSchema,seal,sealTaskContract,validateInstanceSchema,validatePublicReceipt } from '@singularity/protocol'
import type { Ref,TaskContract } from '@singularity/protocol'
import { DomainStore,prepareExecutableChecks } from '@singularity/runtime'

import { frontendVerifier } from '../examples/buckyball-acceptance.ts'
import { BUCKYBALL_CASES_SOURCE,BUCKYBALL_CASES_SOURCE_REF,BUCKYBALL_CASES,BUCKYBALL_RECIPE,BUCKYBALL_RECIPE_REF,BUCKYBALL_CHECKER_SOURCE,BUCKYBALL_CHECKER_SOURCE_REF,BUCKYBALL_ORACLE_SOURCE,BUCKYBALL_ORACLE_SOURCE_REF,buckyballCheck,describeBuckyballCheck } from '../examples/buckyball-checks.ts'

import { conv1dTaskSpec,conv1dVerifier,describeConv1dCheck,freezeConv1dChecks } from '../examples/conv1d-checks.ts'
import { writeBuckyballEvidence,writeSyntheticBuckyballToolchain } from './fixtures/buckyball-evidence.ts'
import { startChatCompletionsFixture } from './fixtures/chat-completions.ts'
import { agentOptions,fixtureUsage,makeScenario } from './task-fixture.ts'
import { bootSpikeProfile } from '../src/host-composition.ts'

void test('Buckyball task-goal cannot substitute delivery identities for technical acceptance', () => {
  assert.throws(() => buckyballCheck('numerical'), /stage/)
  assert.throws(() => buckyballCheck('host-reference'), /stage/)
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

void test('Buckyball executes CAS programs, rejects reviewer substitutions and awaits timeout/cancel closure', { timeout: 45_000 }, async t => {
  const criterionId = 'criterion/with separator', checkId = 'numerical/../comparison'
  const workspace = await mkdtemp(join(tmpdir(), 'bb-check-execution-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const storeRoot = join(workspace, 'domain')
  let reviewRoot: string
  const fixture = await startChatCompletionsFixture((_request, index) => {
    assert.equal(readFileSync(join(reviewRoot, 'check-recipe.json'), 'utf8'), canonicalize(BUCKYBALL_RECIPE), 'the reviewer can read the frozen schema before its first request')
    for (const [path, bytes] of [['frozen-checker.ts', BUCKYBALL_CHECKER_SOURCE], ['buckyball-oracle.py', BUCKYBALL_ORACLE_SOURCE], ['buckyball-cases.json', BUCKYBALL_CASES_SOURCE]] as const) {
      assert.deepEqual(new Uint8Array(readFileSync(join(reviewRoot, path))), bytes)
      writeFileSync(join(reviewRoot, path), 'Modified preview must not execute')
    }
    for (const directory of ['outputs/result', 'reproduced/result']) {
      const target = join(reviewRoot, directory)
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'numerical-arm.cjs'), "console.log('[0,1,2,3]')")
      writeFileSync(join(target, 'actual.json'), '[0,1,2,3]')
    }
    const candidate = join(reviewRoot, 'candidate', encodeURIComponent(criterionId), encodeURIComponent(checkId))
    mkdirSync(candidate, { recursive: true })
    writeFileSync(join(candidate, 'reviewer-dependency.json'), '[0,1,2,3]')
    return { toolCalls: [{ id: `review-${String(index)}`, name: 'buckyball_review_submit',
      arguments: JSON.stringify({ result: { criteria: [{ id: criterionId, verdict: 'pass', reason: 'Synthetic reviewer claims PASS after changing its writable copies.' }] } }) }], usage: fixtureUsage(index) }
  })
  const spike = await bootSpikeProfile({ home: join(workspace, 'dsh'), baseURL: fixture.baseURL, apiKey: 'fixture-key',
    patchFiles: [fileURLToPath(new URL('../examples/buckyball.patch.yml', import.meta.url))] })
  try {
    const scenario = await makeScenario(storeRoot, spike.ctx, { taskId: 'bb-check-execution', maxRuns: 1 })
    const store = await DomainStore.open(storeRoot)
    try {
      for (const [ref, bytes] of [[BUCKYBALL_RECIPE_REF, new TextEncoder().encode(canonicalize(BUCKYBALL_RECIPE))],
        [BUCKYBALL_CHECKER_SOURCE_REF, BUCKYBALL_CHECKER_SOURCE], [BUCKYBALL_ORACLE_SOURCE_REF, BUCKYBALL_ORACLE_SOURCE],
        [BUCKYBALL_CASES_SOURCE_REF, BUCKYBALL_CASES_SOURCE]] as const) assert.deepEqual(await store.putObject(ref.id, bytes), ref)
      const check = { ...buckyballCheck('numerical', 'campplus', 'result/evidence.json'), checkId }
      const { digest, ...payload } = scenario.contract
      void digest
      const task = sealTaskContract({ ...payload, spec: { ...payload.spec, inputs: [],
        outputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }],
        criteria: [{ id: criterionId, statement: 'Synthetic finite execution fixture.', required: true, checks: [check] }] } })
      const reviews = join(workspace, 'reviews'), host = join(workspace, 'host')
      await mkdir(host)
      const { baseline, project } = await writeSyntheticBuckyballToolchain(host)
      const verify = frontendVerifier(spike.ctx, { root: reviews, baseline, project, agentOptions: agentOptions(), writer: store, frozenSkills: [] })
      const invoke = async (operationId: string, currentTask: TaskContract, options: { actual?: string; program?: string } = {}) => {
        const root = join(reviews, Buffer.from(operationId).toString('hex'))
        reviewRoot = root
        const delivery = join(workspace, 'deliveries', Buffer.from(operationId).toString('hex'))
        const evidence = await writeBuckyballEvidence(delivery, { pathPrefix: 'result', actual: options.actual })
        if (options.program !== undefined) {
          assert.ok(evidence.numerical)
          await writeFile(join(delivery, 'numerical-arm.cjs'), options.program)
          const object = await store.putObject(`${operationId}:program`, new TextEncoder().encode(options.program))
          evidence.numerical.entrypoint.digest = object.digest
          await writeFile(join(delivery, 'evidence.json'), JSON.stringify(evidence))
        }
        const entries = (await readdir(delivery, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
        const files = []
        for (const entry of entries) {
          const absolute = join(entry.parentPath, entry.name), path = relative(delivery, absolute), bytes = await readFile(absolute)
          files.push({ path, bytes: bytes.byteLength, object: await store.putObject(`${operationId}:${path}`, bytes) })
        }
        files.sort((a, b) => a.path.localeCompare(b.path))
        const output = await store.putObject(`${operationId}:output:result`, new TextEncoder().encode(canonicalize(seal('object', { v: 1, kind: 'tree', files }))))
        return { root, candidate: join(root, 'candidate', encodeURIComponent(criterionId), encodeURIComponent(checkId)),
          request: { task: currentTask, operationId, inputs: [], outputs: [output], signal: new AbortController().signal,
            readObject: (ref: Parameters<DomainStore['readObject']>[0], domain: Parameters<DomainStore['readObject']>[1]) => store.readObject(ref, domain) } }
      }
      const success = await invoke('bb-encoded:verify', task)
      const receipt = await verify(success.request)
      assert.equal(receipt.criteria[0].verdict, 'pass')
      assert.deepEqual(new Uint8Array(await readFile(join(success.root, 'frozen-checker.ts'))), BUCKYBALL_CHECKER_SOURCE)
      assert.deepEqual(new Uint8Array(await readFile(join(success.root, 'buckyball-cases.json'))), BUCKYBALL_CASES_SOURCE)
      const reportPath = join(success.root, 'checks', encodeURIComponent(criterionId), `${encodeURIComponent(checkId)}.json`)
      assert.deepEqual((JSON.parse(await readFile(reportPath, 'utf8')) as { failures: unknown[] }).failures, [])
      assert.equal(describeBuckyballCheck({ check, spec: { criteria: [] } }).displayCommand.at(-1), `checks/${encodeURIComponent(checkId)}.json`)
      const badProgram = "console.log(require('node:fs').existsSync('reviewer-dependency.json') ? '[0,1,2,3]' : '[0,1,8,3]')"
      const substitution = await invoke('bb-cas-substitution:verify', task, { actual: '[0,1,8,3]', program: badProgram })
      const rejected = await verify(substitution.request)
      assert.equal(rejected.criteria[0].verdict, 'fail', 'reviewer PASS and writable outputs/reproduced cannot override CAS candidate mismatch')
      assert.equal(rejected.criteria[0].checks[0].verdict, 'fail')
      const rejectedReport = publicCheckReportSchema.parse(parseJsonText(new TextDecoder().decode((await store.readObject(rejected.criteria[0].checks[0].reportRef)).bytes)))
      const count = BUCKYBALL_CASES.filter(item => item.input.stage === 'campplus').length
      assert.equal((rejectedReport.data.metrics as { mismatches: number }).mismatches, count)
      assert.equal((rejectedReport.data.cases as unknown[]).length, count)
      assert.equal(await readFile(join(substitution.candidate, 'result/actual.json'), 'utf8'), '[0,1,8,3]')
      assert.equal(await readFile(join(substitution.candidate, 'result/numerical-arm.cjs'), 'utf8'), badProgram)
      await assert.rejects(readFile(join(substitution.candidate, 'reviewer-dependency.json')), { code: 'ENOENT' })
      const hostFailure = await invoke('bb-missing-native:verify', task)
      const projectBytes = await readFile(project)
      const projectValue = JSON.parse(projectBytes.toString('utf8')) as { referencePython: string }
      await writeFile(project, JSON.stringify({ ...projectValue, referencePython: join(workspace, 'missing-native-python') }))
      try {
        await assert.rejects(verify(hostFailure.request), error => error instanceof Error && error.message.includes('missing-native-python') && error.message.includes('ENOENT'))
      } finally { await writeFile(project, projectBytes) }
      const slowProgram = `const fs = require('node:fs');
JSON.parse(fs.readFileSync(0, 'utf8'));
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync('candidate-stopped', 'closed'); process.exit(0); }, 100));
fs.writeFileSync('candidate-pid', String(process.pid));
setTimeout(() => {}, 30000);`
      const timedTask = sealTaskContract({ ...payload, spec: task.spec, limits: { ...task.limits, deadlineAt: Date.now() + 1500 } })
      const timeout = await invoke('bb-timeout:verify', timedTask, { program: slowProgram })
      const invalid = await verify(timeout.request)
      assert.equal(invalid.criteria[0].verdict, 'invalid')
      assert.equal(await readFile(join(timeout.candidate, 'candidate-stopped'), 'utf8'), 'closed')
      const pid = Number(await readFile(join(timeout.candidate, 'candidate-pid'), 'utf8'))
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      const report = publicCheckReportSchema.parse(parseJsonText(new TextDecoder().decode((await store.readObject(invalid.criteria[0].checks[0].reportRef)).bytes)))
      assert.equal(report.timedOut, true)
      assert.equal(report.verdict, 'invalid')
      assert.equal(validateInstanceSchema(BUCKYBALL_RECIPE.resultSchema, report.data).valid, true)
      assert.equal(report.recipeRef.digest, BUCKYBALL_RECIPE_REF.digest)
      const cancellation = await invoke('bb-cancel:verify', task, { program: slowProgram })
      const controller = new AbortController(), reason = new Error('operator stopped Buckyball verification')
      const pending = verify({ ...cancellation.request, signal: controller.signal })
      const rejectedCancellation = assert.rejects(pending, error => error === reason)
      for (let attempt = 0; ; attempt += 1) {
        try { await readFile(join(cancellation.candidate, 'candidate-pid')); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 300) throw error }
        await delay(10)
      }
      controller.abort(reason)
      await rejectedCancellation
      assert.equal(await readFile(join(cancellation.candidate, 'candidate-stopped'), 'utf8'), 'closed')
      const cancelledPid = Number(await readFile(join(cancellation.candidate, 'candidate-pid'), 'utf8'))
      assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' })
    } finally { await store.close() }
  } finally { await spike.dispose(); await fixture.close() }
})
