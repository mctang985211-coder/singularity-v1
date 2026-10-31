import { copyFile,mkdir,mkdtemp,readFile,rm,symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent,AgentOptions } from '@deepseek-ai/dsh-agent'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { INSTALL_ANCHOR,runProfile } from '@deepseek-ai/dsh/profile-boot'
import type { CompositionPayload,JsonValue,TaskContract } from '@singularity/protocol'
import { canonicalize,computeDigest } from '@singularity/protocol'
import type { CasObjectReader,CasObjectWriter } from '@singularity/runtime'
import {
METHOD_GUIDANCE_ORDER,
METHOD_GUIDANCE_SECTION,
MethodResourceError,
PLATFORM_PROMPT_SERVICE,
assertCompositionResources,
loadMethodResources,
mcpCompositionEntry,
mcpPromptSections,
renderWorkerCard,
usesExploration,
} from '@singularity/runtime'

const REQUIRED_DSH_VERSION = '0.2.2-alpha.2'
const PROFILE_NAME = 'singularity'
const DEFAULT_BASE_URL = 'http://127.0.0.1:16660/v1'
const BASE_URL_ENV = 'SINGULARITY_SPIKE_BASE_URL'
const API_KEY_ENV = 'SINGULARITY_SPIKE_API_KEY'

export interface SpikeProfileOptions {
  /** Additional native DSH profile patches, in application order. */
  readonly patchFiles?: readonly string[]
  /** Harness home for this run; defaults to `DSH_HOME`, then a disposable temporary directory. */
  readonly home?: string
  /** OpenAI-compatible chat endpoint; `SINGULARITY_SPIKE_BASE_URL` overrides the local default. */
  readonly baseURL?: string
  /** Launch credential; defaults to `SINGULARITY_SPIKE_API_KEY` and never enters process env. */
  readonly apiKey?: string
}

export interface SpikeProfile {
  readonly ctx: Context
  readonly dshVersion: string
  dispose(): Promise<void>
}

export interface SingleRunCompositionInput {
  readonly store: CasObjectReader & CasObjectWriter
  readonly id: string
  readonly contract: TaskContract
  readonly base: Omit<
    CompositionPayload,
    'contract' | 'dsh' | 'guidance' | 'modelRoute' | 'platformPrompt' | 'resources' | 'skills' | 'template' | 'mcpServers'
  >
  readonly agentOptions: AgentOptions
}

function jsonBytes(value: unknown): Uint8Array {
  // Launch configuration is public; credentials stay in native launchEnvironment.
  // JSON owns serialization, with Cordis signal values read through their native get().
  const text = JSON.stringify(value, (_key: string, item: unknown) => {
    if (item !== null && typeof item === 'object' && 'get' in item && typeof item.get === 'function') {
      return (item as { get(): unknown }).get()
    }
    return item
  })
  return new TextEncoder().encode(canonicalize(JSON.parse(text)))
}

/** Build the narrow Composition consumed by the Run driver from the booted DSH view. */
export async function buildSingleRunComposition(
  ctx: Context,
  input: SingleRunCompositionInput,
): Promise<CompositionPayload> {
  const provider = input.agentOptions.provider
  const model = input.agentOptions.model
  if (provider === undefined || model === undefined) throw new Error('composition requires provider and model')
  const methodResources = await loadMethodResources(input.store, input.contract)
  for (const server of methodResources.mcpServers) {
    const schema = await input.store.putObject(server.schema.id, jsonBytes(server.schemaPayload), 'object')
    if (schema.digest !== server.schema.digest) {
      throw new MethodResourceError('method', 'CONTRACT_INVALID', `derived MCP schema for ${JSON.stringify(server.serverName)} changed while storing`)
    }
  }
  const template = await input.store.putObject(
    `${input.id}:template`,
    jsonBytes(methodResources.template as unknown as JsonValue),
    'object',
  )
  const composition = {
    ...input.base,
    contract: { id: input.contract.taskId, digest: input.contract.digest },
    template,
    guidance: methodResources.guidance,
    skills: methodResources.skills.map(skill => skill.bundle),
    mcpServers: methodResources.mcpServers.map(mcpCompositionEntry),
  }
  await assertCompositionResources(input.store, methodResources, composition)
  const resolved = await ctx.llm.resolveModelInfo(provider, model)
  const call = await ctx.llm.resolveCallConfig({ provider, model, ...input.agentOptions })
  const config = [...ctx.loader.entries()]
    .filter(entry => !entry.disabled && entry.options.name !== 'cordis:include')
    .map(entry => ({
      id: entry.id,
      name: entry.options.name,
      config: entry.fiber?.effectiveConfig,
    }))
  const mcpOrder = ctx.systemPrompt.getSectionOrder('MCP_SERVERS')
  const mcpSections = mcpPromptSections(methodResources.mcpServers, mcpOrder)
  const resourceText = mcpSections.find(section => section.name === 'mcp-resource-servers')?.text ?? ''
  const disposers: (() => void)[] = []
  let assembly
  try {
    disposers.push(ctx.systemPrompt.section({
      name: METHOD_GUIDANCE_SECTION,
      order: METHOD_GUIDANCE_ORDER,
      text: methodResources.guidanceText,
      interpolate: false,
    }))
    for (const section of mcpSections) {
      if (!section.name.startsWith('mcp:')) continue
      disposers.push(ctx.systemPrompt.section(section))
    }
    assembly = await ctx.systemPrompt.assemble()
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
  if (methodResources.mcpServers.length > 0
    && !assembly.sections.some(section => section.name === 'mcp-resource-servers')) {
    throw new MethodResourceError(
      'method',
      'UNSUPPORTED_RESOURCES',
      'profile does not mount the DSH MCP resource section required by Method server bindings',
    )
  }
  const prompt = renderPrompt({
    ...assembly,
    sections: assembly.sections.map(section => section.name === 'mcp-resource-servers'
      ? { ...section, text: resourceText }
      : section.name === 'singularity:worker-card'
        ? { ...section, text: renderWorkerCard(usesExploration(methodResources)) } : section),
  })
  const dshConfig = await input.store.putObject(
    `${input.id}:dsh-config`,
    jsonBytes({ v: 1, dshVersion: REQUIRED_DSH_VERSION, profile: PROFILE_NAME, entries: config }),
  )
  const modelRoute = await input.store.putObject(
    `${input.id}:model-route`,
    jsonBytes({ v: 1, call, resolved }),
  )
  const resources = await input.store.putObject(
    `${input.id}:resources`,
    jsonBytes({ v: 1, tools: ctx.tools.schemas() }),
  )
  return {
    ...composition,
    dsh: { package: '@deepseek-ai/dsh', version: REQUIRED_DSH_VERSION, config: dshConfig },
    platformPrompt: computeDigest('object', { v: 1, text: prompt }),
    modelRoute,
    resources,
  }
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`S1 spike requires ${name}`)
  }
  return value
}

