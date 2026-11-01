import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { fromJsonSchema,McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

export const bbdevInstructions = 'Run Buckyball frontend operations in your own checkout through bbdev. The tool activates nix develop in that project directory. Use bash for source edits and standalone component tools. Follow the Task scope: frontend only, no full-chip simulation, P2E or physical backend.'
export const bbdevDescription = 'Run bbdev via project-local nix develop. Example: {"project":"/absolute/buckyball","args":["--help"]}. Pass each CLI argument separately.'
export const bbdevParameters = { type: 'object' as const, additionalProperties: false,
  properties: { project: { type: 'string' as const, description: 'Absolute checkout path.' },
    args: { type: 'array' as const, items: { type: 'string' as const }, description: 'CLI argv; read --help first.' } }, required: ['project', 'args'] }

/** Domain-owned CLI adapter. DSH owns MCP transport, timeout and teardown. */
export function createBuckyballMcp() {
  const server = new McpServer({ name: 'buckyball', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: bbdevInstructions })
  server.registerTool('bbdev', { description: bbdevDescription,
    inputSchema: fromJsonSchema<{ project: string; args: string[] }>(bbdevParameters),
  }, ({ project, args }, extra) => new Promise(resolveResult => {
    execFile('nix', ['develop', '--command', 'bash', '-c', 'exec bbdev "$@"', '--', ...args],
      { cwd: project, signal: extra.mcpReq.signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const result = { exit: error?.code ?? 0, stdout, stderr, ...(error === null ? {} : { error: error.message }) }
        resolveResult({ isError: error !== null, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
      })
  }))
  return server
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  serveStdio(createBuckyballMcp)
}
