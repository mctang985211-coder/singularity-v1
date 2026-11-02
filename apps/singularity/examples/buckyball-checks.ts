import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { dirname,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { AdmissionError,computeDigest,computeDigestBytes } from '@singularity/protocol'
import type { ExecutableCheck,JsonObject,Ref,TaskSpec } from '@singularity/protocol'
import { z } from 'zod'

const file = z.object({ path: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
const source = z.object({ source: file, config: file })
const boundary = z.object({ workload: z.string().min(1), interface: z.string().min(1), hostOffload: z.string(),
  library: file, corner: z.string().min(1), clock: z.string().min(1), activity: z.string().min(1), method: z.string().min(1) })
const ppa = z.object({ boundary, design: source.extend({ rtlTop: z.string().min(1),
  activeInstances: z.array(z.string().min(1)).min(1), memoryModels: z.array(z.string().min(1)).min(1) }),
  report: file, rawReports: z.object({ power: file, timing: file, area: file }), command: z.array(z.string().min(1)).min(1) })
const compilerRoute = z.object({ operation: z.string().min(1), mappedOperation: z.string().min(1), compilerTarget: z.string().min(1), core: z.string().min(1),
  ball: z.string().min(1), isa: z.string().min(1) })
const compilerEvidence = z.object({ recipe: file, graph: file, compiler: file, entrypoint: z.string().min(1),
  routes: z.array(compilerRoute).min(1), buildReport: file })
const compilerBuild = z.object({ sourceDigest: z.string(), configDigest: z.string(), exitCode: z.number().int(), compilerCommand: z.array(z.string()).min(1) })
/** Produced in an independent checkout after reproduction, never accepted from worker reports directly. */
export const buckyballEvidenceSchema = z.object({
  design: source.extend({ compiledPrecision: z.string().min(1) }),
  numerical: z.array(z.object({ reference: file, actual: file, input: file, checkpoint: file, comparator: file,
    compiledSource: file, compiledConfig: file, precision: z.string().min(1), quantization: z.string().min(1),
    rtol: z.number().nonnegative(), atol: z.number().nonnegative() })).min(1).optional(),
  hostReference: source.extend({ sourceRevision: z.string().min(1), checkpointRevision: z.string().min(1),
    cases: z.array(z.object({ stage: z.string().min(1), reference: file, actual: file, input: file, checkpoint: file, comparator: file,
      precision: z.enum(['FP32', 'integer']) })).min(1) }).optional(),
  compiler: compilerEvidence.optional(),
  synthesis: ppa.extend({ rtl: file }).optional(),
  integration: compilerEvidence.extend({ rtl: file,
    // Each row names a real operation through the independently reproduced generated files.
    routes: z.array(compilerRoute.extend({ rtlTop: z.string().min(1), rtlCore: z.string().min(1), rtlBall: z.string().min(1), instance: z.string().min(1) })).min(1),
    componentReport: file }).optional(),
  ppa: ppa.optional(),
  delivery: z.array(file).min(1).optional(),
})
export type BuckyballEvidence = z.infer<typeof buckyballEvidenceSchema>
export type BuckyballCheckKind = 'integration' | 'implementation' | 'numerical' | 'ppa' | 'delivery' | 'host-reference' | 'compiler' | 'synthesis'
export const BUCKYBALL_CHECK_KINDS: BuckyballCheckKind[] = ['integration', 'implementation', 'numerical', 'ppa', 'delivery', 'host-reference', 'compiler', 'synthesis']
const paramsSchema = { type: 'object', additionalProperties: false, required: ['kind', 'manifest'], properties: {
  kind: { enum: BUCKYBALL_CHECK_KINDS }, manifest: { type: 'string', pattern: '^[A-Za-z0-9_./-]+\\.json$' } } }
let checkerSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
for (const name of ['@singularity/protocol', 'zod']) checkerSource = checkerSource.replaceAll(`'${name}'`, JSON.stringify(import.meta.resolve(name)))
export const BUCKYBALL_CHECKER_SOURCE = new TextEncoder().encode(checkerSource)
export const BUCKYBALL_CHECKER_SOURCE_REF: Ref = { id: 'buckyball:checker-source', digest: computeDigestBytes('object', BUCKYBALL_CHECKER_SOURCE) }
export const BUCKYBALL_RECIPE = { v: 1, name: 'buckyball-independent-evidence',
  entrypoint: [process.execPath, fileURLToPath(import.meta.url)], dependencies: [BUCKYBALL_CHECKER_SOURCE_REF], paramsSchema,
  resultSchema: { anyOf: [{ type: 'object', required: ['checksRun', 'failures'], properties: {
    checksRun: { type: 'integer', minimum: 1 }, failures: { type: 'array', items: { type: 'string' } },
    metrics: { type: 'object', properties: {
      casesRun: { type: 'integer', minimum: 1 }, valuesCompared: { type: 'integer', minimum: 1 },
      mismatches: { type: 'integer', minimum: 0 }, maxAbsError: { type: 'number', minimum: 0 },
      stages: { type: 'integer', minimum: 0 }, routes: { type: 'integer', minimum: 0 },
      recipeOperations: { type: 'integer', minimum: 0 }, mappedOperations: { type: 'integer', minimum: 0 }, targets: { type: 'integer', minimum: 0 },
      modules: { type: 'integer', minimum: 0 }, activeInstances: { type: 'integer', minimum: 0 },
      scope: { const: 'component-logic-synthesis' }, conditionsDigest: { type: 'string', minLength: 1 },
      powerMw: { type: 'number', minimum: 0 }, criticalPathNs: { type: 'number', exclusiveMinimum: 0 }, areaUm2: { type: 'number', exclusiveMinimum: 0 },
    } }, ppa: { type: 'object' } } },
    { type: 'object', additionalProperties: false, required: ['executionStatus', 'reason'], properties: {
      executionStatus: { const: 'timeout' }, reason: { type: 'string', minLength: 1 } } }] } as JsonObject,
  publicDataPolicy: 'Independently reproduce candidate artifacts before checks. host-reference compares submitted vectors against separately regenerated pinned original-model vectors (FP32 rtol=1e-4/atol=1e-5, integer exact); it requires no accelerator. compiler parses reachable recipe/graph MLIR and Chip.pb target/core/Ball/ISA with no RTL requirement. synthesis parses raw reports and native Yosys write_json for the declared component boundary and pinned library/corner; its metrics are component estimates and do not produce workload PPA. integration/implementation/ppa retain the complete compiled-design boundary. Keep original source/config and reproduction commands. Semantic review may veto. Worker reports are debug evidence only.',
  passRule: 'All requested identity, nonempty coverage, numerical comparisons, integration and report checks succeed. Missing evidence fails. Quantized error rules require independent review justification.',
  maxWallClockMs: 10 * 60 * 1000, evidenceSchema: z.toJSONSchema(buckyballEvidenceSchema) as JsonObject }
export const BUCKYBALL_RECIPE_REF: Ref = { id: 'buckyball:recipe:independent-evidence', digest: computeDigest('object', BUCKYBALL_RECIPE) }
export function buckyballCheck(kind: BuckyballCheckKind): ExecutableCheck {
  return { checkId: kind, recipeRef: BUCKYBALL_RECIPE_REF, params: { kind, manifest: 'evidence.json' } }
}
export function describeBuckyballCheck({ check, spec }: { check: ExecutableCheck; spec: Pick<TaskSpec, 'criteria'> }) {
  const params = z.object({ kind: z.enum(BUCKYBALL_CHECK_KINDS), manifest: z.string().regex(/^[A-Za-z0-9_./-]+\.json$/) }).parse(check.params)
  if (params.manifest.split('/').includes('..')) throw new AdmissionError('INVALID_ARGUMENT', 'Buckyball evidence manifest must stay in the current evidence directory')
  if (spec.criteria.some(criterion => criterion.id === 'task-goal' && criterion.required
    && criterion.checks.every(value => value.params.kind === 'delivery'))) {
    throw new AdmissionError('INVALID_ARGUMENT', 'Buckyball task-goal needs a technical check covering its goal; delivery only verifies file identities. Choose an applicable public recipe scope or keep unsupported work local.')
  }
  return { displayCommand: [...BUCKYBALL_RECIPE.entrypoint, '--project', 'project.json', '--root', '.', '--manifest', params.manifest, '--kind', params.kind, '--report', `checks/${encodeURIComponent(check.checkId)}.json`],
    expectedReport: { checksRun: 1, failures: [], metrics: { coverage: 'nonempty for the selected check' } } }
}
const sameFile = (a: z.infer<typeof file>, b: z.infer<typeof file>) => a.path === b.path && a.digest === b.digest
export class BuckyballEvidenceError extends Error {}
// Use the prepared compiler's native MLIR bindings and existing Chip.pb reader.
const inspectMapping = `import json, sys
from pathlib import Path
project, llvm_build, recipe, graph, chip_path, entrypoint = sys.argv[1:]
project = Path(project)
sys.path.insert(0, str(Path(llvm_build) / 'tools/mlir/python_packages/mlir_core'))
sys.path.insert(0, str(project / 'stack/compiler/scripts'))
from mlir import ir
import pb_to_target_registry as registry
def walk(op):
    yield op
    for region in op.regions:
        for block in region.blocks:
            for child in block.operations:
                yield from walk(child.operation)
def operations(path):
    with ir.Context() as context:
        context.allow_unregistered_dialects = True
        module = ir.Module.parse(Path(path).read_text())
        functions = {ir.StringAttr(op.attributes['sym_name']).value: op
                     for op in walk(module.operation) if op.name == 'func.func'}
        pending, seen, result = [entrypoint], set(), []
        while pending:
            name = pending.pop()
            if name in seen or name not in functions: continue
            seen.add(name)
            function = functions[name]
            for op in walk(function):
                result.append({'name': op.name})
                if op.name == 'func.call':
                    pending.append(ir.FlatSymbolRefAttr(op.attributes['callee']).value)
        return result
chip = registry._load_proto(project).Chip()
chip.ParseFromString(Path(chip_path).read_bytes())
targets = []
for profile in chip.profiles:
    core = registry._profile_core(chip, profile)
    registry._validate_profile(profile, core)
    targets.append({'name': profile.name, 'core': core.pkg,
        'balls': [{'name': ball.ball_name, 'id': ball.ball_id, 'module': ball.ball_class.rsplit('.', 1)[-1]} for ball in core.balldomain.mappings],
        'isa': [{'name': entry.mnemonic, 'id': entry.bid} for entry in core.balldomain.isa]})
print(json.dumps({'recipe': operations(recipe), 'graph': operations(graph), 'targets': targets}))
`
const operation = z.object({ name: z.string() })
const mappingSchema = z.object({ recipe: z.array(operation), graph: z.array(operation), targets: z.array(z.object({
  name: z.string(), core: z.string(), balls: z.array(z.object({ name: z.string(), id: z.number().int(), module: z.string().min(1) })),
  isa: z.array(z.object({ name: z.string(), id: z.number().int() })),
})) })
async function readCompilerMapping(root: string, data: z.infer<typeof compilerEvidence>, projectFile: string, signal?: AbortSignal) {
  const project = JSON.parse(await readFile(projectFile, 'utf8')) as { source: { destination: string }; toolchain: { llvmBuild: string } }
  const toolchain = project.source.destination, termination = new AbortController()
  const cancel = () => { termination.abort(new Error('Checker terminated')) }
  process.once('SIGTERM', cancel)
  try {
    const execution = promisify(execFile)(resolve(toolchain, 'result/bin/python3'), ['-c', inspectMapping, toolchain, project.toolchain.llvmBuild,
      resolve(root, data.recipe.path), resolve(root, data.graph.path), resolve(root, data.compiler.path), data.entrypoint],
    { signal: AbortSignal.any([termination.signal, ...(signal === undefined ? [] : [signal])]), maxBuffer: 8 * 1024 * 1024 })
    const closed = new Promise<void>(resolve => { execution.child.once('close', () => { resolve() }) })
    let parsed
    try { parsed = await execution } finally { await closed }
    return mappingSchema.parse(JSON.parse(parsed.stdout))
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error
    throw new BuckyballEvidenceError(`Native MLIR/Chip.pb inspection failed: ${(error as Error).message}`)
  } finally { process.removeListener('SIGTERM', cancel) }
}
const netlistSchema = z.object({ modules: z.record(z.string(), z.object({ attributes: z.object({ hdlname: z.string().optional() }),
  cells: z.record(z.string(), z.object({ type: z.string() })) })) })
function instanceModules(netlist: z.infer<typeof netlistSchema>, top: string, instance: string) {
  const path = [top]
  if (instance === '.') return path
  for (const name of instance.split('/')) {
    const parent = path.at(-1) ?? ''
    path.push(Object.hasOwn(netlist.modules, parent) && Object.hasOwn(netlist.modules[parent].cells, name) ? netlist.modules[parent].cells[name].type : '')
  }
  return path
}
export function parseSynthesisReport(text: string, raw: { power: string; timing: string; area: string }) {
  const identity = z.object({ sourceDigest: z.string(), configDigest: z.string(), rtlTop: z.string(),
    activeInstances: z.array(z.string()), memoryModels: z.array(z.string()), boundary }).parse(JSON.parse(text))
  const power = (label: string) => {
    const found = new RegExp(`${label}\\s*=\\s*([\\d.eE+-]+)\\s*(pW|nW|uW|mW|W)`).exec(raw.power)
    if (found === null) throw new BuckyballEvidenceError(`Synthesis power report lacks ${label} with units`)
    const units: Record<string, number> = { pW: 1e-9, nW: 1e-6, uW: 1e-3, mW: 1, W: 1e3 }
    return z.number().nonnegative().parse(Number(found[1]) * units[found[2]])
  }
  const arrival = /data arrival time\s+([\d.eE+-]+)/.exec(raw.timing)
  const area = /Total cell area:\s*([\d.eE+-]+)/.exec(raw.area)
  if (arrival === null || area === null) throw new BuckyballEvidenceError('Synthesis reports lack achieved data arrival time or mapped total cell area')
  // DC report_units is retained in the raw reports; no inference from a target clock.
  if (!/Time Units\s*:\s*1ns/.test(raw.timing) || !/Area Units\s*:\s*1um2/.test(raw.area)) throw new BuckyballEvidenceError('Synthesis reports must declare ns and um2 units')
  return { ...identity, powerMw: power('Total Dynamic Power') + power('Cell Leakage Power'),
    criticalPathNs: z.number().positive().parse(Number(arrival[1])), areaUm2: z.number().positive().parse(Number(area[1])) }
}

/** This finite domain checker computes comparisons; it does not read an LLM verdict or a PASS string. */
export async function checkBuckyballEvidence(root: string, kind: BuckyballCheckKind, manifest: string, projectFile: string, signal?: AbortSignal): Promise<JsonObject> {
  const failures: string[] = []
  let checksRun = 0
  const metrics: JsonObject = {}
  const check = (condition: boolean, reason: string) => { checksRun += 1; if (!condition) failures.push(reason) }
  const read = async (identity: z.infer<typeof file>) => {
    const bytes = await readFile(resolve(root, identity.path))
    check(`sha256:${createHash('sha256').update(bytes).digest('hex')}` === identity.digest, `identity mismatch: ${identity.path}`)
    return bytes.toString('utf8')
  }
  const input = buckyballEvidenceSchema.safeParse(JSON.parse(await readFile(resolve(root, manifest), 'utf8')))
  if (!input.success) return { checksRun: 1, failures: input.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`), metrics }
  const evidence = input.data
  await read(evidence.design.source)
  const configuration = z.object({ precision: z.string().min(1) }).parse(JSON.parse(await read(evidence.design.config)))
  check(configuration.precision === evidence.design.compiledPrecision, 'declared compiled precision differs from the reproduced compiler configuration')
  const compare = async (item: { reference: z.infer<typeof file>; actual: z.infer<typeof file> }, rtol: number, atol: number, integer = false) => {
    const expected = z.array(z.number()).min(1).parse(JSON.parse(await read(item.reference)))
    const actual = z.array(z.number()).min(1).parse(JSON.parse(await read(item.actual)))
    if (integer) check(expected.every(Number.isSafeInteger) && actual.every(Number.isSafeInteger), 'integer reference comparison requires exact safe-integer values')
    check(expected.length === actual.length, 'numerical tensor lengths differ')
    const valuesCompared = Math.min(expected.length, actual.length)
    let mismatches = Math.abs(expected.length - actual.length), maxAbsError = 0
    for (let index = 0; index < valuesCompared; index += 1) {
      const value = expected[index], error = Math.abs(value - actual[index])
      maxAbsError = Math.max(maxAbsError, error)
      if (!(error <= atol + rtol * Math.abs(value))) mismatches += 1
    }
    return { valuesCompared, mismatches, maxAbsError }
  }
  const inspectCompiler = async (data: z.infer<typeof compilerEvidence>) => {
    await read(data.recipe); await read(data.graph); await read(data.compiler)
    const build = compilerBuild.parse(JSON.parse(await read(data.buildReport)))
    const targetFlag = build.compilerCommand.indexOf('--target')
    const compiledTarget = build.compilerCommand.find(arg => arg.startsWith('--target='))?.slice('--target='.length)
      ?? (targetFlag < 0 ? undefined : build.compilerCommand[targetFlag + 1])
    const mapping = await readCompilerMapping(root, data, projectFile, signal)
    for (const route of data.routes) {
      check(mapping.recipe.some(op => op.name === route.operation), `recipe entrypoint does not call ${route.operation}`)
      check(mapping.graph.some(op => op.name === route.mappedOperation && compiledTarget === route.compilerTarget), `generated graph does not map to ${route.mappedOperation}/${route.compilerTarget}`)
      const target = mapping.targets.find(target => target.name === route.compilerTarget && target.core === route.core)
      const ball = target?.balls.find(ball => ball.name === route.ball)
      check(ball !== undefined && target?.isa.some(isa => isa.name === route.isa && isa.id === ball.id) === true, `registered target/core/Ball/ISA route absent: ${route.ball}`)
    }
    check(build.sourceDigest === evidence.design.source.digest && build.configDigest === evidence.design.config.digest, 'build source/config identity differs')
    check(build.exitCode === 0, 'compiler did not complete successfully')
    return mapping
  }
  if (kind === 'host-reference') {
    const data = evidence.hostReference
    if (data === undefined) return { checksRun: checksRun + 1, failures: [...failures, 'independent original-host reference evidence missing'], metrics }
    const project = z.object({ cosyvoice: z.object({ revision: z.string() }), checkpoint: z.object({ revision: z.string() }) }).parse(JSON.parse(await readFile(projectFile, 'utf8')))
    check(data.sourceRevision === project.cosyvoice.revision && data.checkpointRevision === project.checkpoint.revision, 'host reference source/checkpoint differs from pinned original model')
    check(sameFile(data.source, evidence.design.source) && sameFile(data.config, evidence.design.config), 'host reference source/config differs from reproduced original-host design')
    let valuesCompared = 0, mismatches = 0, maxAbsError = 0
    for (const item of data.cases) {
      await read(item.input); await read(item.checkpoint); await read(item.comparator)
      const compared = await compare(item, item.precision === 'FP32' ? 1e-4 : 0, item.precision === 'FP32' ? 1e-5 : 0, item.precision === 'integer')
      valuesCompared += compared.valuesCompared; mismatches += compared.mismatches; maxAbsError = Math.max(maxAbsError, compared.maxAbsError)
    }
    check(valuesCompared > 0 && mismatches === 0, 'independent original-host reference comparison failed')
    Object.assign(metrics, { casesRun: data.cases.length, stages: new Set(data.cases.map(x => x.stage)).size, valuesCompared, mismatches, maxAbsError })
  }
  if (kind === 'numerical') {
    if (evidence.numerical === undefined) return { checksRun: checksRun + 1, failures: [...failures, 'actual compiled-arm numerical evidence missing'], metrics }
    let valuesCompared = 0, mismatches = 0, maxAbsError = 0
    for (const item of evidence.numerical) {
      await read(item.input); await read(item.checkpoint); await read(item.comparator)
      check(sameFile(item.compiledSource, evidence.design.source) && sameFile(item.compiledConfig, evidence.design.config), 'numerical arm source/config differs from actual compiled design')
      check(item.precision === evidence.design.compiledPrecision, 'numerical report does not exercise actual compiled precision')
      if (item.precision === 'FP32') check(item.rtol === 1e-4 && item.atol === 1e-5, 'FP32 rules differ from the frozen reference contract')
      const compared = await compare(item, item.rtol, item.atol)
      valuesCompared += compared.valuesCompared; mismatches += compared.mismatches; maxAbsError = Math.max(maxAbsError, compared.maxAbsError)
    }
    check(valuesCompared > 0 && mismatches === 0, 'independent actual-arm comparison failed')
    Object.assign(metrics, { casesRun: evidence.numerical.length, valuesCompared, mismatches, maxAbsError })
  }
  if (kind === 'compiler') {
    const data = evidence.compiler
    if (data === undefined) return { checksRun: checksRun + 1, failures: [...failures, 'independent compiler evidence missing'], metrics }
    const mapping = await inspectCompiler(data)
    Object.assign(metrics, { routes: data.routes.length, recipeOperations: mapping.recipe.length, mappedOperations: mapping.graph.length, targets: mapping.targets.length })
  }
  if (kind === 'integration' || kind === 'implementation' || kind === 'ppa') {
    const integration = evidence.integration
    if (integration === undefined) return { checksRun: checksRun + 1, failures: [...failures, 'recipe/compiler/RTL integration evidence missing'], metrics }
    const mapping = await inspectCompiler(integration)
    const rtl = netlistSchema.parse(JSON.parse(await read(integration.rtl)))
    const build = compilerBuild.extend({ rtlTop: z.string(), synthesized: z.boolean() }).parse(JSON.parse(await read(integration.buildReport)))
    for (const route of integration.routes) {
      const target = mapping.targets.find(target => target.name === route.compilerTarget && target.core === route.core)
      const ball = target?.balls.find(ball => ball.name === route.ball)
      const path = instanceModules(rtl, route.rtlTop, route.instance), module = path.at(-1) ?? '', hasModule = Object.hasOwn(rtl.modules, module)
      check(path.includes(route.rtlCore) && module === route.rtlBall && hasModule, `generated RTL has no reachable Core/Ball instance ${route.instance}`)
      check(ball !== undefined && (module === ball.module || hasModule && rtl.modules[module].attributes.hdlname === ball.module), `RTL instance differs from registered Ball class: ${route.ball}`)
    }
    check(build.exitCode === 0 && build.synthesized && integration.routes.every(route => route.rtlTop === build.rtlTop), 'build did not reproduce the integrated RTL top')
    const component = z.object({ casesRun: z.number().int().positive(), comparisons: z.number().int().positive(), mismatches: z.number().int().nonnegative(), sourceDigest: z.string(), configDigest: z.string() }).parse(JSON.parse(await read(integration.componentReport)))
    check(component.sourceDigest === evidence.design.source.digest && component.configDigest === evidence.design.config.digest && component.mismatches === 0, 'component coverage failed or source/config differs')
    Object.assign(metrics, { routes: integration.routes.length, componentCases: component.casesRun, comparisons: component.comparisons })
  }
  let reproducedPpa: JsonObject | undefined
  if (kind === 'ppa' || kind === 'synthesis') {
    const data = kind === 'ppa' ? evidence.ppa : evidence.synthesis
    if (data === undefined) return { checksRun: checksRun + 1, failures: [...failures, kind === 'ppa' ? 'actual workload PPA evidence missing' : 'independent component synthesis evidence missing'], metrics }
    const report = parseSynthesisReport(await read(data.report), { power: await read(data.rawReports.power), timing: await read(data.rawReports.timing), area: await read(data.rawReports.area) })
    await read(data.boundary.library)
    check(sameFile(data.design.source, evidence.design.source) && sameFile(data.design.config, evidence.design.config), 'PPA design source/config differs from compiled design')
    check(report.sourceDigest === data.design.source.digest && report.configDigest === data.design.config.digest, 'PPA report source/config identity differs')
    check(JSON.stringify(report.boundary) === JSON.stringify(data.boundary), 'PPA report workload/external boundary/measurement conditions differ')
    check(report.rtlTop === data.design.rtlTop, 'synthesis report covers a different RTL top')
    check(JSON.stringify(report.activeInstances) === JSON.stringify(data.design.activeInstances), 'synthesis report active instances differ from declared boundary')
    check(JSON.stringify(report.memoryModels) === JSON.stringify(data.design.memoryModels), 'PPA memory models differ')
    if (kind === 'ppa' && evidence.integration !== undefined) {
      check(evidence.integration.routes.every(route => route.rtlTop === report.rtlTop), 'PPA report covers a different RTL top')
      check(evidence.integration.routes.every(route => data.design.activeInstances.includes(route.instance)), 'PPA does not cover workload active instances')
      reproducedPpa = { power: report.powerMw, delay: report.criticalPathNs, area: report.areaUm2,
        conditionsDigest: computeDigest('object', data.boundary), design: data.design, boundary: data.boundary, report: data.report, command: data.command }
    }
    if (kind === 'synthesis' && evidence.synthesis !== undefined) {
      const rtl = netlistSchema.parse(JSON.parse(await read(evidence.synthesis.rtl)))
      const project = z.object({ eda: z.object({ corner: z.string(), librarySha256: z.string() }) }).parse(JSON.parse(await readFile(projectFile, 'utf8')))
      check(data.boundary.library.digest === `sha256:${project.eda.librarySha256}` && data.boundary.corner === project.eda.corner, 'synthesis library/corner differs from pinned project')
      check(Object.hasOwn(rtl.modules, data.design.rtlTop), 'synthesis RTL top is absent from generated netlist')
      let activeInstances = 0
      for (const instance of data.design.activeInstances) {
        const path = instanceModules(rtl, data.design.rtlTop, instance), module = path.at(-1) ?? ''
        const reachable = path.every(name => name.length > 0 && Object.hasOwn(rtl.modules, name))
        check(reachable, `synthesis boundary instance is absent from generated netlist: ${instance}`)
        if (reachable && module.length > 0) activeInstances += 1
      }
      Object.assign(metrics, { scope: 'component-logic-synthesis', modules: Object.keys(rtl.modules).length, activeInstances,
        powerMw: report.powerMw, criticalPathNs: report.criticalPathNs, areaUm2: report.areaUm2, conditionsDigest: computeDigest('object', data.boundary) })
    }
  }
  if (kind === 'delivery') {
    check(evidence.delivery !== undefined && evidence.delivery.length > 0, 'reproducible delivery evidence missing')
    for (const identity of evidence.delivery ?? []) await read(identity)
  }
  return { checksRun, failures, metrics, ...(reproducedPpa === undefined ? {} : { ppa: reproducedPpa }) }
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const args = process.argv.slice(2), option = (name: string) => args[args.indexOf(name) + 1]
  const kind = z.enum(BUCKYBALL_CHECK_KINDS).parse(option('--kind'))
  let result: JsonObject
  try {
    result = await checkBuckyballEvidence(resolve(option('--root')), kind, option('--manifest'), option('--project'))
  }
  catch (error) {
    if (!(error instanceof BuckyballEvidenceError) && !(error instanceof SyntaxError) && !(error instanceof z.ZodError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    result = { checksRun: 1, failures: [error instanceof Error ? error.message : String(error)] }
  }
  const report = resolve(option('--report'))
  await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result)); process.exitCode = (result.failures as unknown[]).length === 0 ? 0 : 1
}
