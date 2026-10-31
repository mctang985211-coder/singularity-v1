import { fromJsonSchema,McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { reconcileInventory } from '@singularity/domain-inventory'

/** Operator-trusted public-domain tool. Native DSH owns its stdio lifecycle. */
serveStdio(() => {
  const server = new McpServer({ name: 'inventory', version: '1.0.0' }, {
    capabilities: { tools: {} }, instructions: 'Reconcile public signed inventory CSVs. Pass CSV contents, not filesystem paths. Write the returned report in your own workspace.',
  })
  server.registerTool('reconcile', {
    description: 'Sum signed inventory transactions across supplied CSVs, retaining zero and negative totals and ascending SKU order.',
    inputSchema: fromJsonSchema<{ csvs: string[] }>({ type: 'object', additionalProperties: false,
      properties: { csvs: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['csvs'] }),
  }, ({ csvs }) => {
    const rows = csvs.flatMap(csv => {
      reconcileInventory(csv)
      return csv.trimEnd().split(/\r?\n/).slice(1)
    })
    const report = reconcileInventory(`sku,delta\n${rows.join('\n')}\n`)
    return { content: [{ type: 'text', text: JSON.stringify(report) }], structuredContent: { ...report } }
  })
  return server
})
