import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillRegistry, SkillSummary } from '@deepseek-ai/dsh-skill'

import { MethodResourceError } from './errors.ts'
import type { FrozenSkillResource } from './skill-resources.ts'

const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_SOURCE = 'runtime'

/** Registers the frozen Method skills into the calling Agent scope only. */
export async function registerSkills(
  agentCtx: Context,
  skills: readonly FrozenSkillResource[],
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

/** Requires the profile's native skill loader whenever the Method binds skills. */
export function assertSkillToolAvailability(
  globalToolNames: readonly string[],
  skills: readonly FrozenSkillResource[],
): void {
  if (skills.length > 0 && !globalToolNames.includes('skill')) {
    throw new MethodResourceError(
      'method',
      'UNSUPPORTED_RESOURCES',
      'profile does not mount the DSH skill tool required by Method skill bindings',
    )
  }
}

/**
 * Verifies the scoped discovery winner and its loaded definition are exactly
 * the runtime/opaque contributions registered from the frozen Method. A
 * project, filesystem, or directory-backed skill with the same name/content
 * therefore cannot pass by accident.
 */
export async function assertSkillDiscovery(
  agentCtx: Context,
  agent: Agent,
  skills: readonly FrozenSkillResource[],
  cwd: string,
): Promise<void> {
  const skillsService: SkillRegistry | undefined = agentCtx.get('skills', false)
  if (skillsService === undefined) {
    if (skills.length === 0) return
    throw new MethodResourceError(
      'method',
      'UNSUPPORTED_RESOURCES',
      'profile does not provide the DSH skill registry',
    )
  }
  const snapshot = await skillsService.snapshot({ scope: agent, cwd })
  if (!snapshot.complete) {
    throw new MethodResourceError(
      'method',
      'UNSUPPORTED_RESOURCES',
      'scoped skill discovery did not complete',
    )
  }
  const expected = new Set(skills.map(skill => skill.name))
  const actual = new Set(snapshot.skills.map(skill => skill.name))
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) {
    throw new MethodResourceError(
      'method',
      'UNSUPPORTED_RESOURCES',
      'scoped skill discovery must equal the template skill bindings; global or inherited skills are not mounted in this slice',
    )
  }
  for (const skill of snapshot.skills) {
    if (!isModelInvocable(skill)) {
      throw new MethodResourceError(
        'method',
        'UNSUPPORTED_RESOURCES',
        `bound skill ${JSON.stringify(skill.name)} is not model-invocable`,
      )
    }
    const expectedSkill = skills.find(candidate => candidate.name === skill.name)
    if (expectedSkill === undefined
      || skill.description !== expectedSkill.description
      || !matchesFrozenSkill(skill, expectedSkill)) {
      throw new MethodResourceError(
        'method',
        'UNSUPPORTED_RESOURCES',
        `discovered skill ${JSON.stringify(skill.name)} does not match the frozen Method asset`,
      )
    }
    const definition = await skillsService.get(skill.name, { scope: agent, cwd })
    if (definition === undefined
      || definition.description !== expectedSkill.description
      || definition.content !== expectedSkill.content
      || !matchesFrozenSkill(definition, expectedSkill)) {
      throw new MethodResourceError(
        'method',
        'UNSUPPORTED_RESOURCES',
        `loaded skill ${JSON.stringify(skill.name)} does not match the frozen Method bundle`,
      )
    }
  }
}

function matchesFrozenSkill(summary: SkillSummary, expected: FrozenSkillResource): boolean {
  const base = summary.resourceBase
  if (base === undefined || base.kind !== 'opaque') return false
  return summary.provider === RUNTIME_PROVIDER
    && summary.source === RUNTIME_SOURCE
    && summary.invocation.modelInvocable
    && !summary.invocation.userInvocable
    && base.description === expected.resourceBase.description
}
