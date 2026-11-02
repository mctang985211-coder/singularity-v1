import { constants } from 'node:fs'
import { open,readFile,readdir } from 'node:fs/promises'
import { join,relative } from 'node:path'

import type { SkillAsset } from '@singularity/protocol'
import { canonicalize,computeDigestBytes } from '@singularity/protocol'
import type { CasObjectReader,CasObjectWriter,FrozenSkillResource } from '@singularity/runtime'
import { compareBundlePath,readSkills,sealTreeManifest } from '@singularity/runtime'

const skillDescriptions: Record<string, string> = {
  'model-port': 'Prepare original references, recipes and frontend integration. Load model-optimize during design and ball-align for compiler/RTL contracts.',
  'model-optimize': 'Select numerical contracts, layouts, bank reuse and scheduling from workload evidence; use during model-port design or measured optimization.',
  'chip-designer': 'Design chip topology, memory and inter-core interfaces and integrate actual cores.',
  'ip-designer': 'Implement reusable Chisel IP and independently verify its interface with existing UVM infrastructure.',
  'ball-align': 'Align Ball ISA, compiler, emulator, RTL and focused tests; load check for registration and workload-tests for cases.',
  'workload-tests': 'Build focused operator and component tests using active parameters and regression manifests.',
  'debug-compiler': 'Diagnose model import and lowering failures through current compiler tooling; use before mapped-arm validation.',
  check: 'Check actual Ball registration and generated topology consistency.',
  report: 'Report artifacts, commands, coverage, numerical/PPA data and retry evidence provenance.',
}

/** Domain-maintained entrypoints replace the old workflow; every supporting file is frozen intact. */
export async function freezeBuckyballSkills(writer: CasObjectWriter, baseline: string): Promise<SkillAsset[]> {
  const skills: SkillAsset[] = []
  for (const [name, description] of Object.entries(skillDescriptions)) {
    const sourceRoot = join(baseline, '.agents/skills', name)
    const sourceFiles: { path: string; digest: string }[] = []
    const files = new Map<string, Uint8Array>()
    for (const entry of await readdir(sourceRoot, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      const path = relative(sourceRoot, join(entry.parentPath, entry.name))
      const file = await open(join(sourceRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW)
      let data: Uint8Array
      try { data = await file.readFile() } finally { await file.close() }
      sourceFiles.push({ path, digest: computeDigestBytes('object', data) })
      files.set(path, data)
    }
    const adapted = await readFile(new URL(`./buckyball-skills/${name}/SKILL.md`, import.meta.url))
    files.set('SKILL.md', adapted)
    files.set('ADAPTATION.json', new TextEncoder().encode(canonicalize({
      v: 1, source: sourceRoot, sourceFiles: sourceFiles.sort((a, b) => compareBundlePath(a.path, b.path)),
      entrypoint: { path: `apps/singularity/examples/buckyball-skills/${name}/SKILL.md`, digest: computeDigestBytes('object', adapted) },
      scope: 'Frontend experiment: autonomous design under frozen Task checks; focused component tests and logical synthesis. Whole-model BEMU, full-chip simulation, P2E/FPGA and physical backend excluded.',
      adaptation: 'Retain domain knowledge and complete source resources. Replace conflicting completion/approval flows, obsolete tool names and cross-skill filesystem links with current native skill names.',
    })))
    const frozen = []
    for (const [path, data] of [...files].sort(([a], [b]) => compareBundlePath(a, b))) {
      frozen.push({ path, bytes: data.byteLength, object: await writer.putObject(`buckyball:skill:${name}:${path}`, data) })
    }
    const bundle = await writer.putObject(`buckyball:skill:${name}`, new TextEncoder().encode(canonicalize(sealTreeManifest(frozen))))
    skills.push({ id: name, name, description, bundle })
  }
  return skills
}

/** Reviewer and worker resolve the same frozen assets through the runtime skill codec. */
export function readBuckyballSkills(reader: CasObjectReader, skills: readonly SkillAsset[]): Promise<readonly FrozenSkillResource[]> {
  return readSkills(reader, { skills: [...skills] }, { skills: skills.map(skill => skill.id) }, skills.map(skill => skill.bundle))
}
