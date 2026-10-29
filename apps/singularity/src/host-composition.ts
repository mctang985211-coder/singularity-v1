import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { INSTALL_ANCHOR, runProfile } from '@deepseek-ai/dsh/profile-boot'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

export interface SpikeProfileOptions {
  readonly home: string
  readonly baseURL: string
  readonly apiKey: string
}

export interface SpikeProfile {
  readonly ctx: Context
  readonly dshVersion: string
  dispose(): Promise<void>
}

export async function bootSpikeProfile(options: SpikeProfileOptions): Promise<SpikeProfile> {
  const manifest = JSON.parse(await readFile(INSTALL_ANCHOR, 'utf8')) as { version?: string }
  if (manifest.version !== '0.2.2-alpha.2') {
    throw new Error(`S1 requires DSH 0.2.2-alpha.2, resolved ${manifest.version ?? 'unknown'}`)
  }

  const previousHome = process.env.DSH_HOME
  const previousBaseURL = process.env.SINGULARITY_SPIKE_BASE_URL
  process.env.DSH_HOME = options.home
  process.env.SINGULARITY_SPIKE_BASE_URL = options.baseURL

  let shutdown: { shutdown(code: number): Promise<void> } | undefined
  try {
    const profileDirectory = fileURLToPath(new URL('..', import.meta.url))
    const profile = loadProfileDirectory('singularity', profileDirectory, INSTALL_ANCHOR)
    if (profile.skippedBundles.length > 0) {
      throw new Error(`Skipped DSH bundles: ${JSON.stringify(profile.skippedBundles)}`)
    }
    const environment = createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: {
        DSH_HOME: options.home,
        SINGULARITY_SPIKE_BASE_URL: options.baseURL,
        SINGULARITY_SPIKE_API_KEY: options.apiKey,
      },
    }])
    const booted = await runProfile({
      environment,
      profile: 'singularity',
      resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
      patchFiles: [],
      args: [],
    })
    shutdown = booted.shutdown
    return {
      ctx: booted.ctx,
      dshVersion: manifest.version,
      async dispose() {
        await booted.shutdown.shutdown(0)
      },
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousBaseURL === undefined) delete process.env.SINGULARITY_SPIKE_BASE_URL
    else process.env.SINGULARITY_SPIKE_BASE_URL = previousBaseURL
  }
}
