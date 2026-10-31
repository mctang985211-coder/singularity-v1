import { writeFile } from 'node:fs/promises'

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

import { createWakeMessage, deliverWakeOnceOrFail } from '@singularity/runtime'

import { bootSpikeProfile } from '../../src/host-composition.ts'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const agentOptions = {
  provider: 'singularity-local',
  model: 'deepseek-flash',
  reasoningEffort: ReasoningEffortId('max'),
} satisfies AgentOptions

const home = required('S1_D_HOME')
const workspace = required('S1_D_WORKSPACE')
const readyFile = required('S1_D_READY_FILE')
const pendingSessionId = SessionId(required('S1_D_PENDING_SESSION_ID'))
const crashSessionId = SessionId(required('S1_D_CRASH_SESSION_ID'))
const pendingWake = {
  wakeId: required('S1_D_PENDING_WAKE_ID'),
  text: required('S1_D_PENDING_WAKE_TEXT'),
} as const
const crashWake = {
  wakeId: required('S1_D_CRASH_WAKE_ID'),
  text: required('S1_D_CRASH_WAKE_TEXT'),
} as const

const spike = await bootSpikeProfile({
  home,
  baseURL: required('S1_D_BASE_URL'),
  apiKey: required('S1_D_API_KEY'),
})
const ctx = spike.ctx

const pending = await ctx.agents.create({
  sessionId: pendingSessionId,
  meta: { cwd: workspace },
  agentOptions,
})
pending.agent.inject(createWakeMessage(pendingWake))
await ctx.sessions.flush(pending.agent.session)
await writeFile(readyFile, 'pending wake persisted\n')

const crash = await ctx.agents.create({
  sessionId: crashSessionId,
  meta: { cwd: workspace },
  agentOptions,
})
await deliverWakeOnceOrFail(crash.agent, crashWake)
// The fixture never responds, so this process stays alive until the parent kills it.
await crash.agent.whenIdle()
