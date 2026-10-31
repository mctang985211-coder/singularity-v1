import {
  canonicalize,
  computeDigest,
  parseJsonText,
  seal,
} from '@singularity/protocol'
import type {
  JsonObject,
  JsonValue,
  MethodRevision,
  Ref,
  TaskTemplate,
  ToolAsset,
} from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import { validateHttpConfig } from './mcp-http-config.ts'
import type { McpHttpConfig } from './mcp-http-config.ts'
import { TreeBundleError, readTreeBundle } from './resource-bundle.ts'
import type { CasObjectReader } from './workspace.ts'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const TOOL_NAME = /^[A-Za-z0-9_]+$/
const MAX_BUNDLE_BYTES = 1024 * 1024
const MAX_INSTRUCTION_BYTES = 8192
const MAX_TOOL_CALL_TIMEOUT_MS = 60_000
/**
 * A3 deployment allowlist. These are declarations only: they authorize the
 * frozen Method surface, not a filesystem/network sandbox or capability broker.
 */
const CAPABILITY_ALLOWLIST: ReadonlySet<string> = new Set([
  'tools',
  'resources',
  'resource-templates',
])
/** Native DSH resource tools exposed once at least one MCP server is mounted. */
export const MCP_RESOURCE_TOOL_NAMES = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()

interface McpManifest {
  readonly v: 1
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly capabilities: readonly string[]
  readonly instructions: string
  readonly entrypoint: string
  readonly limits: {
    readonly maxBundleBytes: number
    readonly maxInstructionBytes: number
    readonly toolCallTimeoutMs: number
  }
}

interface McpStdioConfig {
  readonly v: 1
  readonly serverName: string
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: '.'
  readonly env: Readonly<Record<string, never>>
  readonly toolCallTimeoutMs: number
  readonly maxInstructionBytes: number
  readonly failOnStartupError: true
  readonly reconnect: { readonly enabled: false }
}

type McpTransportConfig = McpStdioConfig | McpHttpConfig

interface CatalogTool {
  readonly asset: ToolAsset
  readonly manifest: McpManifest
  readonly manifestRef: Ref
  readonly bundle: Awaited<ReturnType<typeof readTreeBundle>>
  readonly sourceFiles: Awaited<ReturnType<typeof readTreeBundle>>
  readonly configValue: McpTransportConfig | undefined
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
 * exactly the bound server bundle refs. Both stdio and strict loopback
 * streamable-http transports use the same identity and deployment shape.
 */
export async function readMcpServers(
  reader: CasObjectReader,
  method: MethodRevision,
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
    if (configValue === undefined) {
      fail('CONTRACT_INVALID', `MCP server ${JSON.stringify(tool.manifest.serverName)} is missing its transport config`)
    }
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
    const manifest = validateManifest(
      await readSealedObject(reader, manifestRef, `MCP server ${JSON.stringify(asset.id)} manifest`),
      asset,
    )
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
    assertSourceSubset(bundle, sourceFiles, manifest.serverName)
    if (!bundle.contents.has(manifest.entrypoint)) {
      fail('CONTRACT_INVALID', `MCP server ${JSON.stringify(manifest.serverName)} bundle must contain entrypoint ${JSON.stringify(manifest.entrypoint)}`)
    }
    const configObject = await readSealedObject(
      reader,
      asset.server.config,
      `MCP server ${JSON.stringify(manifest.serverName)} config`,
    )
    const instructionBytes = textEncoder.encode(
      instructionSectionText(manifest.serverName, manifest.instructions),
    ).byteLength
    const configValue = manifest.transport === 'stdio'
      ? validateConfig(configObject, manifest, instructionBytes)
      : validateHttpConfig(configObject, manifest.serverName, manifest.limits, instructionBytes)
    catalog.set(asset.id, { asset, manifest, manifestRef, bundle, sourceFiles, configValue })
  }
  return catalog
}

function validateCapabilities(
  capabilities: readonly string[],
  exposedTools: ToolAsset['server']['exposedTools'],
  label: string,
): void {
  if (capabilities.length === 0) fail('CONTRACT_INVALID', `${label} must not be empty`)
  const seen = new Set<string>()
  for (const capability of capabilities) {
    if (seen.has(capability)) fail('CONTRACT_INVALID', `${label} must not contain duplicates`)
    if (!CAPABILITY_ALLOWLIST.has(capability)) {
      fail('UNSUPPORTED_RESOURCES', `${label} contains unsupported capability ${JSON.stringify(capability)}`)
    }
    seen.add(capability)
  }
  if (exposedTools.length > 0 && !seen.has('tools')) {
    fail('CONTRACT_INVALID', `${label} must include "tools" when exposedTools is non-empty`)
  }
}

