import type { PublicReceipt, Ref, TaskContract } from '@singularity/protocol'
import { canonicalize, computeDigest, sealPublicCheckReport } from '@singularity/protocol'
import type { DescribeCheck } from '../src/checks.ts'
import type { CasObjectWriter } from '../src/workspace.ts'

/** Protocol identity fixture; this does not claim real domain execution. */
export const checkRecipe = {
  v: 1 as const, name: 'protocol-fixture', entrypoint: ['fixture-check'], dependencies: [],
  paramsSchema: { type: 'object' }, resultSchema: { type: 'object', properties: { fixture: { type: 'boolean' } }, required: ['fixture'] },
  publicDataPolicy: 'Protocol fixture has no hidden data.', passRule: 'The test controls the result.', maxWallClockMs: 1000,
}
export const checkRecipeRef = { id: 'fixture:check', digest: computeDigest('object', checkRecipe) }
export const checkPolicy = { checkRecipes: [checkRecipeRef], checkResources: [] }
export const checkPolicyRef = { id: 'fixture:policy', digest: computeDigest('object', checkPolicy) }
export const describeCheck: DescribeCheck = ({ recipe, check }) => ({
  displayCommand: [...recipe.entrypoint, check.checkId], expectedReport: { verdict: 'pass' },
})
export const preparedChecks = { policy: checkPolicy, recipes: [{ ref: checkRecipeRef, recipe: checkRecipe }], previews: [] }

export async function putCheckAssets(writer: CasObjectWriter): Promise<void> {
  for (const [ref, value] of [[checkRecipeRef, checkRecipe], [checkPolicyRef, checkPolicy]] as const) {
    await writer.putObject(ref.id, new TextEncoder().encode(canonicalize(value)), 'object')
  }
}

export async function withCheckReports(writer: CasObjectWriter, contract: TaskContract, receipt: PublicReceipt): Promise<PublicReceipt['criteria']> {
  return Promise.all(receipt.criteria.map(async criterion => ({ ...criterion, checks: await Promise.all(
    contract.spec.criteria.filter(item => item.id === criterion.id)[0].checks.map(async check => {
      const report = sealPublicCheckReport({ v: 1, operationId: receipt.operationId,
        contractDigest: contract.digest, criterionId: criterion.id, checkId: check.checkId, recipeRef: check.recipeRef,
        inputDigests: receipt.inputDigests, outputDigests: receipt.outputDigests, exit: receipt.exit,
        timedOut: receipt.timedOut, verdict: criterion.verdict, data: { fixture: true } })
      const reportRef: Ref = await writer.putObject(`${receipt.operationId}:check:${check.checkId}`,
        new TextEncoder().encode(canonicalize(report)), 'object')
      return { checkId: check.checkId, verdict: criterion.verdict, reportRef }
    }),
  ) })))
}
