import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR, runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { CompositionPayload, JsonValue, TaskContract } from '@singularity/protocol'
import { canonicalize, computeDigest } from '@singularity/protocol'
import {
  METHOD_GUIDANCE_ORDER,
  METHOD_GUIDANCE_SECTION,
  PLATFORM_PROMPT_SERVICE,
  assertCompositionResources,
  loadMethodResources,
  renderWorkerCard,
} from '@singularity/runtime'
import type { CasObjectReader, CasObjectWriter } from '@singularity/runtime'

const REQUIRED_DSH_VERSION = '0.2.2-alpha.2'
const PROFILE_NAME = 'singularity'
const DEFAULT_BASE_URL = 'http://127.0.0.1:16660/v1'
const BASE_URL_ENV = 'SINGULARITY_SPIKE_BASE_URL'
const API_KEY_ENV = 'SINGULARITY_SPIKE_API_KEY'

export interface SpikeProfileOptions {
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
    'contract' | 'dsh' | 'guidance' | 'modelRoute' | 'platformPrompt' | 'resources' | 'skills' | 'template'
  >
  readonly agentOptions: AgentOptions
}

function jsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value))
}

function publicConfig(value: unknown, path = 'config'): JsonValue {
  if (value === undefined) return {}
  if (typeof value === 'object' && value !== null && 'get' in value
    && typeof (value as { readonly get?: unknown }).get === 'function') {
    return publicConfig((value as { get(): unknown }).get(), path)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`unsafe DSH ${path}`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => publicConfig(item, `${path}[${String(index)}]`))
  if (typeof value !== 'object') throw new Error(`unsafe DSH ${path}`)
  const output: Record<string, JsonValue> = {}
  for (const key of Object.keys(value)) {
    if (/^(?:apiKey|headers|secret|token|password|credential|authorization)$/i.test(key)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.value === undefined && descriptor?.get === undefined) continue
      const field: unknown = descriptor.value
      if (key === 'headers' && field !== null && typeof field === 'object' && Object.keys(field).length === 0) continue
      throw new Error(`DSH ${path}.${key} is not public composition data`)
    }
    if (key === 'apiKeyEnv') continue
    const item: unknown = (value as Record<string, unknown>)[key]
    if (item !== undefined) output[key] = publicConfig(item, `${path}.${key}`)
  }
  return output
}

/** Build the narrow Composition consumed by run-recovery from the booted DSH view. */
export async function buildSingleRunComposition(
  ctx: Context,
  input: SingleRunCompositionInput,
): Promise<CompositionPayload> {
  const provider = input.agentOptions.provider
  const model = input.agentOptions.model
  if (provider === undefined || model === undefined) throw new Error('composition requires provider and model')
  const methodResources = await loadMethodResources(input.store, input.contract)
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
  }
  await assertCompositionResources(input.store, methodResources, composition)
  const resolved = await ctx.llm.resolveModelInfo(provider, model)
  const call = await ctx.llm.resolveCallConfig({ provider, model, ...input.agentOptions })
  const config = [...ctx.loader.entries()]
    .filter(entry => !entry.disabled && entry.options.name !== 'cordis:include')
    .map(entry => ({
      id: entry.id,
      name: entry.options.name,
      config: publicConfig(entry.fiber?.effectiveConfig, `loader.${entry.id}`),
    }))
  const disposeGuidance = ctx.systemPrompt.section({
    name: METHOD_GUIDANCE_SECTION,
    order: METHOD_GUIDANCE_ORDER,
    text: methodResources.guidanceText,
    interpolate: false,
  })
  const assembly = await ctx.systemPrompt.assemble().finally(disposeGuidance)
  const prompt = renderPrompt(assembly)
  const dshConfig = await input.store.putObject(
    `${input.id}:dsh-config`,
    jsonBytes({ v: 1, dshVersion: REQUIRED_DSH_VERSION, profile: PROFILE_NAME, entries: config }),
  )
  const modelRoute = await input.store.putObject(
    `${input.id}:model-route`,
    jsonBytes(publicConfig({ v: 1, call, resolved })),
  )
  const resources = await input.store.putObject(
    `${input.id}:resources`,
    jsonBytes(publicConfig({ v: 1, tools: ctx.tools.schemas() })),
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

async function releaseHome(home: string, previousHome: string | undefined, ownedHome: string | undefined): Promise<void> {
  if (process.env.DSH_HOME === home) {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
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

  try {
    const profileDirectory = fileURLToPath(new URL('..', import.meta.url))
    const profile = loadProfileDirectory(PROFILE_NAME, profileDirectory, INSTALL_ANCHOR)
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
      patchFiles: [],
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
            await releaseHome(home, previousHome, ownedHome)
          }
        })()
        return disposal
      },
    }
  } catch (error) {
    try {
      await releaseHome(home, previousHome, ownedHome)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'S1 spike startup and cleanup failed')
    }
    throw error
  }
}
