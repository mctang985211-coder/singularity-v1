import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AdmissionError, canonicalize } from '@singularity/protocol'
import type { JsonObject, TaskSpec } from '@singularity/protocol'
import { prepareExecutableChecks } from '../src/checks.ts'
import { DomainStore } from '../src/store.ts'

void test('check admission resolves full policy refs, dependencies and params before producing any business fact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'check-admission-'))
  const store = await DomainStore.open(root)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const put = (id: string, value: unknown) => store.putObject(id, new TextEncoder().encode(canonicalize(value)))
  const data = await put('public-cases', { cases: [1, 2] })
  const recipe = await put('recipe', { v: 1, name: 'frozen-test-check', entrypoint: ['trusted-check'], dependencies: [data],
    paramsSchema: { type: 'object', additionalProperties: false, required: ['candidate'], properties: { candidate: { type: 'string' } } },
    resultSchema: { type: 'object' }, publicDataPolicy: 'Only the authorized public cases.', passRule: 'Domain compares output values.', maxWallClockMs: 1000 })
  const policy = await put('policy', { checkRecipes: [recipe], checkResources: [data] })
  const spec: TaskSpec = { goal: { summary: 'Work', deliverable: 'result.txt', scope: [], constraints: [] }, inputs: [],
    outputs: [{ id: 'result', path: 'result.txt', kind: 'file', role: 'deliverable', required: true }],
    criteria: [{ id: 'behavior', statement: 'Behavior passes.', required: true,
      checks: [{ checkId: 'behavior', recipeRef: recipe, params: { candidate: 'result.txt' } }] }] }
  const input = { reader: store, acceptance: policy, spec,
    limits: { maxRuns: 1, maxStepsPerRun: 10, maxTokens: 1000, deadlineAt: 10000, maxDepth: 1, maxTasks: 2, maxBatchChildren: 1 },
    describeCheck: ({ check }: { check: { params: JsonObject } }) => {
      if (check.params['candidate'] !== spec.outputs[0].path) throw new AdmissionError('INVALID_ARGUMENT', 'candidate must be a declared output')
      return { displayCommand: ['trusted-check', 'result.txt'], expectedReport: { mismatches: 0 } }
    } }
  const prepared = await prepareExecutableChecks(input)
  assert.deepEqual(prepared.previews[0].displayCommand, ['trusted-check', 'result.txt'])
  assert.deepEqual(prepared.previews[0].expectedReport, { mismatches: 0 })
  const checks = [
    { ...spec.criteria[0].checks[0], recipeRef: { ...recipe, id: 'guessed-alias' } },
    { ...spec.criteria[0].checks[0], params: { candidate: 42 } },
    { ...spec.criteria[0].checks[0], params: { candidate: '/parent/work/result.txt' } },
  ]
  for (const check of checks) {
    await assert.rejects(prepareExecutableChecks({ ...input, spec: { ...spec,
      criteria: [{ ...spec.criteria[0], checks: [check] }] } }), AdmissionError)
  }
  const noDependencyPolicy = await put('missing-dependency-policy', { checkRecipes: [recipe], checkResources: [] })
  await assert.rejects(prepareExecutableChecks({ ...input, acceptance: noDependencyPolicy }), { code: 'INPUT_NOT_AUTHORIZED' })
  const cause = new Error('recipe CAS failed')
  await assert.rejects(prepareExecutableChecks({ ...input,
    reader: { readObject: (ref, domain) => ref.id === recipe.id ? Promise.reject(cause) : store.readObject(ref, domain) } }), error => error === cause)
  assert.equal(store.facts().length, 0)
})
