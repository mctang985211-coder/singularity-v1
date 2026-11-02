import { createHash } from 'node:crypto'
import { chmod,mkdir,readFile,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'

import type { BuckyballEvidence } from '../../examples/buckyball-checks.ts'

/** Explicit process mock for dependency-free tests; it never parses MLIR or Chip.pb. */
export async function writeSyntheticBuckyballToolchain(root: string, baseline = join(root, 'mockbaseline')) {
  baseline = resolve(baseline)
  const llvmBuild = resolve(root, 'mockllvm'), project = resolve(root, 'project.json')
  await mkdir(join(baseline, 'result/bin'), { recursive: true })
  await mkdir(llvmBuild, { recursive: true })
  const executable = join(baseline, 'result/bin/python3')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [baseline, llvmBuild, recipe, graph, chip, entrypoint] = process.argv.slice(4);
if (process.argv[2] !== '-c' || baseline !== path.resolve(__dirname, '../..') || !fs.statSync(llvmBuild).isDirectory()) throw new Error('Invalid synthetic native-inspection invocation');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify({recipe: read(recipe).entrypoints[entrypoint] ?? [], graph: read(graph).entrypoints[entrypoint] ?? [], targets: read(chip).targets}));
`)
  await chmod(executable, 0o755)
  await writeFile(project, JSON.stringify({ source: { destination: baseline }, toolchain: { llvmBuild },
    cosyvoice: { revision: 'fixture-source-revision' }, checkpoint: { revision: 'fixture-checkpoint-revision' },
    evidenceLevel: 'Synthetic native-inspection process mock; not MLIR, Chip.pb or hardware validation.' }))
  return { baseline, llvmBuild, project }
}

/** Synthetic executable-evidence fixture; never an input to a solver or a real chip success claim. */
export async function writeBuckyballEvidence(root: string, options: { sourceText?: string; actual?: string; factor?: number } = {}): Promise<BuckyballEvidence> {
  await mkdir(root, { recursive: true })
  await writeSyntheticBuckyballToolchain(root)
  const file = async (path: string, content: string) => {
    await writeFile(join(root, path), content)
    return { path, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` }
  }
  const source = await file('source.txt', options.sourceText ?? 'conv1d mapped frontend sources')
  const config = await file('config.json', '{"precision":"MXFP8"}')
  const library = await file('library.lib', 'fixed test library')
  const boundary = { workload: 'conv1d', interface: 'all outputs', hostOffload: 'none', library, corner: 'TT', clock: '10 ns', activity: '0.1', method: 'mapped-vectorless' }
  const design = { source, config, rtlTop: 'Frontend', activeInstances: ['core_0/ball_0'], memoryModels: ['sram'] }
  const module = (cells: Record<string, { type: string }>) => ({ attributes: {}, ports: {}, netnames: {},
    cells: Object.fromEntries(Object.entries(cells).map(([name, value]) => [name, {
      hide_name: 0, type: value.type, parameters: {}, attributes: {}, port_directions: {}, connections: {},
    }])) })
  const value: BuckyballEvidence = {
    design: { source, config, compiledPrecision: 'MXFP8' },
    numerical: [{ reference: await file('reference.json', '[0,1,2,3]'), actual: await file('actual.json', options.actual ?? '[0,1,2,3]'),
      input: await file('input.json', '[0,1,2,3]'), checkpoint: await file('checkpoint', 'pinned fixture checkpoint'), comparator: await file('compare.py', '# independently reproduced comparator fixture'),
      compiledSource: source, compiledConfig: config, precision: 'MXFP8', quantization: 'exactly representable fixture values', rtol: 0, atol: 0 }],
    integration: { recipe: await file('recipe.mock.json', JSON.stringify({ entrypoints: { main: [{ name: 'tosa.conv1d', target: null }] } })),
      graph: await file('graph.mock.json', JSON.stringify({ entrypoints: { main: [{ name: 'buckyball.conv1d', target: 'toy' }] } })),
      compiler: await file('chip.mock.json', JSON.stringify({ targets: [{ name: 'toy', core: 'Core',
        balls: [{ name: 'Conv1dBall', id: 7, module: 'Conv1dBall' }], isa: [{ name: 'CONV1D', id: 7 }] }] })),
      rtl: await file('frontend.yosys.json', JSON.stringify({ creator: 'synthetic Yosys write_json fixture', modules: {
        Frontend: module({ core_0: { type: 'Core' } }), Core: module({ ball_0: { type: 'Conv1dBall' } }), Conv1dBall: module({}),
      } })), entrypoint: 'main',
      routes: [{ operation: 'tosa.conv1d', mappedOperation: 'buckyball.conv1d', compilerTarget: 'toy', core: 'Core', ball: 'Conv1dBall', isa: 'CONV1D',
        rtlTop: 'Frontend', rtlCore: 'Core', rtlBall: 'Conv1dBall', instance: 'core_0/ball_0' }],
      componentReport: await file('component.json', JSON.stringify({ casesRun: 4, comparisons: 16, mismatches: 0, sourceDigest: source.digest, configDigest: config.digest })),
      buildReport: await file('build.json', JSON.stringify({ sourceDigest: source.digest, configDigest: config.digest, exitCode: 0, rtlTop: 'Frontend',
        synthesized: true, compilerCommand: ['buddy-opt', '--target=toy'] })) },
    ppa: { boundary, design, report: await file('ppa.json', JSON.stringify({ powerMw: 10, criticalPathNs: 2, areaUm2: 100,
      sourceDigest: source.digest, configDigest: config.digest, rtlTop: design.rtlTop, activeInstances: design.activeInstances, memoryModels: design.memoryModels, boundary })),
      rawReports: { power: await file('power.rpt', `Total Dynamic Power = ${String(9 * (options.factor ?? 1))} mW\nCell Leakage Power = ${String(options.factor ?? 1)} mW\n`), timing: await file('timing.rpt', `Time Units : 1ns\ndata arrival time ${String(2 * (options.factor ?? 1))}\n`), area: await file('area.rpt', `Area Units : 1um2\nTotal cell area: ${String(100 * (options.factor ?? 1))}\n`) },
      command: ['fixture-synthesis', '--top', 'Frontend'] },
    delivery: [source, config],
  }
  const projectValue = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(root, 'project.json'), JSON.stringify({ ...projectValue, eda: { corner: boundary.corner, librarySha256: library.digest.slice('sha256:'.length) } }))
  const numerical = value.numerical?.[0], integration = value.integration
  if (numerical !== undefined) value.hostReference = { source, config, sourceRevision: 'fixture-source-revision', checkpointRevision: 'fixture-checkpoint-revision',
    cases: [{ stage: 'fixture', reference: numerical.reference, actual: numerical.actual, input: numerical.input, checkpoint: numerical.checkpoint, comparator: numerical.comparator, precision: 'integer' }] }
  if (integration !== undefined) value.compiler = { recipe: integration.recipe, graph: integration.graph, compiler: integration.compiler,
    entrypoint: integration.entrypoint, routes: integration.routes.map(({ operation, mappedOperation, compilerTarget, core, ball, isa }) => ({ operation, mappedOperation, compilerTarget, core, ball, isa })), buildReport: integration.buildReport }
  if (value.ppa !== undefined && integration !== undefined) value.synthesis = { ...value.ppa, rtl: integration.rtl }
  await writeFile(join(root, 'evidence.json'), JSON.stringify(value, null, 2))
  return value
}
