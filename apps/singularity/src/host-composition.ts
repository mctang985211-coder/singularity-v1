import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR, runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

const REQUIRED_DSH_VERSION = '0.2.2-alpha.2'
const PROFILE_NAME = 'singularity'
const BASE_URL_ENV = 'SINGULARITY_SPIKE_BASE_URL'
const API_KEY_ENV = 'SINGULARITY_SPIKE_API_KEY'

export interface SpikeProfileOptions {
  /** Harness home for this run; defaults to `DSH_HOME`, then a disposable temporary directory. */
  readonly home?: string
  /** OpenAI-compatible endpoint; defaults to `SINGULARITY_SPIKE_BASE_URL`. */
  readonly baseURL?: string
  /** Launch credential; defaults to `SINGULARITY_SPIKE_API_KEY` and never enters process env. */
  readonly apiKey?: string
}

export interface SpikeProfile {
  readonly ctx: Context
  readonly dshVersion: string
  dispose(): Promise<void>
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
  const baseURL = required(BASE_URL_ENV, options.baseURL ?? process.env[BASE_URL_ENV])
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

    let disposal: Promise<void> | undefined
    return {
      ctx: booted.ctx,
      dshVersion,
      dispose() {
        disposal ??= (async () => {
          try {
            await booted.shutdown.shutdown(0)
          } finally {
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
