import type {
FactActor,JsonValue,MethodPatch,MethodRevision,Ref,TaskTemplate,
} from '@singularity/protocol'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import {
assertTaskTemplateInterface,
canonicalize,
computeDigest,
computeDigestBytes,
methodRevisionSchema,
parseJsonText,
parseMethodPatch,
parseProtocolValue,
seal,
sealMethodRevision,
taskExampleSchema,
validateInstanceSchema,
} from '@singularity/protocol'
import { ZodError } from 'zod'
import { MethodResourceError } from './errors.ts'

import { readMcpServers } from './mcp-resources.ts'
import { readTreeBundle } from './resource-bundle.ts'
import { METHOD_GUIDANCE_MAX_BYTES,TASK_EXAMPLE_MAX_BYTES } from './resources.ts'
import type { CommandService } from './service.ts'
import { readSkills,sameRef } from './skill-resources.ts'
import { readPublicTrace } from './trace.ts'

export class MethodPatchRejection extends Error {
  override readonly name = 'MethodPatchRejection'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface PatchPrecheckRequest {
  readonly service: CommandService
  readonly actor: FactActor
  readonly roundId: string
}

export type PatchPrecheckResult =
  | { readonly accepted: true; readonly candidate: MethodRevision; readonly candidateMethod: Ref; readonly precheckReceipt: Ref }
  | { readonly accepted: false; readonly reason: string; readonly precheckReceipt: Ref }

export async function submitMethodPatch(request: {
  readonly service: CommandService
  readonly actor: FactActor
  readonly roundId: string
  readonly value: unknown
}): Promise<Ref> {
  const patch = parseMethodPatch(request.value)
  for (const change of patch.changes) if (change.op === 'put-skill' && !isSkillName(change.skill.name))
    throw new MethodPatchRejection(`skill name ${JSON.stringify(change.skill.name)} is not DSH kebab-case`)
  const opened = request.service.facts().find(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === request.roundId)
  if (opened?.type !== 'rsi/round-opened') throw new Error('Round is not open')
  if (!sameRef(patch.base, opened.data.baseMethod)) throw new MethodPatchRejection('MethodPatch base differs from the pinned Round base')
  if (request.service.facts().some(fact => (fact.type === 'rsi/proposal-submitted' || fact.type === 'rsi/round-closed') && fact.data.roundId === request.roundId)) {
    throw new Error('Round already has a formal proposal or is closed')
  }
  const ref = await putJson(request.service, `round:${request.roundId}:patch`, patch)
  await request.service.commit({
    command: {
      v: 1, commandId: `round:${request.roundId}:proposal`, tool: 'rsi_submit_patch', toolVersion: 1,
      actor: request.actor, scope: {},
      input: { roundId: request.roundId, patch: ref },
    },
    type: 'rsi/proposal-submitted', data: { roundId: request.roundId, patch: ref },
  }, [])
  return ref
}

/** Apply all operations before checking final references; only candidate-ready publishes the revision. */
export async function precheckMethodPatch(request: PatchPrecheckRequest): Promise<PatchPrecheckResult> {
  const { service, actor, roundId } = request
  const proposal = service.facts().find(fact => fact.type === 'rsi/proposal-submitted' && fact.data.roundId === roundId)
  const opened = service.facts().find(fact => fact.type === 'rsi/round-opened' && fact.data.roundId === roundId)
  if (proposal?.type !== 'rsi/proposal-submitted' || opened?.type !== 'rsi/round-opened') {
    throw new Error('Round must have one formal proposal before precheck')
  }
  if (service.facts().some(fact => (fact.type === 'rsi/candidate-ready' || fact.type === 'rsi/round-closed') && fact.data.roundId === roundId)) {
    throw new Error('Round precheck is already complete')
  }
  // These are already frozen host inputs. Corruption here is not a candidate rejection.
  const patch = parseMethodPatch(await readJson(service, proposal.data.patch))
  const base = parseProtocolValue(methodRevisionSchema, await readJson(service, opened.data.baseMethod, 'method'))
  if (base.id !== opened.data.baseMethod.id || base.digest !== opened.data.baseMethod.digest) throw new Error('Pinned base Method identity is invalid')
  const trace = await readPublicTrace(service, opened.data.sourceTrace)
  let candidate: MethodRevision
  try {
    if (!sameRef(patch.base, opened.data.baseMethod)) throw new MethodPatchRejection('MethodPatch base differs from the pinned Round base')
    candidate = await applyPatch(service, base, patch, trace.authorizedObjects.map(entry => entry.ref))
  } catch (error) {
    if (!(error instanceof MethodPatchRejection || error instanceof MethodResourceError || error instanceof ZodError)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    const precheckReceipt = await putJson(service, `round:${roundId}:precheck`, seal('object', {
      v: 1, roundId, patch: proposal.data.patch, accepted: false, reason,
    }))
    await service.commit({
      command: {
        v: 1, commandId: `round:${roundId}:rejected`, tool: 'rsi_precheck', toolVersion: 1,
        actor, scope: {}, input: { roundId, precheckReceipt },
      },
      type: 'rsi/round-closed', data: { roundId, outcome: 'rejected', precheckReceipt, reason },
    }, [])
    return { accepted: false, reason, precheckReceipt }
  }
  const candidateMethod = await putJson(service, candidate.id, candidate, 'method')
  const precheckReceipt = await putJson(service, `round:${roundId}:precheck`, seal('object', {
    v: 1, roundId, patch: proposal.data.patch, accepted: true, candidateMethod,
    mcpManifests: candidate.tools.map(tool => tool.server.manifest),
  }))
  await service.commit({
    command: {
      v: 1, commandId: `round:${roundId}:candidate`, tool: 'rsi_precheck', toolVersion: 1,
      actor, scope: {}, input: { roundId, patch: proposal.data.patch, precheckReceipt, candidateMethod },
    },
    type: 'rsi/candidate-ready', data: { roundId, patch: proposal.data.patch, precheckReceipt, candidateMethod },
  }, [])
  return { accepted: true, candidate, candidateMethod, precheckReceipt }
}

async function applyPatch(
  service: CommandService, base: MethodRevision, patch: MethodPatch, publicRefs: readonly Ref[],
): Promise<MethodRevision> {
  const templates = new Map(base.templates.map(template => [template.id, template]))
  const skills = new Map(base.skills.map(skill => [skill.id, skill]))
  const tools = new Map(base.tools.map(tool => [tool.id, tool]))
  if (templates.size !== base.templates.length || skills.size !== base.skills.length || tools.size !== base.tools.length) throw new MethodPatchRejection('Base Method contains duplicate asset IDs')
  let entry = base.entryTemplateId
  const modified = new Set<string>()
  const allowed = [...publicRefs, ...base.templates.map(template => template.acceptancePolicy)]
  for (const change of patch.changes) {
    const id = change.op === 'set-entry' ? '' : 'id' in change ? change.id
      : change.op === 'put-template' ? change.template.id
        : change.op === 'put-skill' ? change.skill.id : change.server.id
    const namespace = change.op.includes('template') ? 'template' : change.op.includes('skill') ? 'skill' : 'server'
    const key = change.op === 'set-entry' ? 'entry' : `${namespace}:${id}`
    if (modified.has(key)) throw new MethodPatchRejection(`MethodPatch repeats asset operation ${key}`)
    modified.add(key)
    if (id === 'explore-child' || id.startsWith('platform:') || id.startsWith('singularity_') || id.startsWith('rsi_')) {
      throw new MethodPatchRejection('Method asset ID uses a reserved platform namespace')
    }
    switch (change.op) {
      case 'set-entry': entry = change.templateId ?? undefined; break
      case 'remove-template': templates.delete(change.id); break
      case 'remove-skill': skills.delete(change.id); break
      case 'remove-mcp-server': tools.delete(change.id); break
      case 'put-template': {
        const { guidance, example, ...template } = change.template
        if (!allowed.some(ref => sameRef(ref, template.acceptancePolicy))) throw new MethodPatchRejection('Template acceptancePolicy is outside the authorized public references')
        await service.readObject(template.acceptancePolicy)
        templates.set(template.id, {
          ...template,
          guidance: await putContent(service, { v: 1, text: guidance }),
          example: await putContent(service, example),
        })
        break
      }
      case 'put-skill': {
        const { files, ...skill } = change.skill
        if (!Object.hasOwn(files, 'SKILL.md')) throw new MethodPatchRejection('Skill draft must contain SKILL.md')
        skills.set(skill.id, { ...skill, bundle: await putBundle(service, files) })
        break
      }
      case 'put-mcp-server': {
        const { server, ...asset } = change.server
        if (server.exposedTools.length === 0) throw new MethodPatchRejection('MCP server must expose at least one tool schema')
        if (Object.hasOwn(server.manifest, 'digest') || Object.hasOwn(server.config, 'digest')) throw new MethodPatchRejection('MCP draft manifest/config digests are generated by the host')
        const bundle = await putBundle(service, server.files)
        tools.set(asset.id, { ...asset, server: {
          bundle, sourceFiles: bundle,
          manifest: await putContent(service, seal('object', server.manifest)),
          config: await putContent(service, seal('object', server.config)),
          transport: server.transport, capabilities: server.capabilities, exposedTools: server.exposedTools,
        } })
        break
      }
    }
  }
  const candidate = sealMethodRevision({
    v: 1, id: `method:${computeDigest('object', patch).slice(7)}`, parent: patch.base,
    ...(entry === undefined ? {} : { entryTemplateId: entry }),
    templates: [...templates.values()], skills: [...skills.values()], tools: [...tools.values()],
  })
  if (entry !== undefined && !templates.has(entry)) throw new MethodPatchRejection('Method entry template is dangling')
  const assetIds = [...templates.keys(), ...skills.keys(), ...tools.keys()]
  if (new Set(assetIds).size !== assetIds.length || assetIds.some(id => id.length === 0)) throw new MethodPatchRejection('Method asset IDs must be nonempty and unique')
  for (const template of candidate.templates) {
    assertTaskTemplateInterface(template)
    assertUnique(template.skills, 'template skill bindings')
    assertUnique(template.tools, 'template tool bindings')
    assertUnique(template.children.map(binding => binding.bindingId), 'child binding IDs')
    for (const id of template.skills) if (!skills.has(id)) throw new MethodPatchRejection('Template skill binding is dangling')
    for (const id of template.tools) if (!tools.has(id)) throw new MethodPatchRejection('Template MCP server binding is dangling')
    for (const binding of template.children) if (!templates.has(binding.templateId)) throw new MethodPatchRejection('Child template binding is dangling')
    const example = parseProtocolValue(taskExampleSchema, await readJson(service, template.example))
    assertProposalSchemaFields(template.instanceSchema)
    const guidance = await readJson(service, template.guidance)
    if (guidance === null || typeof guidance !== 'object' || Array.isArray(guidance)
      || Object.keys(guidance).length !== 2 || guidance['v'] !== 1 || typeof guidance['text'] !== 'string'
      || encoder.encode(guidance['text']).byteLength > METHOD_GUIDANCE_MAX_BYTES) throw new MethodPatchRejection('Template guidance must be a text object within 8 KiB')
    if (encoder.encode(canonicalize(example)).byteLength > TASK_EXAMPLE_MAX_BYTES) throw new MethodPatchRejection('Template example exceeds 12 KiB')
    const instance = { ...example, inputs: [] }
    const schema = validateInstanceSchema(template.instanceSchema, instance)
    if (!schema.valid) throw new MethodPatchRejection(`Template instanceSchema/example mismatch: ${schema.reason}`)
    await service.readObject(template.acceptancePolicy)
  }
  // Reuse the same deterministic catalog/bundle schema checks as normal Task composition.
  const catalogTemplate: TaskTemplate = {
    id: 'catalog-check', brief: '', guidance: patch.base, example: patch.base,
    instanceSchema: {}, requiredCriteria: [], requiredOutputs: [], acceptancePolicy: patch.base,
    skills: candidate.skills.map(skill => skill.id), tools: candidate.tools.map(tool => tool.id), children: [],
  }
  await readSkills(service, candidate, catalogTemplate, candidate.skills.map(skill => skill.bundle))
  await readMcpServers(service, candidate, catalogTemplate, candidate.tools.map(tool => tool.server.bundle))
  if (canonicalize(await effectiveContent(service, candidate)) === canonicalize(await effectiveContent(service, base))) throw new MethodPatchRejection('MethodPatch is a no-op')
  return candidate
}

function assertProposalSchemaFields(schema: JsonValue): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return
  const allowed = ['goal', 'acceptanceCriteria', 'inputs', 'localOutputs']
  const properties = schema['properties']
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    && Object.keys(properties).some(key => !allowed.includes(key))) throw new MethodPatchRejection('Template instanceSchema can constrain only TaskProposal fields')
  const required = schema['required']
  if (Array.isArray(required) && required.some(key => typeof key !== 'string' || !allowed.includes(key))) throw new MethodPatchRejection('Template instanceSchema cannot add host-owned Task fields')
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[keyword]
    if (Array.isArray(branches)) for (const branch of branches) assertProposalSchemaFields(branch)
  }
  if (Object.hasOwn(schema, 'not')) assertProposalSchemaFields(schema['not'])
}

