import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillDefinition, SkillRegistry, SkillSummary } from '@deepseek-ai/dsh-skill'

import { assertSkillDiscovery, assertSkillToolAvailability } from '../src/agent-skills.ts'
import { MethodResourceError } from '../src/errors.ts'
import type { FrozenSkillResource } from '../src/skill-resources.ts'

const RESOURCE_BASE = {
  kind: 'opaque' as const,
  description: 'Referenced files are frozen in the skill bundle; this slice exposes only SKILL.md.',
}
const AGENT = { session: { id: 'session-agent-skills' } } as unknown as Agent

function frozenSkill(overrides: Partial<FrozenSkillResource> = {}): FrozenSkillResource {
  return {
    id: 'skill:a',
    name: 'skill-a',
    description: 'Frozen skill A.',
    bundle: { id: 'bundle:a', digest: `sha256:${'a'.repeat(64)}` },
    content: '# Skill A\n',
    resourceBase: RESOURCE_BASE,
    ...overrides,
  }
}

function summary(skill: FrozenSkillResource, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: false },
    source: 'runtime',
    provider: 'runtime',
    resourceBase: skill.resourceBase,
    ...overrides,
  }
}

function definition(skill: FrozenSkillResource, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    ...summary(skill),
    content: skill.content,
    ...overrides,
  }
}

function fakeContext(registry: SkillRegistry | undefined): Context {
  return {
    get(name: string) {
      return name === 'skills' ? registry : undefined
    },
  } as unknown as Context
}

function fakeRegistry(summaryValue: SkillSummary, definitionValue: SkillDefinition): SkillRegistry {
  return {
    snapshot: () => Promise.resolve({ skills: [summaryValue], complete: true }),
    get: () => Promise.resolve(definitionValue),
  } as unknown as SkillRegistry
}

async function expectResourceError(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof MethodResourceError)
    assert.equal(error.code, 'UNSUPPORTED_RESOURCES')
    return true
  })
}

void test('S4-A2 skill tool availability fails closed when the profile lacks the native loader', () => {
  const skill = frozenSkill()
  assert.doesNotThrow(() => { assertSkillToolAvailability(['bash'], []) })
  assert.doesNotThrow(() => { assertSkillToolAvailability(['bash', 'skill'], [skill]) })
  assert.throws(
    () => { assertSkillToolAvailability(['bash'], [skill]) },
    error => error instanceof MethodResourceError && error.code === 'UNSUPPORTED_RESOURCES',
  )
})

void test('S4-A2 skill discovery fails closed without the DSH registry', async () => {
  await expectResourceError(
    assertSkillDiscovery(fakeContext(undefined), AGENT, [frozenSkill()], '/workspace'),
  )
})

void test('S4-A2 skill discovery requires the frozen runtime/opaque winner and definition', async () => {
  const skill = frozenSkill()
  await assert.doesNotReject(
    assertSkillDiscovery(fakeContext(fakeRegistry(summary(skill), definition(skill))), AGENT, [skill], '/workspace'),
  )

  const wrongProvider = summary(skill, { provider: 'filesystem' })
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(wrongProvider, definition(skill))), AGENT, [skill], '/workspace'),
  )

  const wrongSource = summary(skill, { source: 'bundled' })
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(wrongSource, definition(skill))), AGENT, [skill], '/workspace'),
  )

  const wrongInvocation = summary(skill, { invocation: { modelInvocable: true, userInvocable: true } })
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(wrongInvocation, definition(skill))), AGENT, [skill], '/workspace'),
  )

  const wrongBase = summary(skill, {
    resourceBase: { kind: 'directory', path: '/tmp/skill-a' },
  })
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(wrongBase, definition(skill))), AGENT, [skill], '/workspace'),
  )

  const sameDescriptionWrongKind = {
    ...summary(skill),
    resourceBase: {
      kind: 'directory',
      path: '/tmp/skill-a',
      description: RESOURCE_BASE.description,
    },
  } as unknown as SkillSummary
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(sameDescriptionWrongKind, definition(skill))), AGENT, [skill], '/workspace'),
  )

  const wrongContent = definition(skill, { content: '# Other\n' })
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(summary(skill), wrongContent)), AGENT, [skill], '/workspace'),
  )

  const wrongDescription = definition(skill, { description: 'Other description.' })
  await expectResourceError(
    assertSkillDiscovery(fakeContext(fakeRegistry(summary(skill), wrongDescription)), AGENT, [skill], '/workspace'),
  )

  const extra = summary(frozenSkill({ name: 'unbound-skill' }))
  const registry = {
    snapshot: () => Promise.resolve({ skills: [summary(skill), extra], complete: true }),
    get: () => Promise.resolve(definition(skill)),
  } as unknown as SkillRegistry
  await expectResourceError(assertSkillDiscovery(fakeContext(registry), AGENT, [skill], '/workspace'))

  const incomplete = {
    snapshot: () => Promise.resolve({ skills: [summary(skill)], complete: false }),
    get: () => Promise.resolve(definition(skill)),
  } as unknown as SkillRegistry
  await expectResourceError(assertSkillDiscovery(fakeContext(incomplete), AGENT, [skill], '/workspace'))
})
