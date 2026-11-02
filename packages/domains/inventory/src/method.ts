import { inventoryCheck } from './index.ts'
import { computeDigest, sealMethodRevision } from '@singularity/protocol'
import type { JsonValue, MethodRevision, Ref, TaskExample } from '@singularity/protocol'

export const INVENTORY_ROOT_TEMPLATE = 'inventory:integrate-report'
export const INVENTORY_CHILD_TEMPLATE = 'inventory:reconcile-report'
export const INVENTORY_CHILD_BINDING = 'reconcile-inventory'

export const INVENTORY_PUBLIC_GUIDE = 'Read transactions.csv, sum each signed delta by sku, retain zero and negative totals, sort sku ascending, and emit exact JSON with rowCount and totals. Each Task works on its own goal. Direct child reports are frozen artifacts for parent integration. Submit the declared report to the host for independent acceptance. Reusable skills or tools are learning drafts for RSI registration.'

/** Pure domain assets; the application freezes these objects through its writer. */
export function inventoryGuidedBaseline(acceptance: Ref, scenario: 'single-csv' | 'warehouse-network' = 'single-csv'): {
  readonly method: MethodRevision
  readonly assets: readonly { readonly ref: Ref; readonly value: JsonValue }[]
} {
  const assets: { ref: Ref; value: JsonValue }[] = []
  const asset = (id: string, value: JsonValue): Ref => {
    const ref = { id, digest: computeDigest('object', value) }
    assets.push({ ref, value })
    return ref
  }
  const rootGuidance = asset('inventory:guidance:integrate', { v: 1, text: `Read self and submit a two-level sketch before inspecting the authorized CSV locally for rows and SKUs. Prepare the ${INVENTORY_CHILD_BINDING} binding and read its complete example. Read the transactions resource to obtain its authorized object reference, then commit one direct child. The template already supplies the exact criterion and required report output; fill goal and inputs with localCriteria:[] and localOutputs:[] as in the example. The required child produces an independently accepted full inventory report. After its batch finishes, read the direct result and frozen report, refresh the two-level sketch for the current contextEpoch, and integrate this level's report.json after checking row count and totals against your own input. A completed child can remain described at level 1. Submit the report output to the host for independent acceptance. Every node performs its own declared work; the root owns final integration.` })
  const network = scenario === 'warehouse-network'
  const childGuidance = asset('inventory:guidance:reconcile', { v: 1, text: network
    ? 'Own the regional consolidation workflow. Read self, query the ancestor summary to preserve publication constraints, and plan this Task and its direct warehouse children; a third sketch level may anticipate their local work. Prepare the warehouse-east and warehouse-west examples. If the ancestor summary was pending, read it again after local input inspection. Then commit both direct children in one batch. Give each child only its corresponding authorized warehouse CSV input, retaining its complete InputRef. Each child independently computes that warehouse report. After the batch, read both frozen reports, sum their rowCounts and combine quantities by SKU, retaining zero and negative totals and sorting ascending. Cross-check against both original warehouse CSVs and write your own combined report.json, then submit. You perform the regional aggregation; each child owns its own calculation workflow.'
    : 'This Task has the complete CSV, calculation rules, output schema and acceptance criterion needed for direct work. Read transactions.csv, sum every signed integer delta by sku, retain zero and negative totals, sort sku ascending, and write report.json as {"rowCount":number,"totals":[{"sku":string,"quantity":number}]}. Check your row count and totals, then submit the report output to the host for independent acceptance. An exploration binding remains available under the domain policy when concrete missing information makes it useful; the normal reconciliation can be completed directly.' })
  const networkRootGuidance = network ? asset('inventory:guidance:network', { v: 1, text: `Publish the combined inventory report for the authorized east and west warehouse CSVs. Read self; sketch [0,1,2] to anticipate regional consolidation and warehouse calculations while selecting only the direct ${INVENTORY_CHILD_BINDING} region binding. Inspect the input CSVs for row counts and coverage. Prepare that region example, then commit one region Task with both complete authorized InputRefs. The region owns its warehouse workflow. After its batch, read the verified region report, check total row count and per-SKU quantities against your original inputs, and write your own report.json for final publication and independent acceptance. Your work is input inspection, final checking and publication; the region performs aggregation.` }) : undefined
  const warehouseGuidance = network ? asset('inventory:guidance:warehouse', { v: 1, text: 'Calculate the exact inventory report for your single authorized warehouse CSV. Read self and plan this level; inspect the supplied input path rather than assuming transactions.csv. Sum signed delta by SKU, count data rows, retain zero and negative totals, sort SKU ascending, write report.json and submit. Use a direct exploration child only if a concrete local subproblem warrants one.' }) : undefined
  const example: TaskExample = {
    goal: { summary: 'Reconcile all signed inventory transactions and produce the exact report.', deliverable: 'report.json',
      scope: ['Sum signed deltas by SKU and retain every SKU.'], constraints: ['Use integer arithmetic and ascending SKU order.'] },
    inputs: [{ id: 'transactions', exampleText: 'sku,delta\nBOLT,4\nBOLT,-4\nNUT,-2\n' }],
    localCriteria: [], localOutputs: [], acceptanceChecks: [],
  }
  const exampleRef = asset('inventory:example:report', example as unknown as JsonValue)
  const obligations = {
    instanceSchema: {},
    requiredCriteria: [{ id: 'inventory-exact', statement: 'The frozen report contains the exact row count and sorted per-SKU integer totals for the frozen input CSV.', required: true, checks: [inventoryCheck()] }],
    requiredOutputs: [{ id: 'report', path: 'report.json', kind: 'file' as const, role: 'deliverable' as const, required: true }],
    acceptancePolicy: acceptance, skills: [], tools: [],
  }
  const method = sealMethodRevision({ v: 1, id: 'inventory:method-guided', entryTemplateId: INVENTORY_ROOT_TEMPLATE,
    templates: [
      { ...obligations, id: INVENTORY_ROOT_TEMPLATE, brief: 'Inspect inventory input, organize one required reconciliation and integrate its verified report.',
        guidance: networkRootGuidance ?? rootGuidance, example: exampleRef,
        children: [{ bindingId: INVENTORY_CHILD_BINDING, templateId: INVENTORY_CHILD_TEMPLATE, brief: 'Reconcile the full authorized CSV and submit its exact report.', join: 'required' }] },
      { ...obligations, id: INVENTORY_CHILD_TEMPLATE, brief: 'Calculate and submit the exact inventory report for the authorized CSV.',
        guidance: childGuidance, example: exampleRef, children: network ? [
          { bindingId: 'warehouse-east', templateId: 'inventory:warehouse-report', brief: 'Compute the exact inventory report for the east warehouse CSV only.', join: 'required' },
          { bindingId: 'warehouse-west', templateId: 'inventory:warehouse-report', brief: 'Compute the exact inventory report for the west warehouse CSV only.', join: 'required' },
        ] : [] },
      ...(warehouseGuidance === undefined ? [] : [{ ...obligations, id: 'inventory:warehouse-report',
        brief: 'Calculate one warehouse report from its authorized CSV.', guidance: warehouseGuidance, example: exampleRef, children: [] }]),
    ], skills: [], tools: [] })
  return { method, assets }
}
