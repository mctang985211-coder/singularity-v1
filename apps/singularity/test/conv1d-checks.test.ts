import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { admitRootTask,canonicalize,seal } from '@singularity/protocol'
import { CommandService,verifyRunSubmission } from '@singularity/runtime'

import { conv1dTaskSpec,conv1dVerifier,describeConv1dCheck,freezeConv1dChecks } from '../examples/conv1d-checks.ts'

void test('public Conv1D feedback and independent frozen verification reject numerical and streaming defects', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'conv1d-checks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root: join(root, 'domain'), actor: { kind: 'runtime', id: 'conv1d-fixture' }, clock: Date.now })
  t.after(() => service.close())
  const assets = await freezeConv1dChecks(service)
  const put = (id: string, value: unknown) => service.putObject(id, new TextEncoder().encode(canonicalize(value)))
  const method = await put('method', { v: 1 }), seed = await put('seed', { v: 1 }), profile = await put('profile', { v: 1 }), requestRef = await put('request', { v: 1 })
  const task = admitRootTask({ taskId: 'conv1d', spec: conv1dTaskSpec(assets.recipeRef), method, template: { id: 'local', digest: method.digest }, acceptance: assets.policy,
    resources: { baseTools: [], skills: [], mcpServers: [] }, origin: { kind: 'root', purpose: 'work', requestRef }, environment: { seed, profile },
    limits: { maxRuns: 1, maxStepsPerRun: 10, maxTokens: 10000, deadlineAt: Date.now() + 120_000, maxDepth: 2, maxTasks: 4, maxBatchChildren: 2 } })
  const verify = conv1dVerifier({ root: join(root, 'reviews'), writer: service, ...assets })
  for (const [candidate, expected] of [['candidate_good.py', 'verified'], ['candidate_bad_reset.py', 'failed'], ['candidate_bad_zero.py', 'failed']] as const) {
    // Solutions are fixture assets only; no frozen Task input or public checker bundle carries them.
    const bytes = await readFile(new URL(`./fixtures/conv1d/${candidate}`, import.meta.url))
    const object = await service.putObject(`${candidate}:source`, bytes)
    const output = await put(`${candidate}:output:result`, seal('object', { v: 1, kind: 'tree', files: [{ path: 'candidate.py', bytes: bytes.byteLength, object }] }))
    const result = await verifyRunSubmission({ contract: task, runId: candidate, inputs: [], outputs: [output], reader: service, writer: service,
      verifier: { provider: assets.policy, describeCheck: describeConv1dCheck, verify } })
    assert.equal(result.verdict, expected, result.reason)
    {
      assert.equal(result.receipt.criteria[0].checks.length, 1)
      const report = JSON.parse(new TextDecoder().decode((await service.readObject(result.receipt.criteria[0].checks[0].reportRef, 'object')).bytes)) as { data: { metrics: { valuesCompared: number; mismatches: number } } }
      assert.equal(report.data.metrics.valuesCompared, 512)
      assert.equal(report.data.metrics.mismatches === 0, expected === 'verified')
    }
  }
  const publicReport = join(root, 'public-kernel.json')
  const candidate = new URL('./fixtures/conv1d/candidate_bad_reset.py', import.meta.url)
  await mkdir(join(root, 'public'))
  await promisify(execFile)('python3', [new URL('../examples/conv1d/verify.py', import.meta.url).pathname, '--candidate', candidate.pathname, '--suite', 'kernel', '--report', publicReport])
  assert.equal((JSON.parse(await readFile(publicReport, 'utf8')) as { verdict: string }).verdict, 'pass', 'local kernel pass does not cover the stream defect rejected at root')
})
