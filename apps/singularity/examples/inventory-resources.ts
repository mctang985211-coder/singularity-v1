import { readFile } from 'node:fs/promises'

import type { JsonValue,Ref,SkillAsset,ToolAsset } from '@singularity/protocol'
import { canonicalize,seal } from '@singularity/protocol'
import type { CommandService } from '@singularity/runtime'

/** Public assets for both empty-Method exploration and later explicit bindings. */
export async function freezeInventoryResources(service: CommandService): Promise<{ skills: SkillAsset[]; tools: ToolAsset[] }> {
  const put = (id: string, value: unknown) => service.putObject(id, new TextEncoder().encode(canonicalize(value)))
  const tree = async (id: string, files: readonly { path: string; text: string }[]): Promise<Ref> => {
    const entries = []
    for (const file of files) {
      const bytes = new TextEncoder().encode(file.text)
      entries.push({ path: file.path, bytes: bytes.byteLength, object: await service.putObject(`${id}:${file.path}`, bytes) })
    }
    return put(id, seal('object', { v: 1, kind: 'tree', files: entries }))
  }
  const skill = await tree('inventory:skill:bundle', [{ path: 'SKILL.md', text: '# Inventory reconciliation\n\nRead the CSV paths from your own contract. Count all data rows and sum signed integer deltas by SKU. Keep zero and negative totals, sort SKU ascending, and write report.json. The inventory MCP reconcile tool accepts an array of complete CSV texts and returns the report; it never writes your workspace. Independently check row count, cancellation and ordering before submit. For multi-warehouse publication, obtain an independent direct warehouse calculation for each CSV: use one explore-child batch per warehouse, its complete authorized InputRef, and a local report output. Read each terminal result before the next batch. After both, consolidate and cross-check your own report. Each single-warehouse Task computes locally and owns its local workflow. At a child boundary, read the ancestor summary once to retain publication constraints. If pending, compute locally and read it again before submitting. Preserve reusable discoveries under learning-drafts/skills or learning-drafts/tools when submitting.\n' }])
  let source = await readFile(new URL('./inventory-mcp.ts', import.meta.url), 'utf8')
  for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio', '@singularity/domain-inventory']) {
    source = source.replace(`'${name}'`, JSON.stringify(import.meta.resolve(name)))
  }
  const bundle = await tree('inventory:mcp:bundle', [{ path: 'server.ts', text: source }])
  const instructions = 'Reconcile public signed inventory CSVs. Pass CSV contents, not filesystem paths. Write the returned report in your own workspace.'
  const manifest = await put('inventory:mcp:manifest', { serverName: 'inventory', transport: 'stdio', instructions,
    entrypoint: 'server.ts', limits: { maxBundleBytes: 1024 * 1024 } })
  const config = await put('inventory:mcp:config', { transport: 'stdio', command: process.execPath, args: ['server.ts'],
    env: {}, toolCallTimeoutMs: 30_000, maxInstructionBytes: 8192 })
  const parameters: JsonValue = { type: 'object', additionalProperties: false,
    properties: { csvs: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['csvs'] }
  return {
    skills: [{ id: 'inventory-reconciliation', name: 'inventory-reconciliation', description: 'Compute and check signed CSV inventory reports and consolidate verified child reports.', bundle: skill }],
    tools: [{ id: 'inventory-mcp', name: 'inventory', description: 'Exact public inventory arithmetic through native MCP.', kind: 'mcp-server',
      server: { bundle, sourceFiles: bundle, manifest, config, transport: 'stdio', capabilities: ['public-inventory-arithmetic'],
        exposedTools: [{ name: 'reconcile', description: 'Sum signed inventory transactions across supplied CSVs, retaining zero and negative totals and ascending SKU order.', parameters }] } }],
  }
}