function validateManifest(value: JsonObject, asset: ToolAsset): McpManifest {
  assertExactKeys(value, ['v', 'serverName', 'transport', 'capabilities', 'instructions', 'entrypoint', 'limits', 'digest'], 'MCP manifest')
  if (value['v'] !== 1) fail('CONTRACT_INVALID', 'MCP manifest v must be 1')
  const serverName = value['serverName']
  if (typeof serverName !== 'string' || !SERVER_NAME.test(serverName)) {
    fail('CONTRACT_INVALID', 'MCP manifest serverName must match [A-Za-z0-9_-]{1,32}')
  }
  const transport = value['transport']
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    fail('CONTRACT_INVALID', 'MCP manifest transport must be stdio or streamable-http')
  }
  if (transport !== asset.server.transport) {
    fail('CONTRACT_INVALID', `MCP manifest transport does not match ToolAsset.server.transport for ${JSON.stringify(asset.id)}`)
  }
  const capabilities = value['capabilities']
  if (!Array.isArray(capabilities) || capabilities.some(entry => typeof entry !== 'string')) {
    fail('CONTRACT_INVALID', `MCP manifest capabilities must be strings for ${JSON.stringify(asset.id)}`)
  }
  const validatedCapabilities: readonly string[] = capabilities.map(entry => entry as string)
  validateCapabilities(validatedCapabilities, asset.server.exposedTools, `MCP manifest capabilities for ${JSON.stringify(asset.id)}`)
  validateCapabilities(asset.server.capabilities, asset.server.exposedTools, `MCP ToolAsset capabilities for ${JSON.stringify(asset.id)}`)
  if (canonicalize(validatedCapabilities) !== canonicalize(asset.server.capabilities)) {
    fail('CONTRACT_INVALID', `MCP manifest capabilities must equal ToolAsset.server.capabilities for ${JSON.stringify(asset.id)}`)
  }
  const instructions = value['instructions']
  if (typeof instructions !== 'string') fail('CONTRACT_INVALID', 'MCP manifest instructions must be a string')
  const entrypoint = value['entrypoint']
  if (!isSafeRelativePath(entrypoint)) fail('CONTRACT_INVALID', 'MCP manifest entrypoint must be a safe relative path')
  const limits = value['limits']
  if (!isRecord(limits)) fail('CONTRACT_INVALID', 'MCP manifest limits must be an object')
  assertExactKeys(limits, ['maxBundleBytes', 'maxInstructionBytes', 'toolCallTimeoutMs'], 'MCP manifest limits')
  const maxBundleBytes = positiveInteger(limits['maxBundleBytes'], 'MCP manifest maxBundleBytes', MAX_BUNDLE_BYTES)
  const maxInstructionBytes = positiveInteger(limits['maxInstructionBytes'], 'MCP manifest maxInstructionBytes', MAX_INSTRUCTION_BYTES)
  const instructionBytes = textEncoder.encode(instructionSectionText(serverName, instructions)).byteLength
  if (instructionBytes > maxInstructionBytes) {
    fail('CONTRACT_INVALID', `MCP manifest instruction section exceeds its ${String(maxInstructionBytes)} byte cap`)
  }
  const toolCallTimeoutMs = positiveInteger(limits['toolCallTimeoutMs'], 'MCP manifest toolCallTimeoutMs', MAX_TOOL_CALL_TIMEOUT_MS)
  return {
    v: 1,
    serverName,
    transport,
    capabilities: [...validatedCapabilities],
    instructions,
    entrypoint,
    limits: { maxBundleBytes, maxInstructionBytes, toolCallTimeoutMs },
  }
}

