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
import { mcpCompositionEntry, mcpDispatchPlan, mcpPromptSections, readMcpServers } from '../src/mcp-resources.ts'
import { assertCompositionResources, loadMethodResources } from '../src/resources.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
let counter = 0

function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${String(counter)}`
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value as JsonValue))
}

async function putSealed(store: DomainStore, id: string, payload: JsonObject): Promise<Ref> {
  const sealed = seal('object', payload)
  return store.putObject(id, jsonBytes(sealed), 'object')
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
  const root = await mkdtemp(join(tmpdir(), 'singularity-mcp-resources-'))
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
    serverName: 'calc',
    transport: 'stdio',
    capabilities: ['tools', 'resources'],
    instructions: 'Use the calculator for one bounded expression.',
    entrypoint: 'dist/server.js',
    limits: {
      maxBundleBytes: 1024 * 1024,
      maxInstructionBytes: 8192,
      toolCallTimeoutMs: 250,
    },
    ...overrides,
  } as JsonObject
}

function config(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    v: 1,
    serverName: 'calc',
    transport: 'stdio',
    command: 'node',
    args: ['dist/server.js'],
    cwd: '.',
    env: {},
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
}, overrides: Partial<ToolAsset['server']> = {}): ToolAsset {
  return {
    id: 'tool:calc',
    name: 'calculator',
    description: 'Runs one bounded calculation.',
    kind: 'mcp-server',
    server: {
      ...refs,
      transport: 'stdio',
      capabilities: ['tools', 'resources'],
      exposedTools: [{
        name: 'add',
        description: 'Add two integers.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { a: { type: 'integer' }, b: { type: 'integer' } },
          required: ['a', 'b'],
        },
        output: { type: 'object' },
      }],
      ...overrides,
    },
  }
}

function templateFor(guidance: Ref, toolIds: readonly string[]): TaskTemplate {
  return {
    id: 'template:mcp',
    brief: 'Use the bound MCP server.',
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

function methodFor(guidance: Ref, tools: readonly ToolAsset[], template?: TaskTemplate): MethodRevision {
  return sealMethodRevision({
    v: 1,
    id: 'method:mcp',
    entryTemplateId: 'template:mcp',
    templates: [template ?? templateFor(guidance, tools.map(tool => tool.id))],
    skills: [],
    tools: [...tools],
  })
}

function contractFor(method: MethodRevision, bundles: readonly Ref[]): TaskContract {
  const dummy = computeDigest('object', { v: 1, kind: 'dummy' })
  const template = method.templates[0]
  assert.ok(template)
  return sealTaskContract({
    v: 1,
    taskId: 'task:mcp',
    spec: {
      goal: { summary: 'Use one frozen MCP server.', deliverable: 'out.txt', scope: [], constraints: [] },
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
    readonly tools?: (refs: {
      readonly bundle: Ref
      readonly manifest: Ref
      readonly sourceFiles: Ref
      readonly config: Ref
    }) => readonly ToolAsset[] | Promise<readonly ToolAsset[]>
    readonly templateToolIds?: readonly string[]
    readonly contractRefs?: readonly Ref[]
    readonly sourceFiles?: readonly { readonly path: string; readonly content: string }[]
  } = {},
): Promise<{ method: MethodRevision; contract: TaskContract; bundle: Ref; template: TaskTemplate }> {
  const guidance = await store.putObject(
    nextId('guidance'),
    jsonBytes({ v: 1, text: 'Frozen MCP guidance.' }),
    'object',
  )
  const bundle = await putTree(store, nextId('bundle'), [
    { path: 'dist/server.js', content: '// fixture server\n' },
    { path: 'refs/notes.txt', content: 'source note' },
  ])
  const sourceFiles = await putTree(store, nextId('source'), options.sourceFiles ?? [
    { path: 'dist/server.js', content: '// fixture server\n' },
  ])
  const manifestRef = await putSealed(store, nextId('manifest'), options.manifest ?? manifest())
  const configRef = await putSealed(store, nextId('config'), options.config ?? config())
  const refs = { bundle, manifest: manifestRef, sourceFiles, config: configRef }
  const tools = options.tools === undefined ? [toolAsset(refs)] : await options.tools(refs)
  const template = templateFor(guidance, options.templateToolIds ?? tools.map(tool => tool.id))
  const method = methodFor(guidance, tools, template)
  await store.putObject(method.id, jsonBytes(method), 'method')
  return {
    method,
    contract: contractFor(method, options.contractRefs ?? [bundle]),
    bundle,
    template,
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof MethodResourceError)
    assert.equal(error.code, code)
    return true
  })
}

void test('S4-A3 resolves frozen stdio MCP servers and derives schema/prompt identity', async () => {
  await withStore(async store => {
    const state = await scenario(store)
    const servers = await readMcpServers(
      store,
      state.method,
      state.template,
      state.contract.resources.mcpServers,
    )
    assert.equal(servers.length, 1)
    const [server] = servers
    assert.ok(server)
    assert.equal(server.serverName, 'calc')
    assert.equal(server.transport, 'stdio')
    assert.deepEqual(server.publicToolNames, ['mcp__calc__add'])
    assert.deepEqual(server.capabilities, ['tools', 'resources'])
    assert.equal(server.manifest.id, state.method.tools[0]?.server.manifest.id)
    assert.equal(server.bundle.id, state.bundle.id)
    assert.equal(server.config.id, state.method.tools[0]?.server.config.id)
    assert.equal(server.schema.digest, computeDigest('object', server.schemaPayload))
    const storedSchema = await store.putObject(server.schema.id, jsonBytes(server.schemaPayload), 'object')
    assert.equal(storedSchema.digest, server.schema.digest)
    const schema = await store.readObject(server.schema, 'object')
    assert.deepEqual(JSON.parse(textDecoder.decode(schema.bytes)), server.schemaPayload)
    const sections = mcpPromptSections(servers, 3100)
    assert.deepEqual(sections.map(section => section.name), ['mcp-resource-servers', 'mcp:calc'])
    assert.ok(sections[1]?.text.includes('Use the calculator'))
    assert.ok(sections[0]?.text.includes('["calc"]'))
  })
})

void test('S4-A3 uses the exact DSH instruction section bytes and trims empty tails', async () => {
  await withStore(async store => {
    const body = 'Use the calculator for one bounded expression.'
    const section = `### MCP server: calc\n\n${body}`
    const sectionBytes = textEncoder.encode(section).byteLength
    const limits = {
      maxBundleBytes: 1024 * 1024,
      maxInstructionBytes: sectionBytes,
      toolCallTimeoutMs: 250,
    }
    const exact = await scenario(store, {
      manifest: manifest({ instructions: body, limits }),
      config: config({ maxInstructionBytes: sectionBytes }),
    })
    const exactServers = await readMcpServers(store, exact.method, exact.template, exact.contract.resources.mcpServers)
    assert.equal(mcpPromptSections(exactServers, 3100)[1]?.text, section)

    const trailing = await scenario(store, {
      manifest: manifest({ instructions: `${body}   \n\t ` }),
    })
    const trailingServers = await readMcpServers(store, trailing.method, trailing.template, trailing.contract.resources.mcpServers)
    assert.equal(mcpPromptSections(trailingServers, 3100)[1]?.text, section)

    const whitespace = await scenario(store, {
      manifest: manifest({ instructions: ' \n\t', limits: { ...limits, maxInstructionBytes: 1 } }),
      config: config({ maxInstructionBytes: 1 }),
    })
    const whitespaceServers = await readMcpServers(store, whitespace.method, whitespace.template, whitespace.contract.resources.mcpServers)
    assert.deepEqual(mcpPromptSections(whitespaceServers, 3100).map(entry => entry.name), ['mcp-resource-servers'])

    const overManifest = await scenario(store, {
      manifest: manifest({
        instructions: body,
        limits: { ...limits, maxInstructionBytes: textEncoder.encode(body).byteLength },
      }),
      config: config({ maxInstructionBytes: textEncoder.encode(body).byteLength }),
    })
    await expectCode(
      readMcpServers(store, overManifest.method, overManifest.template, overManifest.contract.resources.mcpServers),
      'CONTRACT_INVALID',
    )

    const overConfig = await scenario(store, {
      manifest: manifest({ instructions: body, limits }),
      config: config({ maxInstructionBytes: sectionBytes - 1 }),
    })
    await expectCode(
      readMcpServers(store, overConfig.method, overConfig.template, overConfig.contract.resources.mcpServers),
      'CONTRACT_INVALID',
    )
  })
})

