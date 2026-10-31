import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

import {
  canonicalize,
  computeDigest,
  methodRevisionSchema,
  parseJsonText,
  parseProtocolValue,
  taskTemplateSchema,
  verifyDigest,
} from '@singularity/protocol'
import type {
  CompositionPayload,
  Digest,
  JsonValue,
  MethodRevision,
  Ref,
  TaskContract,
  TaskTemplate,
} from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import { readMcpServers } from './mcp-resources.ts'
import type { FrozenMcpServer } from './mcp-resources.ts'
import { readSkills, sameRef } from './skill-resources.ts'
import type { FrozenSkillResource } from './skill-resources.ts'
import type { CasObjectReader } from './workspace.ts'

export { MethodResourceError } from './errors.ts'

/** Host-injected capability that renders the actual scoped DSH system prompt. */
export const PLATFORM_PROMPT_SERVICE = 'singularity.platformPrompt'

export interface PlatformPromptRenderer {
  render(agentCtx: Context, agent: Agent): Promise<string>
}

/** Fixed DSH section identity shared by host assembly and Agent setup. */
export const METHOD_GUIDANCE_SECTION = 'singularity:method-guidance'
export const METHOD_GUIDANCE_ORDER = 200

/** Fixed own-guidance cap from docs/framework.md §14.3. */
const METHOD_GUIDANCE_MAX_BYTES = 8 * 1024

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()

/** Frozen Method/template/guidance/skill/MCP view consumed by one Run. */
export interface FrozenMethodResources {
  readonly method: MethodRevision
  readonly template: TaskTemplate
  readonly guidance: Ref
  readonly guidanceText: string
  readonly skills: readonly FrozenSkillResource[]
  readonly mcpServers: readonly FrozenMcpServer[]
}

/**
 * Reads the Method revision pinned by the contract, resolves exactly its own
 * template, and decodes the template guidance as the frozen text object.
 * Every failure is closed before any Agent, verifier, or journal append.
 */
export async function loadMethodResources(
  reader: CasObjectReader,
  contract: TaskContract,
): Promise<FrozenMethodResources> {
  const method = await readMethodRevision(reader, contract.method)
  if (contract.template.digest !== contract.method.digest
    || contract.template.digest !== method.digest) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      'contract.template must reference the same Method revision as contract.method',
    )
  }
  const matches = method.templates.filter(template => template.id === contract.template.id)
  if (matches.length !== 1) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      `contract.template ${JSON.stringify(contract.template.id)} must resolve to exactly one template in the pinned Method revision`,
    )
  }
  const template = matches[0]
  const skills = await readSkills(reader, method, template, contract.resources.skills)
  const mcpServers = await readMcpServers(
    reader,
    method,
    template,
    contract.resources.mcpServers,
  )
  const guidanceText = await readGuidance(reader, template.guidance)
  return {
    method,
    template,
    guidance: template.guidance,
    guidanceText,
    skills,
    mcpServers,
  }
}

/**
 * Re-verifies that the frozen Composition carries the same template body,
 * guidance, skill bundles, and MCP server identities that the pinned Method
 * revision defines. This is a semantic check on top of CAS ref validation,
 * used by host assembly and recovery.
 */