async function effectiveContent(service: CommandService, method: MethodRevision): Promise<unknown> {
  const tree = async (ref: Ref) => {
    const bundle = await readTreeBundle(service, ref, 1024 * 1024)
    return bundle.manifest.files.map(file => ({ path: file.path,
      digest: computeDigestBytes('object', bundle.contents.get(file.path) ?? new Uint8Array()) }))
  }
  const catalog = new Map(method.templates.map(template => [template.id, template]))
  const reachable = new Set<string>()
  const pending = method.entryTemplateId === undefined ? [] : [method.entryTemplateId]
  for (const id of pending) {
    if (reachable.has(id)) continue
    reachable.add(id)
    pending.push(...catalog.get(id)?.children.map(binding => binding.templateId) ?? [])
  }
  const templates = method.templates.filter(template => reachable.has(template.id))
  const skillIds = new Set(templates.flatMap(template => template.skills))
  const toolIds = new Set(templates.flatMap(template => template.tools))
  return {
    entry: method.entryTemplateId ?? null,
    templates: templates.map(template => ({ ...template, guidance: template.guidance.digest, example: template.example.digest })),
    skills: await Promise.all(method.skills.filter(skill => skillIds.has(skill.id)).map(async skill => ({ ...skill, bundle: await tree(skill.bundle) }))),
    tools: await Promise.all(method.tools.filter(tool => toolIds.has(tool.id)).map(async tool => ({ ...tool, server: {
      ...tool.server, bundle: await tree(tool.server.bundle), sourceFiles: await tree(tool.server.sourceFiles),
      manifest: tool.server.manifest.digest, config: tool.server.config.digest,
    } }))),
  }
}