void test('S4-A3 verifies Composition MCP fields and contract bundle refs exactly', async () => {
  await withStore(async store => {
    const state = await scenario(store)
    const servers = await readMcpServers(store, state.method, state.template, state.contract.resources.mcpServers)
    const [server] = servers
    assert.ok(server)
    const resources = await loadMethodResources(store, state.contract)
    const template = await store.putObject(nextId('composition-template'), jsonBytes(state.method.templates[0]), 'object')
    const entry = mcpCompositionEntry(server)
    const composition = {
      template,
      guidance: state.method.templates[0]?.guidance,
      skills: [],
      mcpServers: [entry],
    }
    assert.ok(composition.guidance)
    await assertCompositionResources(store, resources, composition)

    const other = await putSealed(store, nextId('other-ref'), { v: 1, other: true })
    const tamperedEntries = [
      { ...entry, manifest: other },
      { ...entry, bundle: other },
      { ...entry, schema: other },
      { ...entry, config: other },
      { ...entry, transport: 'streamable-http' as const },
      { ...entry, capabilities: ['resources'] },
    ]
    for (const tampered of tamperedEntries) {
      await expectCode(
        assertCompositionResources(store, resources, { ...composition, mcpServers: [tampered] }),
        'COMPOSITION_MISMATCH',
      )
    }

    await expectCode(
      readMcpServers(store, state.method, state.template, [{ id: state.bundle.id, digest: other.digest }]),
      'CONTRACT_INVALID',
    )

    const guidance2 = await putSealed(store, nextId('guidance2'), { v: 1, text: 'Two server guidance.' })
    const secondBundle = await putTree(store, nextId('bundle2'), [{ path: 'dist/server.js', content: '// second server\n' }])
    const secondSource = await putTree(store, nextId('source2'), [{ path: 'dist/server.js', content: '// second server\n' }])
    const secondManifest = await putSealed(store, nextId('manifest2'), manifest({ serverName: 'calc2' }))
    const secondConfig = await putSealed(store, nextId('config2'), config({ serverName: 'calc2' }))
    const secondAsset: ToolAsset = {
      ...toolAsset({
        bundle: secondBundle,
        manifest: secondManifest,
        sourceFiles: secondSource,
        config: secondConfig,
      }),
      id: 'tool:calc2',
      name: 'calc2',
    }
    const firstAsset = state.method.tools[0]
    assert.ok(firstAsset)
    const twoTemplate = templateFor(guidance2, ['tool:calc', 'tool:calc2'])
    const twoMethod = sealMethodRevision({
      v: 1,
      id: nextId('method-two'),
      entryTemplateId: twoTemplate.id,
      templates: [twoTemplate],
      skills: [],
      tools: [firstAsset, secondAsset],
    })
    await store.putObject(twoMethod.id, jsonBytes(twoMethod), 'method')
    const twoContract = contractFor(twoMethod, [secondBundle, state.bundle])
    await expectCode(
      readMcpServers(store, twoMethod, twoTemplate, twoContract.resources.mcpServers),
      'CONTRACT_INVALID',
    )
  })
})

