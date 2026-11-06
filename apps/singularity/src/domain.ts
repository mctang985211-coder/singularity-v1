import { readFile,readdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { JsonValue,Ref,TaskSpec,ToolAsset } from '@singularity/protocol'
import { canonicalize,closedObject,parseJsonText,parseProtocolValue,seal,taskSpecSchema,toolAssetSchema,workspaceRelativePathSchema,z } from '@singularity/protocol'
import type { CasObjectWriter } from '@singularity/runtime'

import { runExperiment } from './experiment.ts'

export interface ExperimentDomain {
  readonly id: string
  readonly source: Readonly<Record<string, unknown>>
  readonly cases: readonly { readonly id: string; readonly input: Readonly<Record<string, unknown>>; readonly description: string; readonly validation?: boolean }[]
  task(inputs: Readonly<Record<string, Ref | undefined>>): TaskSpec
  tools(writer: CasObjectWriter): Promise<ToolAsset[]>
  readonly acceptance?: 'review' | 'checks'
}

const file = workspaceRelativePathSchema
const taskDraftSchema = taskSpecSchema.extend({
  inputs: taskSpecSchema.shape.inputs.element.omit({ object: true }).extend({ source: file.optional() }).array(),
})
const domainManifestSchema = closedObject({
  v: z.literal(1), id: z.string().min(1), task: file,
  acceptance: z.enum(['review', 'checks']).optional(),
  source: z.record(z.string(), file),
  cases: z.array(closedObject({ id: z.string().min(1), description: z.string(), inputs: z.record(z.string(), file), validation: z.boolean().optional() })),
  tools: file.optional(),
})
type TaskDraft = z.infer<typeof taskDraftSchema>
const toolDraftSchema = toolAssetSchema.extend({
  server: toolAssetSchema.shape.server.omit({ bundle: true, sourceFiles: true, transport: true }).extend({
    source: file, manifest: file, config: file,
  }),
})

/** Loads public domain files; Task, Method, model and budget authority stay in the host. */
export async function loadDomainPackage(directory: string): Promise<ExperimentDomain> {
  const root = resolve(directory)
  const manifest = parseProtocolValue(domainManifestSchema, await readJson(join(root, 'domain.json')))
  const draft = parseProtocolValue(taskDraftSchema, await readJson(join(root, manifest.task)))
  return {
    id: manifest.id,
    source: await readInputs(root, draft, manifest.source),
    cases: await Promise.all(manifest.cases.map(async definition => ({
      id: definition.id, description: definition.description,
      ...(definition.validation === undefined ? {} : { validation: definition.validation }),
      input: await readInputs(root, draft, definition.inputs),
    }))),
    task: refs => parseProtocolValue(taskSpecSchema, { ...draft,
      inputs: draft.inputs.map(input => {
        const object = refs[input.id]
        if (object === undefined) throw new Error(`Domain input ${JSON.stringify(input.id)} is not bound`)
        const declaration: Record<string, JsonValue> = { ...input, object }
        delete declaration['source']
        return declaration
      }) }),
    tools: writer => manifest.tools === undefined ? Promise.resolve([]) : freezeTools(writer, root, manifest.tools),
    acceptance: manifest.acceptance ?? 'review',
  }
}

export async function runDomainPackage(root: string, directory: string, budget?: Parameters<typeof runExperiment>[2]): Promise<void> {
  await runExperiment(root, await loadDomainPackage(directory), budget)
}

async function readInputs(root: string, draft: TaskDraft, overrides: Readonly<Record<string, string | undefined>>) {
  const declarations = new Map(draft.inputs.map(input => [input.id, input]))
  for (const id of Object.keys(overrides)) {
    if (!declarations.has(id)) throw new Error(`Domain case supplies undeclared input ${JSON.stringify(id)}`)
  }
  const result: Record<string, Uint8Array> = {}
  for (const input of draft.inputs) {
    const source = overrides[input.id] ?? input.source
    if (source === undefined) throw new Error(`Domain input ${JSON.stringify(input.id)} needs a source file`)
    result[input.id] = await readFile(join(root, source))
  }
  return result
}

async function freezeTools(writer: CasObjectWriter, root: string, path: string): Promise<ToolAsset[]> {
  const drafts = parseProtocolValue(z.array(toolDraftSchema), await readJson(join(root, path)))
  const tools: ToolAsset[] = []
  for (const draft of drafts) {
    const { source, manifest, config, ...server } = draft.server
    const bundle = await freezeDirectory(writer, `${draft.id}:source`, join(root, source))
    const configValue = await readJson(join(root, config))
    const transport = parseProtocolValue(z.looseObject({ transport: z.enum(['stdio', 'streamable-http']) }), configValue).transport
    tools.push({ ...draft, server: { ...server, bundle, sourceFiles: bundle, transport,
      manifest: await putJson(writer, `${draft.id}:manifest`, await readJson(join(root, manifest))),
      config: await putJson(writer, `${draft.id}:config`, configValue),
    } })
  }
  return tools
}

async function freezeDirectory(writer: CasObjectWriter, id: string, root: string): Promise<Ref> {
  const files: { path: string; bytes: number; object: Ref }[] = []
  let total = 0
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(join(directory, entry.name), path)
      else if (entry.isFile()) {
        const bytes = await readFile(join(directory, entry.name))
        total += bytes.byteLength
        if (total > 1024 * 1024) throw new Error(`Domain MCP source ${JSON.stringify(id)} exceeds 1 MiB`)
        files.push({ path, bytes: bytes.byteLength, object: await writer.putObject(`${id}:${path}`, bytes) })
      } else throw new Error(`Domain MCP source ${JSON.stringify(path)} must be a regular file or directory`)
    }
  }
  await visit(root, '')
  return putJson(writer, id, seal('object', { v: 1, kind: 'tree', files }))
}

async function readJson(path: string): Promise<JsonValue> {
  return parseJsonText(await readFile(path, 'utf8'))
}

function putJson(writer: CasObjectWriter, id: string, value: JsonValue): Promise<Ref> {
  return writer.putObject(id, new TextEncoder().encode(canonicalize(value)))
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await runDomainPackage(resolve(process.argv[2]), resolve(process.argv[3]))
}
