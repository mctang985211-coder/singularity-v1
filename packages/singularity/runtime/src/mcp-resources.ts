import { z } from 'zod'
import type {
JsonObject,
JsonValue,
MethodRevision,
Ref,
TaskTemplate,
ToolAsset,
} from '@singularity/protocol'
import {
computeDigest,
parseJsonText,
seal,workspaceRelativePathSchema,
} from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import { TreeBundleError,readTreeBundle } from './resource-bundle.ts'
import type { CasObjectReader } from './workspace.ts'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const TOOL_NAME = /^[A-Za-z0-9_]+$/
const MAX_BUNDLE_BYTES = 1024 * 1024
/** Native DSH resource tools exposed once at least one MCP server is mounted. */
export const MCP_RESOURCE_TOOL_NAMES = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

// Trusted deployment assets: parse only the fields consumed here. Extra
// metadata and capability descriptions do not grant or restrict OS authority.
const manifestSchema = z.object({
  serverName: z.string().regex(SERVER_NAME),
  transport: z.enum(['stdio', 'streamable-http']),
  instructions: z.string().refine(text => Buffer.byteLength(text, 'utf8') <= 8192, 'MCP instructions exceed 8KiB'),
  entrypoint: workspaceRelativePathSchema,
  limits: z.object({ maxBundleBytes: z.number().int().positive().max(MAX_BUNDLE_BYTES) }),
})
const configFields = {
  toolCallTimeoutMs: z.number().int().positive(),
  maxInstructionBytes: z.number().int().positive(),
}
const configSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), command: z.string().min(1),
    args: z.array(z.string()), env: z.record(z.string(), z.string()), ...configFields }),
  z.object({ transport: z.literal('streamable-http'),
    url: z.url({ protocol: /^https?$/ }).pipe(z.string().refine(value => {
      const url = new URL(value)
      return url.username === '' && url.password === ''
    }, 'credentials belong in deployment, outside public Method assets')),
    headers: z.record(z.string(), z.string()), ...configFields }),
])
type McpManifest = z.infer<typeof manifestSchema>
type McpTransportConfig = z.infer<typeof configSchema>

interface CatalogTool {
  readonly asset: ToolAsset
  readonly manifest: McpManifest
  readonly manifestRef: Ref
  readonly bundle: Awaited<ReturnType<typeof readTreeBundle>>
  readonly sourceFiles: Awaited<ReturnType<typeof readTreeBundle>>
  readonly configValue: McpTransportConfig
}

/** One frozen MCP server consumed by host composition and Agent setup. */
export interface FrozenMcpServer {
  readonly id: string
  readonly serverName: string
  readonly transport: McpManifest['transport']
  readonly capabilities: readonly string[]
  readonly exposedTools: ToolAsset['server']['exposedTools']
  readonly publicToolNames: readonly string[]
  readonly manifest: Ref
  readonly bundle: Ref
  readonly sourceFiles: Ref
  readonly config: Ref
  readonly schema: Ref
  readonly schemaPayload: JsonObject
  readonly instructions: string
  readonly entrypoint: string
  readonly configValue: McpTransportConfig
  readonly bundleFiles: readonly { readonly path: string; readonly data: Uint8Array }[]
}

/** MCP tools/resources admitted for one Run's dispatch guard. */
export interface McpDispatchPlan {
  readonly serverNames: readonly string[]
  readonly publicToolNames: readonly string[]
  readonly resourceToolNames: readonly string[]
}

/**
 * Resolves the template's ordered tool ids against the pinned Method, validates
 * the complete Method tool catalog, and verifies the contract authorizes
 * exactly the bound server bundle refs. Both stdio and deployment HTTP/HTTPS
 * streamable-http transports use the same identity and deployment shape.
 */
