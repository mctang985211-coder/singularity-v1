import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

async function text(relative) {
  return readFile(path.join(root, relative), 'utf8')
}

for (const relative of [
  'AGENTS.md',
  'README.md',
  'docs/framework.md',
  'docs/conformance.md',
  'docs/build-plan.md',
  'spec-lock.json',
  '.github/workflows/ci.yml',
  '.github/pull_request_template.md',
  '.github/CODEOWNERS',
]) {
  try {
    await access(path.join(root, relative))
  } catch {
    failures.push(`missing required file: ${relative}`)
  }
}

const [major, minor] = process.versions.node.split('.').map(Number)
check(major > 24 || (major === 24 && minor >= 9), `Node >=24.9.0 is required, found ${process.versions.node}`)

const manifest = JSON.parse(await text('package.json'))
check(manifest.packageManager === 'pnpm@11.18.0', 'packageManager must be pnpm@11.18.0')
check(manifest.engines?.node === '>=24.9.0', 'package.json must declare Node >=24.9.0')
const verifySteps = ['verify:project', 'typecheck', 'lint', 'test', 'build']
const expectedVerify = verifySteps.map(step => `pnpm ${step}`).join(' && ')
check(manifest.scripts?.verify === expectedVerify, `pnpm verify must run ${verifySteps.join(', ')} in order`)
check(manifest.scripts?.['verify:project'] === 'node scripts/verify-project.mjs', 'verify:project must execute scripts/verify-project.mjs')
check(manifest.scripts?.typecheck === 'pnpm --recursive typecheck', 'typecheck must execute every workspace TypeScript check')
check(manifest.scripts?.lint === 'pnpm --recursive lint', 'lint must execute every workspace lint command')
check(manifest.scripts?.test === 'pnpm --recursive test', 'test must execute every workspace test command')
check(manifest.scripts?.build === 'tsc -b tsconfig.json', 'build must build the referenced TypeScript projects')

for (const packageDirectory of ['apps/singularity', 'packages/singularity/protocol']) {
  const packageManifest = JSON.parse(await text(`${packageDirectory}/package.json`))
  for (const step of ['typecheck', 'lint', 'test', 'build']) {
    check(typeof packageManifest.scripts?.[step] === 'string', `${packageDirectory} must define the ${step} script`)
  }
  const packageTsconfig = JSON.parse(await text(`${packageDirectory}/tsconfig.json`))
  check(packageTsconfig.compilerOptions?.strict === true, `${packageDirectory} typecheck must enable strict mode`)
  check(packageTsconfig.compilerOptions?.noEmit === true, `${packageDirectory} typecheck project must not emit`)
  check(packageTsconfig.include?.includes('src/**/*.ts') && packageTsconfig.include?.includes('test/**/*.ts'), `${packageDirectory} typecheck must include src and test`)
  const packageBuildTsconfig = JSON.parse(await text(`${packageDirectory}/tsconfig.build.json`))
  check(packageBuildTsconfig.compilerOptions?.composite === true, `${packageDirectory} build project must be composite`)
  check(packageBuildTsconfig.compilerOptions?.rootDir === 'src', `${packageDirectory} build rootDir must be src`)
  check(packageBuildTsconfig.compilerOptions?.outDir === 'dist', `${packageDirectory} build outDir must be dist`)
  check(packageBuildTsconfig.include?.length === 1 && packageBuildTsconfig.include[0] === 'src/**/*.ts', `${packageDirectory} build must include only src`)
}
const rootTsconfig = JSON.parse(await text('tsconfig.json'))
for (const buildPath of ['apps/singularity/tsconfig.build.json', 'packages/singularity/protocol/tsconfig.build.json']) {
  check(rootTsconfig.references?.some(reference => reference.path === buildPath), `root tsconfig must reference ${buildPath}`)
}

const lock = JSON.parse(await text('spec-lock.json'))
check(lock.version === '1.0', 'spec-lock version must be 1.0')
const specification = await text(lock.specification)
const digest = createHash('sha256').update(specification).digest('hex')
check(digest === lock.sha256, `specification digest mismatch: expected ${lock.sha256}, found ${digest}`)
check(specification.includes('版本：1.0'), 'framework must declare version 1.0')
check(specification.includes('状态：V1 发布规范'), 'framework must declare the V1 release status')