export async function assertCompositionResources(
  reader: CasObjectReader,
  resources: FrozenMethodResources,
  composition: Pick<CompositionPayload, 'guidance' | 'template' | 'skills' | 'mcpServers'>,
): Promise<void> {
  const value = await readJson(
    reader,
    composition.template,
    'object',
    'Composition template',
    'COMPOSITION_MISMATCH',
  )
  let template: TaskTemplate
  try {
    template = parseProtocolValue(taskTemplateSchema, value)
  } catch (error) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'Composition template is not a strict TaskTemplate',
      { cause: error },
    )
  }
  if (computeDigest('object', template as unknown as JsonValue) !== composition.template.digest) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'Composition template digest is not the structured object digest',
    )
  }
  if (template.id !== resources.template.id
    || canonicalize(template as unknown as JsonValue)
      !== canonicalize(resources.template as unknown as JsonValue)) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'Composition template does not equal the current template in the pinned Method revision',
    )
  }
  if (composition.guidance === undefined
    || composition.guidance.id !== resources.guidance.id
    || composition.guidance.digest !== resources.guidance.digest) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'Composition guidance must equal the current template guidance in the pinned Method revision',
    )
  }
  if (composition.skills.length !== resources.skills.length) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'Composition skills must equal the current template skill bundles in the pinned Method revision',
    )
  }
  for (let index = 0; index < resources.skills.length; index += 1) {
    const expected = resources.skills[index]?.bundle
    const actual = composition.skills[index]
    if (!sameRef(expected, actual)) {
      throw new MethodResourceError(
        'composition',
        'COMPOSITION_MISMATCH',
        'Composition skills must equal the current template skill bundles in the pinned Method revision',
      )
    }
  }
  if (composition.mcpServers.length !== resources.mcpServers.length) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      'Composition MCP servers must equal the current template server bundles in the pinned Method revision',
    )
  }
  for (let index = 0; index < resources.mcpServers.length; index += 1) {
    const expected = resources.mcpServers[index]
    const actual = composition.mcpServers[index]
    if (!sameRef(expected.manifest, actual.manifest)
      || !sameRef(expected.bundle, actual.bundle)
      || !sameRef(expected.schema, actual.schema)
      || !sameRef(expected.config, actual.config)
      || expected.transport !== actual.transport
      || !sameStrings(expected.capabilities, actual.capabilities)) {
      throw new MethodResourceError(
        'composition',
        'COMPOSITION_MISMATCH',
        'Composition MCP servers must equal the current template server bundles in the pinned Method revision',
      )
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Re-verifies the actual scoped assembly against the frozen platform prompt digest. */
export function assertPlatformPrompt(text: string, expected: Digest): void {
  const actual = computeDigest('object', { v: 1, text })
  if (actual !== expected) {
    throw new MethodResourceError(
      'composition',
      'COMPOSITION_MISMATCH',
      `actual scoped platform prompt digest ${actual} does not match the frozen Composition ${expected}`,
    )
  }
}

async function readMethodRevision(
  reader: CasObjectReader,
  ref: Ref,
): Promise<MethodRevision> {
  const value = await readJson(
    reader,
    ref,
    'method',
    'frozen MethodRevision',
    'CONTRACT_INVALID',
  )
  let method: MethodRevision
  try {
    method = parseProtocolValue(methodRevisionSchema, value)
  } catch (error) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      'frozen MethodRevision is not a strict Method revision',
      { cause: error },
    )
  }
  if (method.id !== ref.id || method.digest !== ref.digest || !verifyDigest('method', method)) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      'frozen MethodRevision id or digest does not match contract.method',
    )
  }
  return method
}

async function readGuidance(reader: CasObjectReader, ref: Ref): Promise<string> {
  const value = await readJson(reader, ref, 'object', 'Method guidance', 'CONTRACT_INVALID')
  if (!isGuidanceText(value)) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      'Method guidance must be the strict text object { v: 1, text: string }',
    )
  }
  if (computeDigest('object', value) !== ref.digest) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      'Method guidance digest is not the structured object digest',
    )
  }
  const bytes = textEncoder.encode(value.text).byteLength
  if (bytes > METHOD_GUIDANCE_MAX_BYTES) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      `Method guidance is ${String(bytes)} bytes, above the ${String(METHOD_GUIDANCE_MAX_BYTES)} byte budget`,
    )
  }
  return value.text
}

function isGuidanceText(value: JsonValue): value is { readonly v: 1; readonly text: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as { readonly [key: string]: JsonValue }
  const keys = Object.keys(record)
  return keys.length === 2
    && keys.includes('v')
    && keys.includes('text')
    && record['v'] === 1
    && typeof record['text'] === 'string'
}

async function readJson(
  reader: CasObjectReader,
  ref: Ref,
  domain: 'object' | 'method',
  label: string,
  code: 'CONTRACT_INVALID' | 'COMPOSITION_MISMATCH',
): Promise<JsonValue> {
  const resource = code === 'COMPOSITION_MISMATCH' ? 'composition' : 'method'
  let bytes: Uint8Array
  try {
    ({ bytes } = await reader.readObject(ref, domain))
  } catch (error) {
    throw new MethodResourceError(resource, code, `${label} CAS object is missing or unreadable`, { cause: error })
  }
  let text: string
  try {
    text = strictUtf8.decode(bytes)
  } catch (error) {
    throw new MethodResourceError(resource, code, `${label} is not strict UTF-8`, { cause: error })
  }
  try {
    return parseJsonText(text)
  } catch (error) {
    throw new MethodResourceError(resource, code, `${label} is not strict JSON`, { cause: error })
  }
}
