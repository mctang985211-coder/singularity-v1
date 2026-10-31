import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalize,
  computeDigest,
  seal,
  sealMethodRevision,
  sealTaskContract,
} from '@singularity/protocol'
import type {
  JsonObject,
  JsonValue,
  MethodRevision,
  Ref,
  TaskContract,
  TaskTemplate,
  ToolAsset,
} from '@singularity/protocol'

import { MethodResourceError } from '../src/errors.ts'
import { DomainStore } from '../src/store.ts'
import { readMcpServers } from '../src/mcp-resources.ts'

const textEncoder = new TextEncoder()
let counter = 0

function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${String(counter)}`
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value as JsonValue))
}

async function putSealed(store: DomainStore, id: string, payload: JsonObject): Promise<Ref> {
  return store.putObject(id, jsonBytes(seal('object', payload)), 'object')
}

async function putTree(
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
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return putSealed(store, id, { v: 1, kind: 'tree', files: entries } as unknown as JsonObject)
}

async function withStore(run: (store: DomainStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-mcp-http-resources-'))
  const store = await DomainStore.open({ root })
  try {
    await run(store)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}

function manifest(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    v: 1,
    serverName: 'calc-http',
    transport: 'streamable-http',
    capabilities: ['tools', 'resources', 'resource-templates'],
    instructions: 'Use the HTTP calculator for one bounded expression.',
    entrypoint: 'src/server.ts',
    limits: {
      maxBundleBytes: 1024 * 1024,
      maxInstructionBytes: 8192,
      toolCallTimeoutMs: 250,
    },
    ...overrides,
  } as JsonObject
}

function httpConfig(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    v: 1,
    serverName: 'calc-http',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:43123/mcp',
    headers: {},
    toolCallTimeoutMs: 250,
    maxInstructionBytes: 8192,
    failOnStartupError: true,
    reconnect: { enabled: false },
    ...overrides,
  } as JsonObject
}

function toolAsset(refs: {
  readonly bundle: Ref
  readonly manifest: Ref
  readonly sourceFiles: Ref
  readonly config: Ref
}): ToolAsset {
  return {
    id: 'tool:calc-http',
    name: 'calculator-http',
    description: 'Runs one bounded HTTP calculation.',
    kind: 'mcp-server',
    server: {
      ...refs,
      transport: 'streamable-http',
      capabilities: ['tools', 'resources', 'resource-templates'],
      exposedTools: [{
        name: 'echo',
        description: 'Echo one message.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      }],
    },
  }
}

function templateFor(guidance: Ref, toolIds: readonly string[]): TaskTemplate {
  return {
    id: 'template:http',
    brief: 'Use the bound HTTP MCP server.',
    guidance,
    example: guidance,
    instanceSchema: {},
    requiredCriteria: [],
    requiredOutputs: [],
    acceptancePolicy: guidance,
    skills: [],
    tools: [...toolIds],
    children: [],
  }
}

function contractFor(method: MethodRevision, bundles: readonly Ref[]): TaskContract {
  const dummy = computeDigest('object', { v: 1, kind: 'dummy' })
  const template = method.templates[0]
  assert.ok(template)
  return sealTaskContract({
    v: 1,
    taskId: 'task:http',
    spec: {
      goal: { summary: 'Use one frozen HTTP MCP server.', deliverable: 'out.txt', scope: [], constraints: [] },
      criteria: [],
      inputs: [],
      outputs: [],
    },
    origin: { kind: 'root', purpose: 'work', requestRef: { id: 'request', digest: dummy } },
    method: { id: method.id, digest: method.digest },
    template: { id: template.id, digest: method.digest },
    resources: { baseTools: [], skills: [], mcpServers: [...bundles] },
    acceptance: { id: 'acceptance', digest: dummy },
    environment: { seed: { id: 'seed', digest: dummy }, profile: { id: 'profile', digest: dummy } },
    limits: {
      maxRuns: 1,
      maxStepsPerRun: 1,
      maxTokens: 1_000,
      deadlineAt: Date.now() + 60_000,
      maxDepth: 1,
      maxTasks: 1,
      maxBatchChildren: 1,
    },
  })
}

async function scenario(
  store: DomainStore,
  options: {
    readonly manifest?: JsonObject
    readonly config?: JsonObject
  } = {},
): Promise<{ method: MethodRevision; contract: TaskContract; template: TaskTemplate }> {
  const guidance = await store.putObject(
    nextId('guidance'),
    jsonBytes({ v: 1, text: 'Frozen HTTP MCP guidance.' }),
    'object',
  )
  const bundle = await putTree(store, nextId('bundle'), [{ path: 'src/server.ts', content: '// http fixture\n' }])
  const sourceFiles = await putTree(store, nextId('source'), [{ path: 'src/server.ts', content: '// http fixture\n' }])
  const manifestRef = await putSealed(store, nextId('manifest'), options.manifest ?? manifest())
  const configRef = await putSealed(store, nextId('config'), options.config ?? httpConfig())
  const refs = { bundle, manifest: manifestRef, sourceFiles, config: configRef }
  const asset = toolAsset(refs)
  const template = templateFor(guidance, [asset.id])
  const method = sealMethodRevision({
    v: 1,
    id: 'method:http',
    entryTemplateId: template.id,
    templates: [template],
    skills: [],
    tools: [asset],
  })
  await store.putObject(method.id, jsonBytes(method), 'method')
  return { method, contract: contractFor(method, [bundle]), template }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof MethodResourceError)
    assert.equal(error.code, code)
    return true
  })
}

void test('S4-A4 resolves a strict loopback streamable-http server', async () => {
  await withStore(async store => {
    const state = await scenario(store)
    const servers = await readMcpServers(store, state.method, state.template, state.contract.resources.mcpServers)
    assert.equal(servers.length, 1)
    const [server] = servers
    assert.ok(server)
    assert.equal(server.transport, 'streamable-http')
    assert.equal(server.serverName, 'calc-http')
    const configValue = server.configValue as unknown as {
      readonly transport: string
      readonly url?: string
      readonly headers?: Record<string, string>
    }
    assert.equal(configValue.transport, 'streamable-http')
    assert.equal(configValue.url, 'http://127.0.0.1:43123/mcp')
    assert.deepEqual(configValue.headers, {})
    assert.deepEqual(server.publicToolNames, ['mcp__calc-http__echo'])
  })
})

void test('S4-A4 accepts allowlisted localhost and IPv6 loopback URLs', async () => {
  await withStore(async store => {
    for (const url of ['http://localhost:43123/mcp', 'http://[::1]:43123/mcp']) {
      const state = await scenario(store, { config: httpConfig({ url }) })
      const servers = await readMcpServers(store, state.method, state.template, state.contract.resources.mcpServers)
      const [server] = servers
      assert.ok(server)
      assert.equal(server.transport, 'streamable-http')
      const configValue = server.configValue as unknown as { readonly url?: string }
      assert.equal(configValue.url, url)
    }
  })
})

void test('S4-A4 rejects credentialed or non-loopback HTTP config', async () => {
  await withStore(async store => {
    const unsupported = [
      httpConfig({ url: 'https://127.0.0.1:43123/mcp' }),
      httpConfig({ url: 'http://example.com/mcp' }),
      httpConfig({ url: 'http://user:pass@127.0.0.1:43123/mcp' }),
      httpConfig({ url: 'http://127.0.0.1:43123/mcp?token=raw' }),
      httpConfig({ url: 'http://127.0.0.1:43123/mcp#fragment' }),
      httpConfig({ url: 'http://127.0.0.1:43123/mcp?' }),
      httpConfig({ url: 'http://127.0.0.1:43123/mcp#' }),
      httpConfig({ headers: { authorization: 'raw' } }),
    ]
    for (const config of unsupported) {
      const state = await scenario(store, { config })
      await expectCode(
        readMcpServers(store, state.method, state.template, state.contract.resources.mcpServers),
        'UNSUPPORTED_RESOURCES',
      )
    }

    const malformed = [
      httpConfig({ url: '' }),
      httpConfig({ url: 'not a url' }),
      httpConfig({ url: 'http://localhost:43123/mcp', headers: [] }),
      httpConfig({ failOnStartupError: false }),
      httpConfig({ reconnect: { enabled: true } }),
      httpConfig({ maxInstructionBytes: 9000 }),
      httpConfig({ toolCallTimeoutMs: 251 }),
      httpConfig({ toolCallTimeoutMs: 0 }),
      httpConfig({ toolCallTimeoutMs: 1.5 }),
      httpConfig({ unexpected: true }),
      httpConfig({ serverName: 'other' }),
      httpConfig({ transport: 'stdio' }),
    ]
    for (const config of malformed) {
      const state = await scenario(store, { config })
      await expectCode(
        readMcpServers(store, state.method, state.template, state.contract.resources.mcpServers),
        'CONTRACT_INVALID',
      )
    }

    const mismatched = await scenario(store, { manifest: manifest({ transport: 'stdio' }) })
    await expectCode(
      readMcpServers(store, mismatched.method, mismatched.template, mismatched.contract.resources.mcpServers),
      'CONTRACT_INVALID',
    )
  })
})