async function assertDshVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(INSTALL_ANCHOR, 'utf8')) as { readonly version?: unknown }
  if (manifest.version !== REQUIRED_DSH_VERSION) {
    const resolved = typeof manifest.version === 'string' ? manifest.version : 'unknown'
    throw new Error(`S1 requires DSH ${REQUIRED_DSH_VERSION}, resolved ${resolved}`)
  }
  return REQUIRED_DSH_VERSION
}

async function releaseHome(home: string, previousHome: string | undefined, ownedHome: string | undefined, ownedProfile: string | undefined): Promise<void> {
  if (process.env.DSH_HOME === home) {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  if (ownedProfile !== undefined) await rm(ownedProfile, { recursive: true, force: true })
  if (ownedHome !== undefined) await rm(ownedHome, { recursive: true, force: true })
}

export async function bootSpikeProfile(options: SpikeProfileOptions = {}): Promise<SpikeProfile> {
  const dshVersion = await assertDshVersion()
  const baseURL = options.baseURL ?? process.env[BASE_URL_ENV] ?? DEFAULT_BASE_URL
  const apiKey = required(API_KEY_ENV, options.apiKey ?? process.env[API_KEY_ENV])

  const configuredHome = options.home ?? process.env.DSH_HOME
  let home: string
  let ownedHome: string | undefined
  if (configuredHome === undefined) {
    ownedHome = await mkdtemp(join(tmpdir(), 'singularity-spike-'))
    home = ownedHome
  } else {
    home = resolve(configuredHome)
    await mkdir(home, { recursive: true })
  }

  // DSH resolves its home from process.env during profile resolution. Keep the
  // value for the host lifetime so late dshHomePath callers see the same root.
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let ownedProfile: string | undefined

  try {
    const profileDirectory = fileURLToPath(new URL('..', import.meta.url))
    // runProfile writes cordis.yml. Give each boot its own directory rather than
    // letting independent runners truncate and read one file in the source tree.
    ownedProfile = await mkdtemp(join(home, 'profile-'))
    await Promise.all([
      copyFile(join(profileDirectory, 'package.json'), join(ownedProfile, 'package.json')),
      copyFile(join(profileDirectory, 'cordis.patch.yml'), join(ownedProfile, 'cordis.patch.yml')),
      symlink(join(profileDirectory, 'node_modules'), join(ownedProfile, 'node_modules'), 'dir'),
    ])
    const profile = loadProfileDirectory(PROFILE_NAME, ownedProfile, INSTALL_ANCHOR)
    if (profile.skippedBundles.length > 0) {
      const skipped = profile.skippedBundles
        .map(bundle => `${bundle.packageName}: ${bundle.reason}`)
        .join('; ')
      throw new Error(`Skipped DSH bundles: ${skipped}`)
    }

    const environment = createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: {
        DSH_HOME: home,
        [BASE_URL_ENV]: baseURL,
        [API_KEY_ENV]: apiKey,
      },
    }])
    const booted = await runProfile({
      environment,
      profile: PROFILE_NAME,
      resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
      patchFiles: [...options.patchFiles ?? []],
      args: [],
    })
    // The runtime adds this same named section in each Agent scope. Keeping a
    // fixed profile contribution makes an unscoped composition assembly use
    // alpha2's own ordering; the scoped registration shadows it by name.
    const disposeWorkerCard = booted.ctx.systemPrompt.section({
      name: 'singularity:worker-card',
      order: 100,
      text: renderWorkerCard(false),
      interpolate: false,
    })
    // Runtime verifies this exact scoped assembly digest before Agent
    // publication. The renderer stays app-owned so runtime adds no DSH prompt
    // dependency and no second renderer.
    const disposePlatformPrompt = booted.ctx.provide(PLATFORM_PROMPT_SERVICE, {
      async render(agentCtx: Context, agent: Agent): Promise<string> {
        const assembly = await agentCtx.systemPrompt.assemble({ scope: agent })
        return renderPrompt(assembly)
      },
    })

    let disposal: Promise<void> | undefined
    return {
      ctx: booted.ctx,
      dshVersion,
      dispose() {
        disposal ??= (async () => {
          try {
            await booted.shutdown.shutdown(0)
          } finally {
            disposePlatformPrompt()
            disposeWorkerCard()
            await releaseHome(home, previousHome, ownedHome, ownedProfile)
          }
        })()
        return disposal
      },
    }
  } catch (error) {
    try {
      await releaseHome(home, previousHome, ownedHome, ownedProfile)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'S1 spike startup and cleanup failed')
    }
    throw error
  }
}
