import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import { canonicalize } from '@singularity/protocol'
import type { JsonValue } from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'
import { MCP_RESOURCE_TOOL_NAMES } from './mcp-resources.ts'
import type { FrozenMcpServer } from './mcp-resources.ts'

/**
 * Creates the Run-owned root that holds materialized server bundles and their
 * isolated HOMEs. The caller removes it after the Agent handle is disposed.
 */
export async function createMcpResourceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'singularity-mcp-'))
}

/** Removes the Run-owned MCP root and every materialized file under it. */
export async function removeMcpResourceRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

const CREDENTIAL_CHANNELS = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_AGENT_INFO',
  'KUBECONFIG',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'KRB5CCNAME',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'NPM_CONFIG_USERCONFIG',
  'PIP_CONFIG_FILE',
] as const

const XDG_HOME_DIRS = {
  XDG_CONFIG_HOME: '.config',
  XDG_CACHE_HOME: '.cache',
  XDG_DATA_HOME: '.local/share',
  XDG_STATE_HOME: '.local/state',
} as const

/**
 * Materializes each frozen server bundle under the Run root and mounts it with
 * the native DSH stdio client in the Agent scope. A failed mount leaves the
 * Agent setup transaction to unwind previously mounted scoped clients.
 */
export async function mountMcpServers(
  agentCtx: Context,
  servers: readonly FrozenMcpServer[],
  root: string,
): Promise<void> {
  const prepared = servers.map((server, index) => ({
    server,
    serverRoot: join(root, `${String(index)}-${server.serverName}`),
    home: join(root, 'home', `${String(index)}-${server.serverName}`),
  }))
  // Materialize every bundle before the first child starts so no server can
  // observe or rewrite a later server's partially written root.
  for (const entry of prepared) {
    await materializeServer(entry.serverRoot, entry.server)
  }
  for (const entry of prepared) {
    const env = await mcpChildEnv(entry.home)
    const config: StdioConfig = {
      transport: 'stdio',
      serverName: entry.server.serverName,
      command: process.execPath,
      args: [join(entry.serverRoot, entry.server.entrypoint)],
      cwd: entry.serverRoot,
      env,
      toolCallTimeoutMs: entry.server.configValue.toolCallTimeoutMs,
      maxInstructionBytes: entry.server.configValue.maxInstructionBytes,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
    await agentCtx.plugin(mcpClient, config)
  }
}

async function mcpChildEnv(home: string): Promise<Record<string, string>> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const env: Record<string, string> = { HOME: home, TMPDIR: join(home, 'tmp') }
  const dirs = ['tmp', 'run', '.config', '.cache', '.local/share', '.local/state']
  for (const dir of dirs) await mkdir(join(home, dir), { recursive: true, mode: 0o700 })
  for (const name of CREDENTIAL_CHANNELS) env[name] = ''
  for (const [name, dir] of Object.entries(XDG_HOME_DIRS)) env[name] = join(home, dir)
  env['XDG_RUNTIME_DIR'] = join(home, 'run')
  return env
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
  try {
    await access(join(serverRoot, server.entrypoint))
  } catch (error) {
    throw new MethodResourceError(
      'method',
      'CONTRACT_INVALID',
      `materialized MCP bundle is missing entrypoint ${JSON.stringify(server.entrypoint)}`,
      { cause: error },
    )
  }
}

function failSurface(message: string): never {
  throw new MethodResourceError('method', 'UNSUPPORTED_RESOURCES', message)
}
