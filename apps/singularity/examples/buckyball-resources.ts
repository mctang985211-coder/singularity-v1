import { readFile } from 'node:fs/promises'

import type { Ref,ToolAsset } from '@singularity/protocol'
import { canonicalize,seal } from '@singularity/protocol'
import type { CommandService } from '@singularity/runtime'

import { bbdevDescription,bbdevInstructions,bbdevParameters,checkoutDescription,checkoutParameters } from './buckyball-mcp.ts'
import { BUCKYBALL_FRONTEND_CAMPAIGN } from './buckyball-frontend-task.ts'

/** Freeze the operator-prepared domain tool into the ordinary exploration catalog. */
export async function freezeBuckyballTools(service: CommandService, baseline: string): Promise<ToolAsset[]> {
  const put = (id: string, value: unknown) => service.putObject(id, new TextEncoder().encode(canonicalize(value)))
  let source = await readFile(new URL('./buckyball-mcp.ts', import.meta.url), 'utf8')
  for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio']) {
    source = source.replace(`'${name}'`, JSON.stringify(import.meta.resolve(name)))
  }
  const content = new TextEncoder().encode(source)
  const object = await service.putObject('buckyball:mcp:source', content)
  const bundle: Ref = await put('buckyball:mcp:bundle', seal('object', { v: 1, kind: 'tree',
    files: [{ path: 'server.ts', bytes: content.byteLength, object }] }))
  const manifest = await put('buckyball:mcp:manifest', { serverName: 'buckyball', transport: 'stdio', instructions: bbdevInstructions,
    entrypoint: 'server.ts', limits: { maxBundleBytes: 1024 * 1024 } })
  const config = await put('buckyball:mcp:config', { transport: 'stdio', command: process.execPath, args: ['server.ts'], env: { BUCKYBALL_BASELINE: baseline },
    toolCallTimeoutMs: BUCKYBALL_FRONTEND_CAMPAIGN.maxWallClockMs, maxInstructionBytes: 8192 })
  return [{ id: 'buckyball-bbdev', name: 'buckyball', description: 'Existing bbdev CLI with project-local Nix activation.', kind: 'mcp-server',
    server: { bundle, sourceFiles: bundle, manifest, config, transport: 'stdio', capabilities: ['public-chip-frontend'],
      exposedTools: [{ name: 'checkout', description: checkoutDescription, parameters: checkoutParameters },
        { name: 'bbdev', description: bbdevDescription, parameters: bbdevParameters }] } }]
}
