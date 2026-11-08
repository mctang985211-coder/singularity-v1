import { copyFile,mkdir,stat,writeFile } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { AgentHandle,AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createWakeMessage,snapshotSession } from '@singularity/runtime'

import { nativeAccounting } from './accounting.ts'
import { loadDomainPackage } from './domain.ts'
import { bootSpikeProfile } from './host-composition.ts'

const ENV_BUILDER_CARD = `Prepare an independent domain directory from the operator's materials.
Write domain.json, task.json and frozen case inputs in the current directory.
The root goal states the external problem and deliverable. Criteria check real
consumer outcomes. Freeze actual input bytes or exact reconstruction rules for
source, public transfer and validation cases; paired arms must receive the same
inputs and acceptance. Keep constraints to external invariants and deployment.
Use executable checks for deterministic root outcomes. Use acceptance="review"
only for root semantics that need independent judgment. Checks may consume only
declared frozen inputs and submitted outputs; test both success and failure.
Optional tools are standard MCP source/manifest/config declarations in tools.json.
Prepare all dependencies and test each exposed tool's business success, invalid
arguments and cancellation before declaring it ready. Describe direct tool calls,
not workflow or approval procedures. Do not install tools without a consumer.
Do not author Methods, child contracts, Task/RSI control flow, budgets, retries,
model routes or activation. Do not modify Singularity source or shared registries.
The resulting directory is loaded and frozen by a later run, not hot-reloaded
into a live Task. Work only inside the supplied materials directory and the
current output directory; do not search other workspaces or historical artifacts.
Use one or two focused bash calls, stop after the generic loader succeeds, and
do not write ad-hoc test harnesses or repeat checks already represented by the
declared acceptance scripts. Leave the directory inspectable and report
unresolved gaps.`
const ENV_BUILDER_EXAMPLE = `Minimal domain.json: {"v":1,"id":"example","task":"task.json","acceptance":"checks","source":{"input":"cases/source.txt"},"cases":[{"id":"transfer","description":"A distinct frozen input.","inputs":{"input":"cases/transfer.txt"}},{"id":"validation","description":"Independent validation input.","inputs":{"input":"cases/validation.txt"},"validation":true}]}.
task.json contains goal, criteria, inputs and outputs. An input has id, path,
access and an optional default source path; it has no object Ref. Each required
criterion using checks has a check command. The manifest's optional tools field
points to a JSON array of ToolAsset data whose server replaces bundle/sourceFiles
with a source directory and manifest/config with their public JSON file paths.`

export async function buildDomainEnvironment(materials: string, outputRoot: string, options: {
  readonly deadlineAt?: number
  readonly maxRequests?: number
  readonly maxReportedTokens?: number
  readonly agentOptions?: AgentOptions
} = {}) {
  const startedAt = Date.now(), deadlineAt = options.deadlineAt ?? startedAt + 60 * 60_000
  const materialsRoot = resolve(materials)
  if (!(await stat(materialsRoot)).isDirectory()) throw new Error(`Environment materials must be a directory: ${materialsRoot}`)
  const destination = resolve(outputRoot)
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination)
  const domain = join(destination, 'domain')
  await mkdir(domain)
  const patch = join(destination, 'builder.patch.yml')
  await copyFile(new URL('./experiment.patch.yml', import.meta.url), patch)
  const spike = await bootSpikeProfile({ home: join(destination, 'dsh'), patchFiles: [patch] })
  const cancellation = new AbortController()
  const accounting = nativeAccounting(spike.ctx, { deadlineAt, cancellation,
    maxRequests: options.maxRequests ?? 200, maxReportedTokens: options.maxReportedTokens ?? 10_000_000,
    log: join(destination, 'requests.jsonl') })
  const timer = setTimeout(() => { cancellation.abort('env-builder-deadline') }, Math.max(0, deadlineAt - Date.now()))
  const agentOptions: AgentOptions = options.agentOptions ?? { provider: 'singularity-local', model: 'deepseek-v4.1-flash', reasoningEffort: ReasoningEffortId('max'), maxTokens: 40000 }
  const failures: unknown[] = []
  let handle: AgentHandle | undefined
  try {
    handle = await spike.ctx.agents.create({ sessionId: SessionId('domain-env-builder'), meta: { cwd: domain }, agentOptions, signal: cancellation.signal,
      setup: ctx => {
        ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: 'You are an environment builder. Produce files and reproducible environment evidence, not a Singularity execution workflow.', interpolate: false })
        ctx.systemPrompt.section({ name: 'singularity:env-builder', order: 100, text: `${ENV_BUILDER_CARD}\n${ENV_BUILDER_EXAMPLE}`, interpolate: false })
        ctx.systemPrompt.section({ name: 'singularity:worker-card', order: 100, text: '', interpolate: false })
        ctx.systemPrompt.section({ name: 'tool:jobs', order: 100, text: '', interpolate: false })
        ctx.tools.restrict({ allow: ['bash'] })
      } })
    handle.agent.followup(createWakeMessage({ wakeId: 'domain-env-builder:materials',
      text: `Operator-supplied material directory: ${materialsRoot}\nPrepare the independent domain directory at the current working directory. Inspect the materials and validate the result without starting a Task or RSI Round.` }))
    await handle.agent.whenIdle()
    cancellation.signal.throwIfAborted()
    const snapshot = snapshotSession(handle.agent.session)
    if (snapshot.failure !== undefined) throw new Error(snapshot.failure)
  } catch (error) { failures.push(error) } finally {
    clearTimeout(timer)
    if (handle !== undefined) try { await handle.dispose() } catch (error) { failures.push(error) }
    accounting.dispose()
    try { await spike.dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Domain environment preparation failed')
  const prepared = await loadDomainPackage(domain)
  await writeFile(join(destination, 'builder.json'), JSON.stringify({ v: 1, startedAt, finishedAt: Date.now(), deadlineAt,
    materials: materialsRoot, domain, domainId: prepared.id, usage: accounting.usage }, null, 2))
  return { domain, usage: accounting.usage }
}

const entry = process.argv.at(1)
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  console.log(JSON.stringify(await buildDomainEnvironment(resolve(process.argv[2]), resolve(process.argv[3]))))
}
