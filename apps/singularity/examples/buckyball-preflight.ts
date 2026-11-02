import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname,isAbsolute,join,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { computeDigest,computeDigestBytes } from '@singularity/protocol'
import { DomainStore,WORKER_PERSONA,REVIEWER_PERSONA,PROPOSER_PERSONA,SUMMARY_PERSONA } from '@singularity/runtime'

import { bootSpikeProfile } from '../src/host-composition.ts'
import { BUCKYBALL_RECIPE,BUCKYBALL_RECIPE_REF } from './buckyball-checks.ts'
import { BUCKYBALL_FRONTEND_CAMPAIGN } from './buckyball-frontend-task.ts'
import { nativeMappingSmoke } from '../test/fixtures/buckyball-native-mapping.ts'
import { freezeBuckyballSkills,readBuckyballSkills } from './buckyball-skills.ts'

const exec = promisify(execFile)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const sha256 = async (path: string) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path) as AsyncIterable<Buffer>) hash.update(bytes)
  return hash.digest('hex')
}
interface Check { name: string; pass: boolean; command?: readonly string[]; data?: unknown; error?: string }

/** Operator readiness only: no install, environment repair, paid request, or skipped mandatory check. */
export async function runBuckyballPreflight(prepared: string, report: string) {
  if (!isAbsolute(prepared) || !isAbsolute(report)) throw new Error('--prepared and --report must be absolute paths')
  const checks: Check[] = []
  const run = async (name: string, action: () => Promise<unknown>, command?: readonly string[]) => {
    try { checks.push({ name, pass: true, ...(command === undefined ? {} : { command }), data: await action() }) }
    catch (error) { checks.push({ name, pass: false, ...(command === undefined ? {} : { command }), error: error instanceof Error ? error.message : String(error) }) }
  }
  const project = JSON.parse(await readFile(join(prepared, 'project.json'), 'utf8')) as {
    source: { destination: string; head: string; submodules: { path: string; head: string }[] }
    cosyvoice: { path: string; revision: string }; checkpoint: { path: string; sha256: string }
    eda: { library: string; librarySha256: string }; referencePython: string
  }
  const evidence = join(dirname(report), `preflight-${String(Date.now())}`)
  await mkdir(evidence, { recursive: true })
  await run('fixed-runtime-versions', async () => {
    const pnpm = (await exec('pnpm', ['--version'])).stdout.trim()
    const dsh = JSON.parse(await readFile(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url), 'utf8')) as { version: string }
    if (process.version !== 'v24.9.0' || pnpm !== '11.18.0' || dsh.version !== '0.2.2-alpha.2') throw new Error(`Runtime mismatch: ${process.version}, pnpm ${pnpm}, DSH ${dsh.version}`)
    return { node: process.version, pnpm, dsh: dsh.version, budget: BUCKYBALL_FRONTEND_CAMPAIGN }
  })
  await run('pinned-source-checkpoint-library', async () => {
    const revision = (cwd: string) => exec('git', ['rev-parse', 'HEAD'], { cwd }).then(result => result.stdout.trim())
    if (await revision(project.source.destination) !== project.source.head || await revision(project.cosyvoice.path) !== project.cosyvoice.revision) throw new Error('Source revision mismatch')
    for (const module of project.source.submodules) if (await revision(join(project.source.destination, module.path)) !== module.head) throw new Error(`Submodule revision mismatch: ${module.path}`)
    const digests = []
    for (const line of project.checkpoint.sha256.trim().split('\n')) {
      const [expected, path] = line.trim().split(/\s+/)
      const actual = await sha256(join(dirname(project.checkpoint.path), path))
      if (actual !== expected) throw new Error(`Checkpoint digest mismatch: ${path}`)
      digests.push({ path, digest: actual })
    }
    if (await sha256(project.eda.library) !== project.eda.librarySha256) throw new Error('Synthesis library digest mismatch')
    await exec(project.referencePython, ['-c', 'import torch; assert torch.__version__ == "2.3.1+cpu"'])
    return { checkpoints: digests, library: project.eda.librarySha256, recipe: BUCKYBALL_RECIPE_REF, dependencies: BUCKYBALL_RECIPE.dependencies }
  })
  await run('frozen-domain-skills', async () => {
    const store = await DomainStore.open({ root: join(evidence, 'skill-assets') })
    try {
      const assets = await freezeBuckyballSkills(store, project.source.destination)
      const resources = await readBuckyballSkills(store, assets)
      return { skills: resources.map(skill => {
        const adaptation = skill.bundleFiles.find(file => file.path === 'ADAPTATION.json')
        if (adaptation === undefined) throw new Error(`Frozen skill ${skill.id} lacks its source provenance`)
        const provenance = JSON.parse(new TextDecoder().decode(adaptation.data)) as {
          source: string; sourceFiles: { path: string; digest: string }[]; entrypoint: { path: string; digest: string }
        }
        return { id: skill.id, name: skill.name, bundle: skill.bundle, source: provenance.source,
          sourceFiles: provenance.sourceFiles, entrypoint: provenance.entrypoint,
          files: skill.bundleFiles.map(file => ({ path: file.path, bytes: file.data.byteLength, digest: computeDigestBytes('object', file.data) })) }
      }) }
    } finally { await store.close() }
  })
  await run('domain-mcp-business-parameters-cancellation', async () => {
    const spike = await bootSpikeProfile({ home: join(evidence, 'dsh'), apiKey: 'no-model-request' })
    spike.ctx.on('llm/stream', () => { throw new Error('Preflight must not purchase a model request') }, { prepend: true })
    const handle = await spike.ctx.agents.create({ sessionId: SessionId(`buckyball-preflight-${String(Date.now())}`), meta: { cwd: evidence },
      setup: async scope => {
        scope.tools.restrict({ allow: [] })
        await scope.plugin(mcpClient, { transport: 'stdio', serverName: 'buckyball', command: process.execPath,
          args: [fileURLToPath(new URL('./buckyball-mcp.ts', import.meta.url))], env: { BUCKYBALL_BASELINE: project.source.destination },
          toolCallTimeoutMs: 20 * 60 * 1000, failOnStartupError: true, reconnect: { enabled: false } })
      } })
    const records: unknown[] = []
    let sequence = 0
    const call = async (name: string, args: unknown, error: boolean, signal = AbortSignal.timeout(20 * 60 * 1000)) => {
      const result = await spike.ctx.tools.execute({ agent: handle.agent, signal, calls: [{ type: 'tool-call', id: ToolCallId(`preflight-${String(++sequence)}`), name: `mcp__buckyball__${name}`, arguments: JSON.stringify(args) }] })
      records.push({ name, args, result })
      if (result.results[0].result.isError !== error) throw new Error(`Unexpected result for ${name}: ${JSON.stringify(result)}`)
      return result
    }
    try {
      const projectPath = join(evidence, 'checkout')
      await call('checkout', { project: projectPath }, false)
      await call('checkout', { project: 7 }, true)
      await call('bbdev', { project: projectPath, args: ['config', '--install'] }, false)
      await call('bbdev', { project: projectPath, args: 'bad-schema' }, true)
      const uvm = await call('bbdev', { project: projectPath, args: ['uvm', '--run', '--chip toy --ip axis --target arbiter'] }, false)
      const text = JSON.stringify(uvm)
      if (!/UVM_ERROR.*0/.test(text) || !/UVM_FATAL.*0/.test(text)) throw new Error('UVM terminal comparison summary absent or failed')
      await call('bbdev', { project: projectPath, args: ['compiler', '--build', '--chip toy'] }, false)
      const server = createServer()
      await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('No local smoke port')
      await new Promise<void>((resolveClosed, reject) => server.close(error => { if (error === undefined) resolveClosed(); else reject(error) }))
      await call('bbdev', { project: projectPath, args: ['start', '--server', '--port', String(address.port)] }, true, AbortSignal.timeout(25_000))
      await call('checkout', { project: join(evidence, 'cancelled-checkout') }, true, AbortSignal.timeout(1))
      return { records, modelRequests: 0, boundary: 'Native MCP business smoke; compiler toy and focused axis UVM, not CosyVoice frontend signoff.' }
    } finally { await handle.dispose(); await spike.dispose(); await writeFile(join(evidence, 'mcp.json'), JSON.stringify(records, null, 2)) }
  })
  await run('native-mapping-parsers-and-unused-ball', () => nativeMappingSmoke(join(prepared, 'project.json'), join(evidence, 'native-mapping')))
  for (const [name, files] of [
    ['finite-checker-positive-negative', ['test/buckyball-checks.test.ts']],
    ['role-tool-schema-and-acceptance-fixtures', ['test/host-composition.test.ts', 'test/contract-summary.test.ts', 'test/rsi-proposer.test.ts', 'test/buckyball-campaign.test.ts', 'test/buckyball-skills.test.ts']],
    ['minimal-numerical-public-and-frozen-verification', ['test/conv1d-checks.test.ts']],
  ] as const) {
    const command = [process.execPath, '--test', ...files]
    await run(name, async () => {
      const result = await exec(command[0], command.slice(1), { cwd: join(repository, 'apps/singularity'),
        env: { ...process.env, SINGULARITY_SPIKE_LIVE: '0' }, maxBuffer: 16 * 1024 * 1024 })
      const log = join(evidence, `${name}.log`)
      await writeFile(log, `${result.stdout}${result.stderr}`)
      const data = { log, exitCode: 0, outputDigest: createHash('sha256').update(result.stdout).update(result.stderr).digest('hex') }
      if (name !== 'role-tool-schema-and-acceptance-fixtures') return data
      const marker = 'SINGULARITY_ROLE_SURFACE '
      const surfaces = result.stdout.split('\n').filter(line => line.includes(marker))
        .map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as {
          role: string; personaDigest: string; promptDigest: string; toolSchemaDigest: string; tools: string[]
        })
      for (const [role, persona] of Object.entries({ worker: WORKER_PERSONA, reviewer: REVIEWER_PERSONA, proposer: PROPOSER_PERSONA, summary: SUMMARY_PERSONA })) {
        if (!surfaces.some(surface => surface.role === role && surface.personaDigest === computeDigest('object', { v: 1, text: persona }))) {
          throw new Error(`The native fixture did not record the frozen ${role} prompt/tool schema identity`)
        }
      }
      return { ...data, surfaces }
    }, command)
  }
  const pass = checks.every(check => check.pass)
  await mkdir(dirname(report), { recursive: true })
  await writeFile(report, JSON.stringify({ v: 1, checkedAt: new Date().toISOString(), prepared, evidence, pass, checks,
    evidenceLevel: 'Operator readiness and no-paid native fixtures; not real-model autonomous behavior or complete chip acceptance.' }, null, 2))
  return pass
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const args = process.argv.slice(2), option = (key: string) => args[args.indexOf(key) + 1]
  process.exitCode = await runBuckyballPreflight(option('--prepared'), option('--report')) ? 0 : 1
}