const scenarioCounts = new Map()
for (const match of specification.matchAll(/C-(\d{2})/g)) {
  const id = match[1]
  scenarioCounts.set(id, (scenarioCounts.get(id) ?? 0) + 1)
}
for (let index = 1; index <= 24; index += 1) {
  const id = String(index).padStart(2, '0')
  check(scenarioCounts.get(id) === 1, `conformance C-${id} must appear exactly once`)
}

const conformance = await text('docs/conformance.md')
const registryCounts = new Map()
for (const match of conformance.matchAll(/^\| C-(\d{2}) \|/gm)) {
  const id = match[1]
  registryCounts.set(id, (registryCounts.get(id) ?? 0) + 1)
}
for (let index = 1; index <= 24; index += 1) {
  const id = String(index).padStart(2, '0')
  check(registryCounts.get(id) === 1, `conformance registry C-${id} must appear exactly once`)
}
check(!/(?:["']?transport["']?\s*[:=]\s*["']sse["']|["']sse["']\s*[|,])/i.test(specification), 'framework retains unsupported SSE transport')

const agents = await text('AGENTS.md')
check(agents.includes('`docs/framework.md`'), 'AGENTS.md must point to docs/framework.md')
check(agents.includes('V1 发布规范'), 'AGENTS.md must recognize the V1 release')
check(!agents.includes('SINGULARITY_FRAMEWORK_V1_REVISED_DRAFT.md'), 'AGENTS.md retains a superseded draft reference')
check(!agents.includes('当前施工阻断项'), 'AGENTS.md retains a resolved blocker section')
check(agents.includes('pnpm verify'), 'AGENTS.md must document the root verification command')

const ci = await text('.github/workflows/ci.yml')
check(/^\s+verify:\s*$/m.test(ci), 'CI must retain the stable verify job')
check(/^\s+name: verify\s*$/m.test(ci), 'CI status context must be verify')
check(ci.includes('node-version: 24'), 'CI must use Node 24')
check(ci.includes('pnpm install --frozen-lockfile'), 'CI must install from the frozen lockfile')
check(ci.includes('pnpm verify'), 'CI must run pnpm verify')

const automerge = await text('.github/workflows/automerge.yml')
check(automerge.includes('workflow_run:'), 'autonomous merge must run after CI completion')
check(automerge.includes("github.event.workflow_run.conclusion == 'success'"), 'autonomous merge requires successful CI')
check(!automerge.includes('actions/checkout'), 'privileged autonomous merge must not checkout PR code')
check(automerge.includes('enablePullRequestAutoMerge'), 'autonomous merge must use the GitHub auto-merge mutation')
check(automerge.includes('github.rest.pulls.merge'), 'autonomous merge must merge an already-clean PR')
check(automerge.includes("ready.mergeable_state === 'clean'"), 'autonomous merge must distinguish clean and waiting states')
check(automerge.includes("event: 'APPROVE'"), 'autonomous merge must approve verified PRs')

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute))
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(absolute)
  }
  return files
}

for (const sourceRoot of ['packages', 'apps']) {
  const sourceDirectory = path.join(root, sourceRoot)
  let exists = true
  try {
    await access(sourceDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') exists = false
    else throw error
  }
  if (!exists) continue

  for (const file of await sourceFiles(sourceDirectory)) {
    const source = await readFile(file, 'utf8')
    const relative = path.relative(root, file)
    for (const forbidden of ['ProcessToolContext', 'entry.execute']) {
      check(!source.includes(forbidden), `${relative}: forbidden TS tool adapter symbol ${forbidden}`)
    }
    check(!/(?:["']?transport["']?\s*[:=]\s*["']sse["']|["']sse["']\s*[|,])/i.test(source), `${relative}: unsupported SSE transport`)
    if (relative.startsWith('packages/singularity/protocol/')) {
      check(!/@deepseek-ai\/dsh-/.test(source), `${relative}: protocol must not depend on DSH`)
      check(!/node:(?:fs|child_process|net|process|timers)/.test(source), `${relative}: protocol must not access host effects`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map(failure => `FAIL ${failure}`).join('\n'))
  process.exitCode = 1
} else {
  console.log('Project verification passed: V1 specification, repository configuration, CI, and architecture guards.')
}
