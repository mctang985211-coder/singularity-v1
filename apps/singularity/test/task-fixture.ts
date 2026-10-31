import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import assert from 'node:assert/strict'

import type { Context } from '@deepseek-ai/cordis'

import { admitRootTask, canonicalize, seal, sealMethodRevision } from '@singularity/protocol'
import type {
  CompositionPayload,
  FactActor,
  MethodRevision,
  Ref,
  RootAdmissionInput,
  SkillAsset,
  TaskContract,
  TaskExample,
  ToolAsset,
} from '@singularity/protocol'
import { DomainStore } from '@singularity/runtime'
import type { SingleRunAdmission } from '@singularity/runtime'
import { buildSingleRunComposition } from '../src/host-composition.ts'

import type {
  CapturedChatRequest,
  ChatCompletionReplyScript,
  FixtureReply,
} from './fixtures/chat-completions.ts'


const PROVIDER_ID = 'verifier:s3-c-fixture'

export const CRITERION_ID = 'declared-output'

export const OUTPUT_ID = 'result'

export const OUTPUT_PATH = 'result.txt'

export const FROZEN_OUTPUT = 'frozen-output-before-verify'

export const LIVE = process.env.SINGULARITY_SPIKE_LIVE === '1'

export const LIVE_TIMEOUT_MS = 1_800_000

export const ACTOR: FactActor = { kind: 'runtime', id: 's3-c-test-host' }

export const RUN_FACT_TYPES = new Set<string>([
  'task/admitted',
  'run/opened',
  'task/children-admitted',
  'run/submitted',
  'run/closed',
  'task/closed',
])

const textEncoder = new TextEncoder()

export const textDecoder = new TextDecoder('utf-8', { fatal: true })

export type WireRequest = CapturedChatRequest

export type ScriptedReply = FixtureReply

export type ReplyScript = ChatCompletionReplyScript

export interface Scenario {
  readonly runAdmission: SingleRunAdmission
  readonly contract: TaskContract
  readonly method: MethodRevision
  readonly composition: CompositionPayload
  readonly provider: Ref
}

export interface SkillFixture {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
  readonly extraFiles?: readonly { readonly path: string; readonly content: string }[]
}

export interface McpServerFixture {
  readonly serverName: string
  readonly exposedTools: ToolAsset['server']['exposedTools']
  readonly instructions: string
  readonly capabilities: readonly string[]
  readonly source: string
  readonly entrypoint?: string
  readonly transport?: 'stdio' | 'streamable-http'
  readonly url?: string
  readonly toolCallTimeoutMs?: number
}

export function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value))
}

export async function seedObject(
  store: DomainStore,
  id: string,
  value: unknown,
  domain: 'object' | 'method' = 'object',
): Promise<Ref> {
  return store.putObject(id, jsonBytes(value), domain)
}

