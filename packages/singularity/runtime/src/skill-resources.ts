import { escapeText, isSkillName, renderSkillContent } from '@deepseek-ai/dsh-skill'

import { sameRef } from '@singularity/protocol'
import type {
  MethodRevision,
  Ref,
  SkillAsset,
  TaskTemplate,
} from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import { TreeBundleError, readTreeBundle } from './resource-bundle.ts'
import type { TreeBundle } from './resource-bundle.ts'
import type { CasObjectReader } from './workspace.ts'

/** Discovery name/description cap from docs/framework.md §14.3. */
const SKILL_DISCOVERY_MAX_BYTES = 8 * 1024
/** Single read/skill result cap from docs/framework.md §14.3. */
export const SKILL_RESULT_MAX_BYTES = 16 * 1024
/** Deployment cap over one frozen skill bundle; not a protocol field. */
const SKILL_BUNDLE_MAX_BYTES = 1024 * 1024
const SKILL_INSTRUCTION_FILE = 'SKILL.md'

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()

/** One frozen skill bundle resolved from the pinned Method. */
export interface FrozenSkillResource {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly bundle: Ref
  readonly content: string
  readonly bundleFiles: readonly { readonly path: string; readonly data: Uint8Array }[]
}

/**
 * Resolves the template's ordered skill ids against the pinned Method and
 * verifies that the contract authorizes exactly their frozen bundle refs.
 * Bundle bytes and the rendered skill result remain read-only CAS data.
 */
export async function readSkills(
  reader: CasObjectReader,
  method: Pick<MethodRevision, 'skills'>,
  template: Pick<TaskTemplate, 'skills'>,
  contractRefs: readonly Ref[],
): Promise<readonly FrozenSkillResource[]> {
  const catalog = validateSkillCatalog(method.skills)
  const selected: SkillAsset[] = []
  const selectedIds = new Set<string>()
  for (const id of template.skills) {
    if (selectedIds.has(id)) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `template skill ${JSON.stringify(id)} is bound more than once`,
      )
    }
    selectedIds.add(id)
    const skill = catalog.get(id)
    if (skill === undefined) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `template skill ${JSON.stringify(id)} must resolve to exactly one skill in the pinned Method revision`,
      )
    }
    selected.push(skill)
  }

  const resources: FrozenSkillResource[] = []
  let discoveryBytes = 0
  for (const skill of selected) {
    let bundle: TreeBundle
    try {
      bundle = await readTreeBundle(reader, skill.bundle, SKILL_BUNDLE_MAX_BYTES)
    } catch (error) {
      if (!(error instanceof TreeBundleError)) throw error
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} bundle is invalid: ${error.message}`,
        { cause: error },
      )
    }
    const instructionBytes = bundle.contents.get(SKILL_INSTRUCTION_FILE)
    if (instructionBytes === undefined) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} bundle must contain ${SKILL_INSTRUCTION_FILE}`,
      )
    }
    let content: string
    try {
      content = strictUtf8.decode(instructionBytes)
    } catch (error) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} ${SKILL_INSTRUCTION_FILE} is not strict UTF-8`,
        { cause: error },
      )
    }
    if (content.trim().length === 0) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} ${SKILL_INSTRUCTION_FILE} must be non-empty`,
      )
    }
    const rendered = renderSkillContent({
      name: skill.name,
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: '.' },
      content,
    })
    const resultBytes = textEncoder.encode(rendered).byteLength
    if (resultBytes > SKILL_RESULT_MAX_BYTES) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} result is ${String(resultBytes)} bytes, above the ${String(SKILL_RESULT_MAX_BYTES)} byte budget`,
      )
    }
    discoveryBytes += textEncoder.encode(`- \`${skill.name}\`: ${escapeText(skill.description)}\n`).byteLength
    if (discoveryBytes > SKILL_DISCOVERY_MAX_BYTES) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill discovery is ${String(discoveryBytes)} bytes, above the ${String(SKILL_DISCOVERY_MAX_BYTES)} byte budget`,
      )
    }
    resources.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      bundle: skill.bundle,
      content,
      bundleFiles: [...bundle.contents].map(([path, data]) => ({ path, data })),
    })
  }

  if (contractRefs.length !== resources.length) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      'contract.resources.skills must equal the template skill bundles in order',
    )
  }
  for (let index = 0; index < resources.length; index += 1) {
    const expected = resources[index]?.bundle
    const actual = contractRefs[index]
    if (!sameRef(expected, actual)) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        'contract.resources.skills must equal the template skill bundles in order',
      )
    }
  }
  return resources
}

function validateSkillCatalog(skills: readonly SkillAsset[]): ReadonlyMap<string, SkillAsset> {
  const byId = new Map<string, SkillAsset>()
  const names = new Set<string>()
  const bundles = new Set<string>()
  for (const skill of skills) {
    if (skill.id.length === 0) {
      throw new MethodResourceError('method', 'CONTRACT_INVALID', 'skill id must be non-empty')
    }
    if (byId.has(skill.id)) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill id ${JSON.stringify(skill.id)} appears more than once in the pinned Method revision`,
      )
    }
    if (!isSkillName(skill.name)) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} name ${JSON.stringify(skill.name)} is not DSH kebab-case`,
      )
    }
    if (skill.description.trim().length === 0) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} description must be non-empty`,
      )
    }
    if (names.has(skill.name)) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill name ${JSON.stringify(skill.name)} appears more than once in the pinned Method revision`,
      )
    }
    names.add(skill.name)
    const bundleKey = `${skill.bundle.id}\u0000${skill.bundle.digest}`
    if (bundles.has(bundleKey)) {
      throw new MethodResourceError(
        'method',
        'CONTRACT_INVALID',
        `skill bundle ${JSON.stringify(skill.bundle.id)} appears more than once in the pinned Method revision`,
      )
    }
    bundles.add(bundleKey)
    byId.set(skill.id, skill)
  }
  return byId
}

export { sameRef }
