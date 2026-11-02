import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { canonicalize,parseJsonText } from '@singularity/protocol'

import { reconcileInventory } from './index.ts'

const args = process.argv.slice(2)
const inputs = args.flatMap((value, index) => value === '--input' ? [args[index + 1]] : [])
const candidate = args.at(args.indexOf('--candidate') + 1), report = args.at(args.indexOf('--report') + 1)
if (inputs.length === 0 || candidate === undefined || report === undefined) throw new Error('Usage: inventory-check --input <csv> [--input <csv>] --candidate <report.json> --report <check.json>')
const rows = []
for (const input of inputs) {
  const text = await readFile(input, 'utf8')
  reconcileInventory(text)
  rows.push(...text.trimEnd().split(/\r?\n/).slice(1))
}
const expected = reconcileInventory(`sku,delta\n${rows.join('\n')}\n`)
const actual = parseJsonText(await readFile(candidate, 'utf8'))
const matched = canonicalize(actual) === canonicalize(expected)
const data = { comparedReports: 1, matched, reason: matched ? 'Exact report equality.' : 'Inventory output differs from the independent reference.', rowsCompared: rows.length, skuCount: expected.totals.length }
await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(data, null, 2))
console.log(JSON.stringify(data)); process.exitCode = matched ? 0 : 1
