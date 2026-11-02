import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'

import { MethodResourceError } from './errors.ts'
import type { FrozenSkillResource } from './skill-resources.ts'
import { SKILL_RESULT_MAX_BYTES } from './skill-resources.ts'

const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_SOURCE = 'runtime'

export interface MountedSkillResource extends FrozenSkillResource {
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
}

/** Scoped resources live under this Run workspace. */
export async function createSkillResourceRoot(workspace: string): Promise<string> {
  const parent = join(workspace, '.singularity')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = join(parent, 'skills')
  await mkdir(root, { mode: 0o700 })
  return root
}

export async function removeSkillResourceRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

/** Materializes only the already validated frozen bundle, without a filesystem provider. */
export async function materializeSkills(
  skills: readonly FrozenSkillResource[],
  root: string,
): Promise<readonly MountedSkillResource[]> {
  const mounted: MountedSkillResource[] = []
  for (const [index, skill] of skills.entries()) {
    const path = join(root, `${String(index)}-${skill.bundle.digest.slice('sha256:'.length)}`)
    const resourceBase = { kind: 'directory' as const, path }
    const resultBytes = Buffer.byteLength(renderSkillContent({ ...skill, provider: RUNTIME_PROVIDER, resourceBase }))
    if (resultBytes > SKILL_RESULT_MAX_BYTES) {
      throw new MethodResourceError('method', 'CONTRACT_INVALID',
        `skill ${JSON.stringify(skill.id)} result is ${String(resultBytes)} bytes, above the ${String(SKILL_RESULT_MAX_BYTES)} byte budget`)
    }
    await mkdir(path, { mode: 0o700 })
    for (const file of skill.bundleFiles) {
      const target = join(path, file.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, file.data, { flag: 'wx', mode: 0o444 })
    }
    mounted.push({ ...skill, resourceBase })
  }
  return mounted
}

/** Registers the frozen Method skills into the calling Agent scope only. */
export async function registerSkills(
  agentCtx: Context,
  skills: readonly MountedSkillResource[],
): Promise<void> {
  if (skills.length === 0) return
  await agentCtx.inject(['skills'], skillsCtx => {
    for (const skill of skills) {
      skillsCtx.skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        source: RUNTIME_SOURCE,
        invocation: { modelInvocable: true, userInvocable: false },
        resourceBase: skill.resourceBase,
      })
    }
  })
}
