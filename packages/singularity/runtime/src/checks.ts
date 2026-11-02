import { isUtf8 } from 'node:buffer'

import type {
  AcceptanceCheckPolicy, CheckPreview, CheckRecipe, ExecutableCheck, JsonObject,
  Ref, TaskLimits, TaskSpec,
} from '@singularity/protocol'
import {
  acceptanceCheckPolicySchema, AdmissionError, checkRecipeSchema, mergeAcceptanceChecks,
  parseJsonText, parseProtocolValue, sameRef, validateInstanceSchema,
} from '@singularity/protocol'

import type { CasObjectReader } from './workspace.ts'
import type { TaskReadQuery, TaskReadResult } from './tools.ts'
import { DecomposeError } from './errors.ts'

export interface DescribeCheckRequest {
  readonly recipeRef: Ref
  readonly recipe: CheckRecipe
  readonly check: ExecutableCheck
  /** Preview samples have paths but never fabricate authorized object refs. */
  readonly spec: Omit<TaskSpec, 'inputs'> & { readonly inputs: readonly { readonly path: string }[] }
  readonly limits: TaskLimits
}
export type DescribeCheck = (request: DescribeCheckRequest) => {
  readonly displayCommand: readonly string[]
  readonly expectedReport: JsonObject
}

export interface PreparedExecutableChecks {
  readonly policy: AcceptanceCheckPolicy
  readonly recipes: readonly { readonly ref: Ref; readonly recipe: CheckRecipe }[]
  readonly previews: readonly CheckPreview[]
}

/** Resolve only the frozen policy's public recipe refs; this is not a registry. */
export async function readAcceptanceChecks(reader: CasObjectReader, acceptance: Ref): Promise<Omit<PreparedExecutableChecks, 'previews'>> {
  const policy = parseProtocolValue(acceptanceCheckPolicySchema, await readJson(reader, acceptance))
  const recipes = []
  for (const ref of policy.checkRecipes) {
    const recipe = parseProtocolValue(checkRecipeSchema, await readJson(reader, ref))
    for (const dependency of recipe.dependencies) {
      if (!policy.checkResources.some(resource => sameRef(resource, dependency))) {
        throw new AdmissionError('INPUT_NOT_AUTHORIZED', `Recipe ${ref.id} dependency is outside its public acceptance policy`)
      }
      await reader.readObject(dependency, 'object')
    }
    recipes.push({ ref, recipe })
  }
  return { policy, recipes }
}

/** All checks resolve before root/child admission facts or model creation. */
export async function prepareExecutableChecks(input: {
  readonly reader: CasObjectReader
  readonly acceptance: Ref
  readonly spec: TaskSpec
  readonly limits: TaskLimits
  readonly describeCheck: DescribeCheck
}): Promise<PreparedExecutableChecks> {
  const resources = await readAcceptanceChecks(input.reader, input.acceptance)
  const previews: CheckPreview[] = []
  for (const { criterionId, check, asset } of bindExecutableChecks(input.spec, resources)) {
    const preview = input.describeCheck({ recipeRef: asset.ref, recipe: asset.recipe, check, spec: input.spec, limits: input.limits })
    previews.push({ criterionId, ...check,
      displayCommand: [...preview.displayCommand], expectedReport: preview.expectedReport })
  }
  return { ...resources, previews }
}

/** Policy and JSON Schema checks also apply to future Method examples. */
export function bindExecutableChecks(spec: TaskSpec, resources: Omit<PreparedExecutableChecks, 'previews'>) {
  mergeAcceptanceChecks(spec.criteria, [])
  const bindings = []
  for (const criterion of spec.criteria) {
    for (const check of criterion.checks) {
      const asset = resources.recipes.find(asset => sameRef(asset.ref, check.recipeRef))
      if (asset === undefined) throw new AdmissionError('INPUT_NOT_AUTHORIZED', `Check ${check.checkId} recipe is outside its acceptance policy`)
      const validation = validateInstanceSchema(asset.recipe.paramsSchema, check.params)
      if (!validation.valid) throw new AdmissionError('INVALID_ARGUMENT', `Check ${check.checkId} parameters: ${validation.reason}`)
      bindings.push({ criterionId: criterion.id, check, asset })
    }
  }
  return bindings
}

async function readJson(reader: CasObjectReader, ref: Ref) {
  return parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode((await reader.readObject(ref, 'object')).bytes))
}

/** Recipe resources are public only through a policy already visible to this Task. */
export async function readAcceptanceCheckResource(reader: CasObjectReader, acceptances: readonly Ref[], query: TaskReadQuery): Promise<TaskReadResult | undefined> {
  if (query.kind !== 'resource') return undefined
  for (const acceptance of acceptances) {
    const checks = await readAcceptanceChecks(reader, acceptance)
    const ref = [...checks.policy.checkRecipes, ...checks.policy.checkResources].find(ref => ref.id === query.id)
    if (ref === undefined) continue
    const { bytes } = await reader.readObject(ref, 'object')
    if (!isUtf8(bytes)) throw new DecomposeError('INVALID_ARGUMENT', 'The authorized check resource is binary; use its frozen domain execution interface.')
    const text = new TextDecoder().decode(bytes)
    const offset = Number(query.cursor ?? '0')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || query.page !== undefined) {
      throw new DecomposeError('INVALID_ARGUMENT', 'invalid check resource cursor')
    }
    const end = Math.min(text.length, offset + 4096)
    return { data: text.slice(offset, end), objectRef: ref, ...(end < text.length ? { nextCursor: String(end) } : {}) }
  }
  return undefined
}