export async function readMcpServers(
  reader: CasObjectReader,
  method: Pick<MethodRevision, 'tools'>,
  template: TaskTemplate,
  contractRefs: readonly Ref[],
): Promise<readonly FrozenMcpServer[]> {
  const catalog = await readToolCatalog(reader, method.tools)
  const selected: CatalogTool[] = []
  const selectedIds = new Set<string>()
  for (const id of template.tools) {
    if (selectedIds.has(id)) {
      fail('CONTRACT_INVALID', `template tool ${JSON.stringify(id)} is bound more than once`)
    }
    selectedIds.add(id)
    const tool = catalog.get(id)
    if (tool === undefined) {
      fail('CONTRACT_INVALID', `template tool ${JSON.stringify(id)} must resolve to exactly one MCP server in the pinned Method revision`)
    }
    selected.push(tool)
  }

  const servers: FrozenMcpServer[] = []
  const publicNames = new Set<string>()
  for (const tool of selected) {
    const bundle = tool.bundle
    const configValue = tool.configValue
    const schemaPayload = deriveSchema(tool.manifest.serverName, tool.asset.server.exposedTools)
    const schema: Ref = {
      id: `${tool.asset.id}:schema`,
      digest: computeDigest('object', schemaPayload),
    }
    const expectedNames = tool.asset.server.exposedTools.map(exposed => publicToolName(tool.manifest.serverName, exposed.name))
    for (const name of expectedNames) {
      if (publicNames.has(name)) {
        fail('CONTRACT_INVALID', `MCP public tool name ${JSON.stringify(name)} is bound more than once`)
      }
      publicNames.add(name)
    }
    servers.push({
      id: tool.asset.id,
      serverName: tool.manifest.serverName,
      transport: tool.manifest.transport,
      capabilities: [...tool.asset.server.capabilities],
      exposedTools: tool.asset.server.exposedTools,
      publicToolNames: expectedNames,
      manifest: tool.manifestRef,
      bundle: tool.asset.server.bundle,
      sourceFiles: tool.asset.server.sourceFiles,
      config: tool.asset.server.config,
      schema,
      schemaPayload,
      instructions: tool.manifest.instructions,
      entrypoint: tool.manifest.entrypoint,
      configValue,
      bundleFiles: bundle.manifest.files.map(file => ({
        path: file.path,
        data: bundle.contents.get(file.path) as Uint8Array,
      })),
    })
  }

  if (contractRefs.length !== servers.length) {
    fail('CONTRACT_INVALID', 'contract.resources.mcpServers must equal the template server bundles in order')
  }
  for (let index = 0; index < servers.length; index += 1) {
    const expected = servers[index]?.bundle
    const actual = contractRefs[index]
    if (expected.id !== actual.id || expected.digest !== actual.digest) {
      fail('CONTRACT_INVALID', 'contract.resources.mcpServers must equal the template server bundles in order')
    }
  }
  return servers
}

export function mcpDispatchPlan(servers: readonly FrozenMcpServer[]): McpDispatchPlan {
  return {
    serverNames: servers.map(server => server.serverName),
    publicToolNames: servers.flatMap(server => server.publicToolNames),
    resourceToolNames: servers.length > 0 ? [...MCP_RESOURCE_TOOL_NAMES] : [],
  }
}

/**
 * Host-side projection of the MCP sections DSH assembles from mounted servers.
 * The runtime compares the complete actual scoped prompt against the frozen
 * digest; this helper only supplies the same section names/order/text.
 */
export function mcpPromptSections(
  servers: readonly FrozenMcpServer[],
  order: number,
): readonly {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly interpolate: false
}[] {
  if (servers.length === 0) return []
  const names = servers.map(server => server.serverName).sort()
  const sections = [{
    name: 'mcp-resource-servers',
    order,
    interpolate: false as const,
    text: `## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ${JSON.stringify(names)}.`,
  }]
  for (const server of servers) {
    const text = instructionSectionText(server.serverName, server.instructions)
    if (text.length === 0) continue
    sections.push({
      name: `mcp:${server.serverName}`,
      order,
      interpolate: false as const,
      text,
    })
  }
  return sections
}

/** Composition fields derived from one frozen server. */
export function mcpCompositionEntry(server: FrozenMcpServer): {
  readonly manifest: Ref
  readonly bundle: Ref
  readonly schema: Ref
  readonly config: Ref
  readonly transport: 'stdio' | 'streamable-http'
  readonly capabilities: string[]
} {
  return {
    manifest: server.manifest,
    bundle: server.bundle,
    schema: server.schema,
    config: server.config,
    transport: server.transport,
    capabilities: [...server.capabilities],
  }
}

