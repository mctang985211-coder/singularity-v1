import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { fromJsonSchema,McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

export const bbdevInstructions = 'First use checkout to create your independent prepared Buckyball directory. Then run domain operations through bbdev, which activates nix develop in that directory. Use bash for source edits and standalone component tools. Follow the Task scope: focused Ball work; no full-chip simulation, P2E or physical backend.'
export const checkoutDescription = 'Copy prepared baseline and install configs into a new absolute project path.'
export const checkoutParameters = { type: 'object' as const, additionalProperties: false,
  properties: { project: { type: 'string' as const } }, required: ['project'] }
export const bbdevDescription = 'Run bbdev in project-local Nix. Pass separate CLI argv.'
export const bbdevParameters = { type: 'object' as const, additionalProperties: false,
  properties: { project: { type: 'string' as const },
    args: { type: 'array' as const, items: { type: 'string' as const } } }, required: ['project', 'args'] }

/** Domain-owned CLI adapter. DSH owns MCP transport, timeout and teardown. */
export function createBuckyballMcp(baseline = process.env.BUCKYBALL_BASELINE) {
  if (baseline === undefined) throw new Error('Set BUCKYBALL_BASELINE to the operator-prepared checkout before starting this domain MCP')
  const server = new McpServer({ name: 'buckyball', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: bbdevInstructions })
  server.registerTool('checkout', { description: checkoutDescription,
    inputSchema: fromJsonSchema<{ project: string }>(checkoutParameters),
  }, async ({ project }, extra) => {
    await mkdir(project)
    await promisify(execFile)('cp', ['--archive', '--reflink=auto', `${baseline}/.`, project], { signal: extra.mcpReq.signal })
    return runBbdev(project, ['config', '--install'], extra.mcpReq.signal, baseline)
  })
  server.registerTool('bbdev', { description: bbdevDescription,
    inputSchema: fromJsonSchema<{ project: string; args: string[] }>(bbdevParameters),
  }, ({ project, args }, extra) => runBbdev(project, args, extra.mcpReq.signal, baseline))
  return server
}

function runBbdev(project: string, args: string[], signal: AbortSignal, baseline: string) {
  return new Promise<{ isError: boolean; content: { type: 'text'; text: string }[]; structuredContent: Record<string, unknown> }>(resolveResult => {
    execFile('nix', ['develop', '--command', 'bash', '-c', 'exec bbdev "$@"', '--', ...args],
      { cwd: project, signal, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, BUCKYBALL_LLVM_BUILD: join(baseline, 'stack/compiler/thirdparty/buddy-mlir/llvm/build') } }, (error, stdout, stderr) => {
        const result = { exit: error?.code ?? 0, stdout, stderr, ...(error === null ? {} : { error: error.message }) }
        resolveResult({ isError: error !== null, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
      })
  })
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  serveStdio(() => createBuckyballMcp())
}
