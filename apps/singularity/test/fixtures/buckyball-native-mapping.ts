import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { checkBuckyballEvidence } from '../../examples/buckyball-checks.ts'
import { writeBuckyballEvidence } from './buckyball-evidence.ts'

/** Operator smoke of real parsers and hierarchy; tiny synthetic design, no chip claim. */
export async function nativeMappingSmoke(projectFile: string, root: string) {
  const project = JSON.parse(await readFile(projectFile, 'utf8')) as { source: { destination: string }; eda: { library: string; corner: string } }
  const baseline = project.source.destination, python = join(baseline, 'result/bin/python3')
  const inspect = await promisify(execFile)(python, ['-c', `import json, sys
from pathlib import Path
project = Path(sys.argv[1])
sys.path.insert(0, str(project / 'stack/compiler/scripts'))
import pb_to_target_registry as registry
chip = registry._load_proto(project).Chip()
chip.ParseFromString((project / 'examples/chips/toy/configs/generated/chip.pb').read_bytes())
for profile in chip.profiles:
    core = registry._profile_core(chip, profile)
    registry._validate_profile(profile, core)
    for ball in core.balldomain.mappings:
        for isa in core.balldomain.isa:
            if isa.bid == ball.ball_id:
                print(json.dumps(dict(target=profile.name, core=core.pkg, ball=ball.ball_name, module=ball.ball_class.rsplit('.', 1)[-1], isa=isa.mnemonic)))
                sys.exit(0)
raise ValueError('No native registered Ball/ISA fixture')`, baseline])
  const registration = JSON.parse(inspect.stdout) as { target: string; core: string; ball: string; module: string; isa: string }
  const evidence = await writeBuckyballEvidence(root)
  const integration = evidence.integration, ppa = evidence.ppa
  assert.ok(integration); assert.ok(ppa)
  const identity = async (path: string) => ({ path, digest: `sha256:${createHash('sha256').update(await readFile(join(root, path))).digest('hex')}` })
  const file = async (path: string, value: string) => { await writeFile(join(root, path), value); return identity(path) }
  const mlir = (name: string, dead = false) => `module {
    "func.func"() ({ ${dead ? '' : `"${name}"() : () -> ()`} "func.return"() : () -> () }) {sym_name = "main", function_type = () -> ()} : () -> ()
    ${dead ? `// ${name} is only mentioned here and in an unreachable function.\n"func.func"() ({ "${name}"() : () -> () "func.return"() : () -> () }) {sym_name = "unused", function_type = () -> ()} : () -> ()` : ''}
  }`
  integration.recipe = await file('recipe.mlir', mlir('test.conv1d'))
  integration.graph = await file('graph.mlir', mlir('buckyball.test'))
  await copyFile(join(baseline, 'examples/chips/toy/configs/generated/chip.pb'), join(root, 'chip.pb'))
  integration.compiler = await identity('chip.pb')
  integration.entrypoint = 'main'
  integration.routes = [{ operation: 'test.conv1d', mappedOperation: 'buckyball.test', compilerTarget: registration.target,
    core: registration.core, ball: registration.ball, isa: registration.isa, rtlTop: 'Frontend', rtlCore: 'NativeCore', rtlBall: registration.module, instance: 'core/ball' }]
  const build = JSON.parse(await readFile(join(root, integration.buildReport.path), 'utf8')) as { compilerCommand: string[] }
  build.compilerCommand = ['buddy-opt', `--target=${registration.target}`]
  integration.buildReport = await file(integration.buildReport.path, JSON.stringify(build))
  const rtlSource = join(root, 'native.v'), netlist = join(root, 'native.json')
  const synthesize = async (used: boolean) => {
    await writeFile(rtlSource, `module ${registration.module}(input i, output o); assign o=i; endmodule
module NativeCore(input i, output o); ${used ? `${registration.module} ball(.i(i),.o(o));` : 'assign o=i;'} endmodule
module Frontend(input i, output o); NativeCore core(.i(i),.o(o)); endmodule`)
    await promisify(execFile)(join(baseline, 'result/bin/yosys'), ['-Q', '-T', '-p', `read_verilog ${JSON.stringify(rtlSource)}; hierarchy -check -top Frontend; write_json ${JSON.stringify(netlist)}`])
    integration.rtl = await identity('native.json')
  }
  await synthesize(true)
  ppa.design.activeInstances = ['core/ball']
  await copyFile(project.eda.library, join(root, 'library.lib'))
  ppa.boundary.library = await identity('library.lib')
  ppa.boundary.corner = project.eda.corner
  const normalized = JSON.parse(await readFile(join(root, ppa.report.path), 'utf8')) as { activeInstances: string[]; boundary: typeof ppa.boundary }
  normalized.activeInstances = ppa.design.activeInstances
  normalized.boundary = ppa.boundary
  ppa.report = await file(ppa.report.path, JSON.stringify(normalized))
  const save = () => {
    evidence.compiler = { recipe: integration.recipe, graph: integration.graph, compiler: integration.compiler, entrypoint: integration.entrypoint,
      routes: integration.routes.map(({ operation, mappedOperation, compilerTarget, core, ball, isa }) => ({ operation, mappedOperation, compilerTarget, core, ball, isa })), buildReport: integration.buildReport }
    evidence.synthesis = { ...ppa, rtl: integration.rtl }
    return writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
  }
  await save()
  for (const kind of ['compiler', 'integration', 'implementation', 'ppa', 'synthesis'] as const) {
    assert.deepEqual((await checkBuckyballEvidence(root, kind, 'evidence.json', projectFile)).failures, [], kind)
  }
  for (const stage of ['recipe', 'graph'] as const) {
    const original = integration[stage]
    integration[stage] = await file(original.path, mlir(stage === 'recipe' ? 'test.conv1d' : 'buckyball.test', true))
    await save()
    for (const kind of ['compiler', 'ppa'] as const) {
      assert.ok(((await checkBuckyballEvidence(root, kind, 'evidence.json', projectFile)).failures as unknown[]).length)
    }
    integration[stage] = await file(original.path, mlir(stage === 'recipe' ? 'test.conv1d' : 'buckyball.test'))
  }
  const registeredModule = integration.routes[0].rtlBall
  integration.routes[0].rtlBall = 'NativeCore'
  integration.routes[0].instance = 'core'
  await save()
  assert.ok(((await checkBuckyballEvidence(root, 'integration', 'evidence.json', projectFile)).failures as string[])
    .some(failure => failure.startsWith('RTL instance differs from registered Ball class:')))
  integration.routes[0].rtlBall = registeredModule
  integration.routes[0].instance = 'core/ball'
  await synthesize(false); await save()
  assert.ok(((await checkBuckyballEvidence(root, 'ppa', 'evidence.json', projectFile)).failures as unknown[]).length)
  assert.ok(((await checkBuckyballEvidence(root, 'synthesis', 'evidence.json', projectFile)).failures as unknown[]).length)
  return { native: ['MLIR parser and reachable func.call traversal', 'Chip.pb and existing target registry', 'Yosys hierarchy/write_json'],
    positiveChecks: 5, scopes: ['compiler', 'integration', 'implementation', 'ppa', 'synthesis'],
    rejected: ['comment/unreachable recipe operation', 'comment/unreachable mapped operation', 'unrelated instantiated module', 'registered but uninstantiated Ball'],
    boundary: 'Tiny operator readiness design, not CosyVoice frontend or PPA improvement.' }
}
