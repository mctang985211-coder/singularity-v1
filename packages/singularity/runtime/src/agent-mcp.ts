import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StdioConfig,StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { JsonValue } from '@singularity/protocol'
import { canonicalize } from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import type { FrozenMcpServer } from './mcp-resources.ts'
import { MCP_RESOURCE_TOOL_NAMES } from './mcp-resources.ts'

/**
 * Creates the Run-owned root that holds materialized stdio server bundles and
 * their entrypoints. HTTP-only Runs never call this.
 */
export async function createMcpResourceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'singularity-mcp-'))
}

/** Removes the Run-owned MCP root and every materialized file under it. */
export async function removeMcpResourceRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

/**
 * Materializes stdio server bundles under the Run root and mounts every frozen
 * server with the native DSH client in template order. HTTP entries use the
 * native streamable-http config and never create a host directory or child env.
 */
export async function mountMcpServers(
  agentCtx: Context,
  servers: readonly FrozenMcpServer[],
  root: string | undefined,
): Promise<void> {
  const prepared = servers.map((server, index) => ({
    server,
    serverRoot: join(root ?? '.', `${String(index)}-${server.serverName}`),
  }))
  const stdio = prepared.filter(entry => entry.server.transport === 'stdio')
  if (stdio.length > 0 && root === undefined) {
    throw new MethodResourceError(
      'method',
      'UNSUPPORTED_RESOURCES',
      'host did not create the MCP resource root required by stdio Method server bindings',
    )
  }
  // Materialize the trusted bundles before mounting the native clients.
  for (const entry of stdio) {
    await materializeServer(entry.serverRoot, entry.server)
  }
  for (const entry of prepared) {
    const transport = entry.server.configValue
    if (transport.transport === 'stdio') {
      const config: StdioConfig = {
        transport: 'stdio',
        serverName: entry.server.serverName,
        command: transport.command === 'node' ? process.execPath : transport.command,
        args: [...transport.args],
        cwd: entry.serverRoot,
        env: { ...transport.env },
        toolCallTimeoutMs: entry.server.configValue.toolCallTimeoutMs,
        maxInstructionBytes: entry.server.configValue.maxInstructionBytes,
        failOnStartupError: true,
        reconnect: { enabled: false },
      }
      await agentCtx.plugin(mcpClient, config)
      continue
    }
    const httpConfig = transport
    const config: StreamableHttpConfig = {
      transport: 'streamable-http',
      serverName: entry.server.serverName,
      url: httpConfig.url,
      headers: httpConfig.headers,
      toolCallTimeoutMs: httpConfig.toolCallTimeoutMs,
      maxInstructionBytes: httpConfig.maxInstructionBytes,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
    await agentCtx.plugin(mcpClient, config)
  }
}

/**
 * Verifies the actual scoped tool surface is exactly the frozen exposed tools
 * plus the native resource tools. Description or parameter drift closes the
 * setup before the Agent is published.
 */
export function assertMcpSurface(
  agentCtx: Context,
  agent: Agent,
  servers: readonly FrozenMcpServer[],
): void {
  if (servers.length === 0) return
  const definitions = agentCtx.tools.definitions(agent)
  const definitionNames = new Set(definitions.map(definition => definition.name))
  const expectedNames = new Set(servers.flatMap(server => server.publicToolNames))
  const actualNames = new Set([...definitionNames].filter(name => name.startsWith('mcp__')))
  if (actualNames.size !== expectedNames.size
    || [...actualNames].some(name => !expectedNames.has(name))) {
    failSurface('scoped MCP tool surface must equal the frozen exposedTools')
  }
  const schemas = agentCtx.tools.schemas(agent)
  for (const server of servers) {
    for (const exposed of server.exposedTools) {
      const publicName = `mcp__${server.serverName}__${exposed.name}`
      const schema = schemas.find(candidate => candidate.name === publicName)
      if (schema === undefined) {
        failSurface(`MCP tool ${JSON.stringify(publicName)} is missing its model schema`)
      }
      if (schema.description !== exposed.description) {
        failSurface(`MCP tool ${JSON.stringify(publicName)} description does not match the frozen asset`)
      }
      if (canonicalize(schema.parameters as JsonValue) !== canonicalize(exposed.parameters)) {
        failSurface(`MCP tool ${JSON.stringify(publicName)} parameters do not match the frozen asset`)
      }
    }
  }
  for (const name of MCP_RESOURCE_TOOL_NAMES) {
    if (!definitionNames.has(name)) {
      failSurface(`native MCP resource tool ${JSON.stringify(name)} is not mounted`)
    }
  }
}

async function materializeServer(serverRoot: string, server: FrozenMcpServer): Promise<void> {
  await mkdir(serverRoot, { recursive: true, mode: 0o700 })
  for (const file of server.bundleFiles) {
    const target = join(serverRoot, file.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, file.data, { flag: 'wx', mode: 0o600 })
  }

}

function failSurface(message: string): never {
  throw new MethodResourceError('method', 'UNSUPPORTED_RESOURCES', message)
}
