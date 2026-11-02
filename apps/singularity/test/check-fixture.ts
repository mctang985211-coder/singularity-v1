import assert from 'node:assert/strict'

import { canonicalize, seal, sealPublicCheckReport } from '@singularity/protocol'
import type { ExecutableCheck, PublicCriterionResult, Ref, TaskExample } from '@singularity/protocol'
import { DomainStore } from '@singularity/runtime'
import type { CasObjectWriter, DescribeCheck, VerifierRequest } from '@singularity/runtime'

export const fixtureRecipe = seal('object', {
  v: 1,
  name: 'fixture-independent-output-check',
  entrypoint: ['node', '--input-type=module', '--eval', "import { statSync } from 'node:fs'; statSync(process.argv[1]); console.log(JSON.stringify({outputCount:1}));"],
  dependencies: [],
  paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
  resultSchema: {
    type: 'object', properties: { outputCount: { type: 'integer', minimum: 1 } },
    required: ['outputCount'], additionalProperties: false,
  },
  publicDataPolicy: 'Public native DSH fixture; each verifier asserts the frozen output independently.',
  passRule: 'The owning test verifier checks the declared output bytes or domain value.',
  maxWallClockMs: 1_000,
})
export const FIXTURE_RECIPE_REF: Ref = { id: 'fixture:output-check', digest: fixtureRecipe.digest }
export const fixturePolicyFields = { checkRecipes: [FIXTURE_RECIPE_REF], checkResources: [] }

export function fixtureCheck(checkId = 'declared-output'): ExecutableCheck {
  return { checkId, recipeRef: FIXTURE_RECIPE_REF, params: {} }
}

export async function seedFixtureRecipe(writer: CasObjectWriter): Promise<void> {
  await writer.putObject(FIXTURE_RECIPE_REF.id, new TextEncoder().encode(canonicalize(fixtureRecipe)), 'object')
}

export const describeFixtureCheck: DescribeCheck = ({ recipe, spec }) => ({
  displayCommand: [...recipe.entrypoint, spec.outputs[0].path],
  expectedReport: { outputCount: 'positive; verifier checks frozen values', passRule: recipe.passRule },
})

export function fixtureExample(): TaskExample {
  return {
    goal: { summary: 'Produce the requested frozen result for parent integration.',
      deliverable: 'result/ with the requested bytes and reproducible evidence.',
      scope: ['Consume the authorized input and return a direct result to the parent.'],
      constraints: ['The parent retains integration and its own independent checks.'] },
    inputs: [{ id: 'source', exampleText: 'The public requested output bytes.' }],
    acceptanceChecks: [{ criterionId: 'task-goal', checks: [fixtureCheck('task-goal')] }],
    localCriteria: [], localOutputs: [],
  }
}

export async function seedFixtureExample(writer: CasObjectWriter): Promise<Ref> {
  return writer.putObject('fixture:fallback-example', new TextEncoder().encode(canonicalize(fixtureExample())), 'object')
}

/** Record results only after the owning fixture's independent assertions ran. */
export async function fixtureCriterionResults(
  request: VerifierRequest,
  storeRoot: string,
  results: readonly Omit<PublicCriterionResult, 'checks'>[],
): Promise<PublicCriterionResult[]> {
  const writer = await DomainStore.open(storeRoot)
  try {
    return await Promise.all(results.map(async result => {
      const criterion = request.task.spec.criteria.find(item => item.id === result.id)
      assert.ok(criterion)
      const checks = []
      for (const check of criterion.checks) {
        const report = sealPublicCheckReport({
          v: 1, operationId: request.operationId, contractDigest: request.task.digest,
          criterionId: criterion.id, checkId: check.checkId, recipeRef: check.recipeRef,
          inputDigests: request.inputs.map(ref => ref.digest),
          outputDigests: request.outputs.map(ref => ref.digest),
          exit: { code: 0, signal: null }, timedOut: false, verdict: result.verdict,
          data: { outputCount: request.outputs.length },
        })
        const reportRef = await writer.putObject(`${request.operationId}:${check.checkId}:report`,
          new TextEncoder().encode(canonicalize(report)), 'object')
        checks.push({ checkId: check.checkId, verdict: result.verdict, reportRef })
      }
      return { ...result, checks }
    }))
  } finally {
    await writer.close()
  }
}