async function readToolCatalog(
  reader: CasObjectReader,
  tools: readonly ToolAsset[],
): Promise<ReadonlyMap<string, CatalogTool>> {
  const catalog = new Map<string, CatalogTool>()
  const serverNames = new Set<string>()
  const bundleKeys = new Set<string>()
  const publicNames = new Set<string>()
  for (const asset of tools) {
    if (asset.id.length === 0) fail('CONTRACT_INVALID', 'Method tool id must be non-empty')
    if (catalog.has(asset.id)) {
      fail('CONTRACT_INVALID', `Method tool id ${JSON.stringify(asset.id)} appears more than once`)
    }
    const bundleKey = `${asset.server.bundle.id}\u0000${asset.server.bundle.digest}`
    if (bundleKeys.has(bundleKey)) {
      fail('CONTRACT_INVALID', `MCP server bundle ${JSON.stringify(asset.server.bundle.id)} appears more than once`)
    }
    bundleKeys.add(bundleKey)
    const manifestRef = asset.server.manifest
    const manifest = parseAsset(manifestSchema,
      await readJson(reader, manifestRef, `MCP server ${JSON.stringify(asset.id)} manifest`))
    if (manifest.transport !== asset.server.transport) fail('CONTRACT_INVALID', 'MCP manifest transport differs from ToolAsset')
    if (serverNames.has(manifest.serverName)) {
      fail('CONTRACT_INVALID', `MCP serverName ${JSON.stringify(manifest.serverName)} appears more than once`)
    }
    serverNames.add(manifest.serverName)
    const seenTools = new Set<string>()
    for (const exposed of asset.server.exposedTools) {
      if (!TOOL_NAME.test(exposed.name)) {
        fail('UNSUPPORTED_RESOURCES', `MCP tool name ${JSON.stringify(exposed.name)} is not a clean [A-Za-z0-9_] name`)
      }
      if (seenTools.has(exposed.name)) {
        fail('CONTRACT_INVALID', `MCP server ${JSON.stringify(manifest.serverName)} exposes tool ${JSON.stringify(exposed.name)} more than once`)
      }
      seenTools.add(exposed.name)
      const name = publicToolName(manifest.serverName, exposed.name)
      if (publicNames.has(name)) {
        fail('CONTRACT_INVALID', `MCP public tool name ${JSON.stringify(name)} appears more than once`)
      }
      publicNames.add(name)
    }
    const bundle = await readTree(
      reader,
      asset.server.bundle,
      `MCP server ${JSON.stringify(manifest.serverName)} bundle`,
      manifest.limits.maxBundleBytes,
    )
    const sourceFiles = await readTree(
      reader,
      asset.server.sourceFiles,
      `MCP server ${JSON.stringify(manifest.serverName)} sourceFiles`,
      manifest.limits.maxBundleBytes,
    )
    if (!bundle.contents.has(manifest.entrypoint)) {
      fail('CONTRACT_INVALID', `MCP server ${JSON.stringify(manifest.serverName)} bundle must contain entrypoint ${JSON.stringify(manifest.entrypoint)}`)
    }
    const configObject = await readJson(
      reader,
      asset.server.config,
      `MCP server ${JSON.stringify(manifest.serverName)} config`,
    )
    const configValue = parseAsset(configSchema, configObject)
    if (configValue.transport !== manifest.transport) fail('CONTRACT_INVALID', 'MCP config transport differs from manifest')
    catalog.set(asset.id, { asset, manifest, manifestRef, bundle, sourceFiles, configValue })
  }
  return catalog
}

function deriveSchema(
  serverName: string,
  exposedTools: ToolAsset['server']['exposedTools'],
): JsonObject {
  const tools = exposedTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.output === undefined ? {} : { output: tool.output }),
  }))
  return seal('object', {
    v: 1,
    serverName,
    tools: tools as unknown as JsonValue,
  }) as unknown as JsonObject
}

function instructionSectionText(serverName: string, instructions: string): string {
  const body = instructions.trimEnd()
  return body.length === 0 ? '' : `### MCP server: ${serverName}\n\n${body}`
}

function publicToolName(serverName: string, rawName: string): string {
  if (!TOOL_NAME.test(rawName)) {
    fail('UNSUPPORTED_RESOURCES', `MCP tool name ${JSON.stringify(rawName)} is not a clean [A-Za-z0-9_] name`)
  }
  const name = `mcp__${serverName}__${rawName}`
  if (name.length > 64) {
    fail('UNSUPPORTED_RESOURCES', `MCP public tool name ${JSON.stringify(name)} exceeds 64 characters`)
  }
  return name
}

async function readJson(reader: CasObjectReader, ref: Ref, label: string): Promise<JsonObject> {
  const { bytes } = await reader.readObject(ref, 'object')
  let text: string
  try {
    text = strictUtf8.decode(bytes)
  } catch (error) {
    fail('CONTRACT_INVALID', `${label} is not strict UTF-8`, error)
  }
  let value: JsonValue
  try {
    value = parseJsonText(text)
  } catch (error) {
    fail('CONTRACT_INVALID', `${label} is not strict JSON`, error)
  }
  if (!isRecord(value)) fail('CONTRACT_INVALID', `${label} must be a JSON object`)
  return value
}

async function readTree(
  reader: CasObjectReader,
  ref: Ref,
  label: string,
  maxBytes: number,
) {
  try {
    return await readTreeBundle(reader, ref, maxBytes)
  } catch (error) {
    if (error instanceof TreeBundleError) fail('CONTRACT_INVALID', `${label} is invalid: ${error.message}`, error)
    throw error
  }
}

function parseAsset<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value)
  if (!result.success) fail('CONTRACT_INVALID', result.error.message)
  return result.data
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(
  code: 'CONTRACT_INVALID' | 'UNSUPPORTED_RESOURCES',
  message: string,
  cause?: unknown,
): never {
  throw new MethodResourceError('method', code, message, cause === undefined ? undefined : { cause })
}