export async function seedRawTree(
  store: DomainStore,
  id: string,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<Ref> {
  const entries = []
  for (const file of files) {
    const bytes = textEncoder.encode(file.content)
    entries.push({
      path: file.path,
      bytes: bytes.byteLength,
      object: await store.putObject(`${id}:file:${file.path}`, bytes, 'object'),
    })
  }
  entries.sort((left, right) => compareBundlePath(left.path, right.path))
  const manifest = seal('object', { v: 1, kind: 'tree', files: entries })
  return store.putObject(id, jsonBytes(manifest), 'object')
}

function compareBundlePath(left: string, right: string): number {
  const leftSegments = left.split('/')
  const rightSegments = right.split('/')
  const length = Math.min(leftSegments.length, rightSegments.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftSegments[index]
    const b = rightSegments[index]
    if (a !== b) return a < b ? -1 : 1
  }
  return leftSegments.length - rightSegments.length
}

async function seedSkillBundle(store: DomainStore, skill: SkillFixture): Promise<Ref> {
  const inputs = [
    { path: 'SKILL.md', bytes: textEncoder.encode(skill.content) },
    ...(skill.extraFiles ?? []).map(file => ({ path: file.path, bytes: textEncoder.encode(file.content) })),
  ]
  const files = []
  for (const input of inputs) {
    files.push({
      path: input.path,
      bytes: input.bytes.byteLength,
      object: await store.putObject(`skill-file:${skill.id}:${input.path}`, input.bytes, 'object'),
    })
  }
  files.sort((left, right) => compareBundlePath(left.path, right.path))
  const manifest = seal('object', { v: 1, kind: 'tree', files })
  return store.putObject(`skill-bundle:${skill.id}`, jsonBytes(manifest), 'object')
}

export async function seedMcpServer(
  store: DomainStore,
  fixture: McpServerFixture,
): Promise<{ readonly asset: ToolAsset; readonly bundle: Ref }> {
  const transport = fixture.transport ?? 'stdio'
  const entrypoint = fixture.entrypoint ?? (transport === 'stdio' ? 'server.ts' : 'src/server.ts')
  const toolCallTimeoutMs = fixture.toolCallTimeoutMs ?? 5_000
  const files = [{ path: entrypoint, content: fixture.source }]
  const bundle = await seedRawTree(store, `mcp-bundle:${fixture.serverName}`, files)
  const sourceFiles = await seedRawTree(store, `mcp-source:${fixture.serverName}`, files)
  const manifest = seal('object', {
    v: 1,
    serverName: fixture.serverName,
    transport,
    capabilities: [...fixture.capabilities],
    instructions: fixture.instructions,
    entrypoint,
    limits: {
      maxBundleBytes: 1024 * 1024,
      maxInstructionBytes: 8192,
      toolCallTimeoutMs,
    },
  })
  const manifestRef = await store.putObject(
    `mcp-manifest:${fixture.serverName}`,
    jsonBytes(manifest),
    'object',
  )
  const config = transport === 'stdio'
    ? seal('object', {
      v: 1,
      serverName: fixture.serverName,
      transport: 'stdio',
      command: 'node',
      args: [entrypoint],
      cwd: '.',
      env: {},
      toolCallTimeoutMs,
      maxInstructionBytes: 8192,
      failOnStartupError: true,
      reconnect: { enabled: false },
    })
    : seal('object', {
      v: 1,
      serverName: fixture.serverName,
      transport: 'streamable-http',
      url: fixture.url ?? '',
      headers: {},
      toolCallTimeoutMs,
      maxInstructionBytes: 8192,
      failOnStartupError: true,
      reconnect: { enabled: false },
    })
  const configRef = await store.putObject(
    `mcp-config:${fixture.serverName}`,
    jsonBytes(config),
    'object',
  )
  return {
    bundle,
    asset: {
      id: `tool:${fixture.serverName}`,
      name: fixture.serverName,
      description: `Frozen ${fixture.serverName} MCP server.`,
      kind: 'mcp-server',
      server: {
        bundle,
        manifest: manifestRef,
        sourceFiles,
        config: configRef,
        transport,
        capabilities: [...fixture.capabilities],
        exposedTools: [...fixture.exposedTools],
      },
    },
  }
}

export function fixtureUsage(index: number): NonNullable<ScriptedReply['usage']> {
  return {
    promptTokens: 40 + index * 10,
    completionTokens: 8,
    totalTokens: 48 + index * 10,
    cachedTokens: 0,
  }
}

export async function makeScenario(
  storeRoot: string,
  ctx: Context,
  options: {
    readonly taskId: string
    readonly maxRuns: number
    readonly deadlineAt?: number
    readonly maxStepsPerRun?: number
    readonly maxDepth?: number
    readonly maxTasks?: number
    readonly maxBatchChildren?: number
    readonly guidanceText?: string
    readonly otherGuidanceText?: string
    readonly skills?: readonly SkillFixture[]
    readonly mcpServers?: readonly McpServerFixture[]
    readonly childBinding?: {
      readonly bindingId: string
      readonly templateId: string
      readonly brief: string
      readonly join: 'required' | 'probe'
      readonly example: TaskExample
    }
  },
): Promise<Scenario> {
  const store = await DomainStore.open({ root: storeRoot })
  try {
    const skillAssets: SkillAsset[] = []
    const skillBundles: Ref[] = []
    for (const skill of options.skills ?? []) {
      const bundle = await seedSkillBundle(store, skill)
      skillBundles.push(bundle)
      skillAssets.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        bundle,
      })
    }
    const toolAssets: ToolAsset[] = []
    const mcpBundles: Ref[] = []
    for (const server of options.mcpServers ?? []) {
      const seeded = await seedMcpServer(store, server)
      toolAssets.push(seeded.asset)
      mcpBundles.push(seeded.bundle)
    }
    const guidance = await seedObject(store, 'guidance:s3c', {
      v: 1,
      text: options.guidanceText ?? 'Write the declared output.',
    })
    const otherGuidance = options.otherGuidanceText === undefined
      ? undefined
      : await seedObject(store, 'guidance:s3c-other', {
        v: 1,
        text: options.otherGuidanceText,
      })
    const example = await seedObject(store, 'example:s3c', { v: 1, goal: 'fixture example' })
    const childExample = options.childBinding === undefined
      ? undefined
      : await seedObject(store, 'example:s3c-child', options.childBinding.example)
    const acceptancePolicy = await seedObject(store, 'acceptance-policy:s3c', { v: 1, kind: 'fixture-policy' })
    const verifierObject = seal('object', {
      v: 1,
      kind: 'verifier-identity',
      name: PROVIDER_ID,
    })
    await store.putObject(PROVIDER_ID, jsonBytes(verifierObject), 'object')
    const provider: Ref = { id: PROVIDER_ID, digest: verifierObject.digest }

    const currentTemplate = {
      id: 'template:s3c',
      brief: 'Produce one declared file.',
      guidance,
      example,
      instanceSchema: {},
      requiredCriteria: [],
      requiredOutputs: [],
      acceptancePolicy,
      skills: skillAssets.map(skill => skill.id),
      tools: toolAssets.map(tool => tool.id),
      children: options.childBinding === undefined
        ? []
        : [{
          bindingId: options.childBinding.bindingId,
          templateId: options.childBinding.templateId,
          brief: options.childBinding.brief,
          join: options.childBinding.join,
        }],
    }
    const templates = otherGuidance === undefined
      ? [currentTemplate]
      : [
        currentTemplate,
        {
          ...currentTemplate,
          id: 'template:s3c-other',
          guidance: otherGuidance,
        },
      ]
    if (options.childBinding !== undefined) {
      assert.ok(childExample)
      templates.push({
        id: options.childBinding.templateId,
        brief: options.childBinding.brief,
        guidance,
        example: childExample,
        instanceSchema: {},
        requiredCriteria: [],
        requiredOutputs: [],
        acceptancePolicy,
        skills: skillAssets.map(skill => skill.id),
        tools: toolAssets.map(tool => tool.id),
        children: [],
      })
    }
    const method = sealMethodRevision({
      v: 1,
      id: 'method:s3c',
      entryTemplateId: 'template:s3c',
      templates,
      skills: skillAssets,
      tools: toolAssets,
    })
    await store.putObject(method.id, jsonBytes(method), 'method')
    const methodRef: Ref = { id: method.id, digest: method.digest }

    const input = await store.putObject(
      'input:source',
      textEncoder.encode('fixture input bytes\n'),
      'object',
    )
    const seed = await seedObject(store, 'seed:s3c', { v: 1, seed: 's3c-seed' })
    const profile = await seedObject(store, 'profile:s3c', { v: 1, profile: 's3c-profile' })
    const request = await seedObject(store, 'request:s3c', { v: 1, request: 'run recovery fixture' })
    const bashTool = await seedObject(store, 'base-tool:bash', { v: 1, name: 'bash' })

    const rootAdmission: RootAdmissionInput = {
      taskId: options.taskId,
      spec: {
        goal: {
          summary: `Use the native bash tool to write exactly ${JSON.stringify(FROZEN_OUTPUT)} to ${OUTPUT_PATH} with no trailing newline, then submit the declared output.`,
          deliverable: OUTPUT_PATH,
          scope: ['run recovery'],
          constraints: [
            'verifier consumes frozen CAS objects only',
            `${OUTPUT_PATH} must contain exactly ${JSON.stringify(FROZEN_OUTPUT)} with no trailing newline`,
          ],
        },
        criteria: [{
          id: CRITERION_ID,
          statement: `The declared output ${OUTPUT_PATH} exists and contains exactly ${JSON.stringify(FROZEN_OUTPUT)} with no trailing newline.`,
          required: true,
        }],
        localGuidance: [{
          id: 'exact-output',
          statement: `Use bash with printf, for example: printf %s ${JSON.stringify(FROZEN_OUTPUT)} > ${OUTPUT_PATH}`,
        }],
        inputs: [{
          id: 'source',
          object: input,
          path: 'input.txt',
          access: 'read',
        }],
        outputs: [{
          id: OUTPUT_ID,
          path: OUTPUT_PATH,
          kind: 'file',
          role: 'deliverable',
          required: true,
        }],
      },
      origin: { kind: 'root', purpose: 'work', requestRef: request },
      method: methodRef,
      template: { id: 'template:s3c', digest: method.digest },
      resources: { baseTools: [bashTool], skills: skillBundles, mcpServers: mcpBundles },
      acceptance: provider,
      environment: { seed, profile },
      limits: {
        maxRuns: options.maxRuns,
        maxStepsPerRun: options.maxStepsPerRun ?? 12,
        maxTokens: 1_000_000,
        deadlineAt: options.deadlineAt ?? Date.now() + 10 * 60 * 1000,
        maxDepth: options.maxDepth ?? 1,
        maxTasks: options.maxTasks ?? 1,
        maxBatchChildren: options.maxBatchChildren ?? 1,
      },
    }

    const contract = admitRootTask(rootAdmission)
    const composition = await buildSingleRunComposition(ctx, {
      store,
      id: 's3c',
      contract,
      agentOptions: agentOptions(),
      base: {
        v: 1,
        seed,
      },
    })
    const runAdmission: SingleRunAdmission = {
      contract,
      attempt: 1,
      budgetReservation: {
        tokens: contract.limits.maxTokens,
        steps: 10,
        deadlineAt: contract.limits.deadlineAt,
      },
      acceptanceBytes: jsonBytes(verifierObject),
      workspaceSeedBytes: jsonBytes({ v: 1, seed: 's3c-seed' }),
    }

    return { runAdmission, contract, method, composition, provider }
  } finally {
    await store.close()
  }
}

export function agentOptions(): AgentOptions {
  return {
    provider: 'singularity-local',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: ReasoningEffortId('max'),
  }
}