async function putBundle(service: CommandService, files: Readonly<Record<string, string>>): Promise<Ref> {
  const entries = []
  const paths = Object.keys(files).sort(comparePath)
  for (const path of paths) {
    if (path.includes('\u0000') || path.includes('\\') || path.startsWith('/')
      || path.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part === '.dsh' || part === '.codex')
      || /^[A-Za-z]:/.test(path)) throw new MethodPatchRejection('Bundle files must use relative paths inside the declared bundle')
    const bytes = encoder.encode(files[path])
    const object = await service.putObject(`file:${computeDigest('object', { path, text: files[path] }).slice(7)}`, bytes)
    entries.push({ path, bytes: bytes.byteLength, object })
  }
  const ref = await putContent(service, seal('object', { v: 1, kind: 'tree', files: entries }))
  await readTreeBundle(service, ref, 1024 * 1024)
  return ref
}

function comparePath(left: string, right: string): number {
  const a = left.split('/'), b = right.split('/')
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return a.length - b.length
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new MethodPatchRejection(`${label} must be unique`)
}

function putContent(service: CommandService, value: JsonValue): Promise<Ref> {
  return putJson(service, `object:${computeDigest('object', value).slice(7)}`, value)
}

function putJson(service: CommandService, id: string, value: unknown, domain: 'object' | 'method' = 'object'): Promise<Ref> {
  return service.putObject(id, encoder.encode(canonicalize(value)), domain)
}

async function readJson(service: CommandService, ref: Ref, domain: 'object' | 'method' = 'object'): Promise<JsonValue> {
  return parseJsonText(decoder.decode((await service.readObject(ref, domain)).bytes))
}