void test('S4-A3 rejects interface, catalog, transport, and contract mismatches', async () => {
  await withStore(async store => {
    const state = await scenario(store)
    await expectCode(
      readMcpServers(store, state.method, state.template, []),
      'CONTRACT_INVALID',
    )

    const missingTool = await scenario(store, { templateToolIds: ['tool:missing'] })
    await expectCode(readMcpServers(store, missingTool.method, missingTool.template, missingTool.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const duplicateId = await scenario(store, {
      tools: refs => [
        toolAsset(refs),
        { ...toolAsset(refs), id: 'tool:calc', name: 'other' },
      ],
    })
    await expectCode(readMcpServers(store, duplicateId.method, duplicateId.template, duplicateId.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const duplicateServer = await scenario(store, {
      tools: refs => [
        toolAsset(refs),
        { ...toolAsset(refs), id: 'tool:other', name: 'other' },
      ],
    })
    await expectCode(readMcpServers(store, duplicateServer.method, duplicateServer.template, duplicateServer.contract.resources.mcpServers), 'CONTRACT_INVALID')

    // HTTP manifest/asset with a stdio-shaped config must fail closed-key validation.
    const httpWithStdioConfig = await scenario(store, {
      manifest: manifest({ transport: 'streamable-http' }),
      config: config({ transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' }),
      tools: refs => [toolAsset(refs, { transport: 'streamable-http' })],
    })
    await expectCode(readMcpServers(store, httpWithStdioConfig.method, httpWithStdioConfig.template, httpWithStdioConfig.contract.resources.mcpServers), 'CONTRACT_INVALID')
  })
})

void test('S4-A3 enforces the deployment capability allowlist instead of arbitrary metadata', async () => {
  await withStore(async store => {
    const unknown = await scenario(store, {
      manifest: manifest({ capabilities: ['filesystem.read'] }),
      tools: refs => [toolAsset(refs, { capabilities: ['filesystem.read'] })],
    })
    await expectCode(readMcpServers(store, unknown.method, unknown.template, unknown.contract.resources.mcpServers), 'UNSUPPORTED_RESOURCES')

    const empty = await scenario(store, {
      manifest: manifest({ capabilities: [] }),
      tools: refs => [toolAsset(refs, { capabilities: [] })],
    })
    await expectCode(readMcpServers(store, empty.method, empty.template, empty.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const duplicate = await scenario(store, {
      manifest: manifest({ capabilities: ['tools', 'tools'] }),
      tools: refs => [toolAsset(refs, { capabilities: ['tools', 'tools'] })],
    })
    await expectCode(readMcpServers(store, duplicate.method, duplicate.template, duplicate.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const missingTools = await scenario(store, {
      manifest: manifest({ capabilities: ['resources'] }),
      tools: refs => [toolAsset(refs, { capabilities: ['resources'] })],
    })
    await expectCode(readMcpServers(store, missingTools.method, missingTools.template, missingTools.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const resourcesOnly = await scenario(store, {
      manifest: manifest({ capabilities: ['resources', 'resource-templates'] }),
      tools: refs => [toolAsset(refs, { capabilities: ['resources', 'resource-templates'], exposedTools: [] })],
    })
    const [server] = await readMcpServers(store, resourcesOnly.method, resourcesOnly.template, resourcesOnly.contract.resources.mcpServers)
    assert.ok(server)
    assert.deepEqual(server.capabilities, ['resources', 'resource-templates'])
    assert.deepEqual(server.publicToolNames, [])

    const toolsOnly = await scenario(store, {
      manifest: manifest({ capabilities: ['tools'] }),
      tools: refs => [toolAsset(refs, { capabilities: ['tools'] })],
    })
    const [toolsOnlyServer] = await readMcpServers(store, toolsOnly.method, toolsOnly.template, toolsOnly.contract.resources.mcpServers)
    assert.ok(toolsOnlyServer)
    assert.deepEqual(toolsOnlyServer.capabilities, ['tools'])
    assert.deepEqual(mcpDispatchPlan([toolsOnlyServer]).resourceToolNames, [
      'list_mcp_resources',
      'list_mcp_resource_templates',
      'read_mcp_resource',
    ])
  })
})

void test('S4-A3 rejects unsafe config, manifest, schema, and tree objects', async () => {
  await withStore(async store => {
    const absoluteConfig = await scenario(store, { config: config({ args: ['/host/server.js'] }) })
    await expectCode(readMcpServers(store, absoluteConfig.method, absoluteConfig.template, absoluteConfig.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const secretConfig = await scenario(store, { config: config({ env: { API_KEY: 'raw-secret' } }) })
    await expectCode(readMcpServers(store, secretConfig.method, secretConfig.template, secretConfig.contract.resources.mcpServers), 'UNSUPPORTED_RESOURCES')

    const wrongEntrypoint = await scenario(store, { manifest: manifest({ entrypoint: 'dist/missing.js' }) })
    await expectCode(readMcpServers(store, wrongEntrypoint.method, wrongEntrypoint.template, wrongEntrypoint.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const wrongInstructions = await scenario(store, { config: config({ maxInstructionBytes: 9000 }) })
    await expectCode(readMcpServers(store, wrongInstructions.method, wrongInstructions.template, wrongInstructions.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const tinyBundle = await scenario(store, {
      manifest: manifest({
        limits: { maxBundleBytes: 8, maxInstructionBytes: 8192, toolCallTimeoutMs: 250 },
      }),
    })
    await expectCode(readMcpServers(store, tinyBundle.method, tinyBundle.template, tinyBundle.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const subset = await scenario(store, {
      sourceFiles: [{ path: 'other/source.js', content: '// not in the bundle\n' }],
    })
    await expectCode(readMcpServers(store, subset.method, subset.template, subset.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const unknownManifestKey = await scenario(store, { manifest: manifest({ unexpected: true }) })
    await expectCode(readMcpServers(store, unknownManifestKey.method, unknownManifestKey.template, unknownManifestKey.contract.resources.mcpServers), 'CONTRACT_INVALID')

    const shellConfig = await scenario(store, { config: config({ command: 'sh' }) })
    await expectCode(readMcpServers(store, shellConfig.method, shellConfig.template, shellConfig.contract.resources.mcpServers), 'UNSUPPORTED_RESOURCES')

    const dirtyName = await scenario(store, {
      tools: refs => [toolAsset(refs, {
        exposedTools: [{
          name: 'bad-name',
          description: 'Dirty tool name.',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
        }],
      })],
    })
    await expectCode(readMcpServers(store, dirtyName.method, dirtyName.template, dirtyName.contract.resources.mcpServers), 'UNSUPPORTED_RESOURCES')

    const longName = await scenario(store, {
      tools: refs => [toolAsset(refs, {
        exposedTools: [{
          name: 'x'.repeat(61),
          description: 'Overlong public name.',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
        }],
      })],
    })
    await expectCode(readMcpServers(store, longName.method, longName.template, longName.contract.resources.mcpServers), 'UNSUPPORTED_RESOURCES')
  })
})