function validateConfig(value: JsonObject, manifest: McpManifest, instructionBytes: number): McpStdioConfig {
  assertExactKeys(value, [
    'v', 'serverName', 'transport', 'command', 'args', 'cwd', 'env',
    'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect',
    'digest',
  ], 'MCP stdio config')
  if (value['v'] !== 1) fail('CONTRACT_INVALID', 'MCP config v must be 1')
  if (value['serverName'] !== manifest.serverName) fail('CONTRACT_INVALID', 'MCP config serverName must equal manifest.serverName')
  if (value['transport'] !== 'stdio') fail('CONTRACT_INVALID', 'MCP stdio config transport must be stdio')
  if (value['command'] !== 'node') fail('UNSUPPORTED_RESOURCES', 'S4-A3 only allows the logical stdio command "node"')
  const args = value['args']
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== manifest.entrypoint || !isSafeRelativePath(args[0])) {
    fail('CONTRACT_INVALID', 'MCP stdio config args must be exactly the manifest entrypoint')
  }
  if (value['cwd'] !== '.') fail('CONTRACT_INVALID', 'MCP stdio config cwd must be "."')
  const env = value['env']
  if (!isRecord(env) || Object.keys(env).length !== 0) {
    fail('UNSUPPORTED_RESOURCES', 'S4-A3 rejects raw env/secrets in MCP config; only host-derived HOME is added')
  }
  const toolCallTimeoutMs = positiveInteger(value['toolCallTimeoutMs'], 'MCP config toolCallTimeoutMs', manifest.limits.toolCallTimeoutMs)
  const maxInstructionBytes = positiveInteger(value['maxInstructionBytes'], 'MCP config maxInstructionBytes', manifest.limits.maxInstructionBytes)
  if (instructionBytes > maxInstructionBytes) {
    fail('CONTRACT_INVALID', `MCP config maxInstructionBytes ${String(maxInstructionBytes)} cannot carry the ${String(instructionBytes)} byte instructions`)
  }
  if (value['failOnStartupError'] !== true) fail('CONTRACT_INVALID', 'MCP config must set failOnStartupError true')
  const reconnect = value['reconnect']
  if (!isRecord(reconnect)) fail('CONTRACT_INVALID', 'MCP config reconnect must be an object')
  assertExactKeys(reconnect, ['enabled'], 'MCP config reconnect')
  if (reconnect['enabled'] !== false) fail('CONTRACT_INVALID', 'MCP config must disable reconnect')
  return {
    v: 1,
    serverName: manifest.serverName,
    transport: 'stdio',
    command: 'node',
    args: [manifest.entrypoint],
    cwd: '.',
    env: {},
    toolCallTimeoutMs,
    maxInstructionBytes,
    failOnStartupError: true,
    reconnect: { enabled: false },
  }
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

async function readSealedObject(
  reader: CasObjectReader,
  ref: Ref,
  label: string,
): Promise<JsonObject> {
  const value = await readJson(reader, ref, label)
  if (value['digest'] !== ref.digest || computeDigest('object', value) !== ref.digest) {
    fail('CONTRACT_INVALID', `${label} digest is not its structured object digest`)
  }
  return value
}

async function readJson(reader: CasObjectReader, ref: Ref, label: string): Promise<JsonObject> {
  let bytes: Uint8Array
  try {
    ({ bytes } = await reader.readObject(ref, 'object'))
  } catch (error) {
    fail('CONTRACT_INVALID', `${label} CAS object is missing or unreadable`, error)
  }
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

function assertSourceSubset(
  bundle: Awaited<ReturnType<typeof readTreeBundle>>,
  sourceFiles: Awaited<ReturnType<typeof readTreeBundle>>,
  serverName: string,
): void {
  const bundleFiles = new Map(bundle.manifest.files.map(file => [file.path, file]))
  for (const source of sourceFiles.manifest.files) {
    const bundled = bundleFiles.get(source.path)
    if (bundled === undefined || bundled.bytes !== source.bytes
      || bundled.object.digest !== source.object.digest) {
      fail('CONTRACT_INVALID', `MCP server ${JSON.stringify(serverName)} sourceFiles must be a subset of its bundle`)
    }
  }
}

function assertExactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    fail('CONTRACT_INVALID', `${label} must contain exactly ${keys.join(', ')}`)
  }
}

function positiveInteger(value: JsonValue | undefined, label: string, max?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    fail('CONTRACT_INVALID', `${label} must be a positive safe integer${max === undefined ? '' : ` <= ${String(max)}`}`)
  }
  return value
}

function isSafeRelativePath(value: JsonValue | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0
    || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
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
