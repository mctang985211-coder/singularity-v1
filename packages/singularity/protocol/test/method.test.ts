import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDigest, digestSchema, verifyDigest } from '../src/digest.ts'
import * as protocol from '../src/index.ts'
import {
  childBindingSchema,
  methodRevisionPayloadSchema,
  methodRevisionSchema,
  sealMethodRevision,
  skillAssetSchema,
  taskTemplateSchema,
  toolAssetSchema,
  verifyMethodRevision,
} from '../src/method.ts'
import type {
  ChildBinding,
  MethodRevision,
  MethodRevisionPayload,
  OutputSpec,
  SkillAsset,
  TaskTemplate,
  ToolAsset,
} from '../src/method.ts'

const REF_DIGEST = `sha256:${'a'.repeat(64)}`

function objectRef(id: string): { readonly id: string; readonly digest: string } {
  return { id, digest: REF_DIGEST }
}

function childBinding(overrides: Partial<ChildBinding> = {}): ChildBinding {
  return {
    bindingId: 'binding-a',
    templateId: 'template-a',
    brief: 'Produce one bounded part of the parent goal.',
    join: 'required',
    ...overrides,
  }
}

function minimalTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: 'template-a',
    brief: 'Execute one bounded part of the parent goal.',
    guidance: objectRef('guidance-a'),
    example: objectRef('example-a'),
    instanceSchema: { type: 'object', additionalProperties: false },
    requiredCriteria: [],
    requiredOutputs: [],
    acceptancePolicy: objectRef('acceptance-a'),
    skills: [],
    tools: [],
    children: [],
    ...overrides,
  }
}

function skillAsset(overrides: Partial<SkillAsset> = {}): SkillAsset {
  return {
    id: 'skill-a',
    name: 'bounded-work',
    description: 'Guidance for one bounded work step.',
    bundle: objectRef('skill-bundle-a'),
    ...overrides,
  }
}

const stdioTool: ToolAsset = {
  id: 'server-calculator',
  name: 'calculator',
  description: 'Runs bounded calculations for the current task.',
  kind: 'mcp-server',
  server: {
    bundle: objectRef('bundle-calculator'),
    manifest: objectRef('manifest-calculator'),
    sourceFiles: objectRef('sources-calculator'),
    config: objectRef('config-calculator'),
    transport: 'stdio',
    capabilities: ['filesystem.read', 'network.none'],
    exposedTools: [
      {
        name: 'calculate',
        description: 'Computes one bounded expression.',
        parameters: {
          type: 'object',
          required: ['expression'],
          properties: { expression: { type: 'string' } },
        },
        output: {
          type: 'object',
          properties: { value: { type: 'number' } },
        },
      },
      {
        name: 'status',
        description: 'Reports server readiness.',
        parameters: { type: 'object', additionalProperties: false },
      },
    ],
  },
}

const httpTool: ToolAsset = {
  ...stdioTool,
  id: 'server-search',
  name: 'search',
  description: 'Runs bounded public searches for the current task.',
  server: {
    ...stdioTool.server,
    bundle: objectRef('bundle-search'),
    manifest: objectRef('manifest-search'),
    sourceFiles: objectRef('sources-search'),
    config: objectRef('config-search'),
    transport: 'streamable-http',
    capabilities: ['network.read'],
    exposedTools: [
      {
        name: 'search',
        description: 'Runs one bounded public query.',
        parameters: { type: 'object' },
        output: { type: 'object' },
      },
    ],
  },
}

function withExtra(value: object): object {
  return { ...value, extra: true }
}

void test('method-empty is valid and seals in the method domain', () => {
  const payload: MethodRevisionPayload = {
    v: 1,
    id: 'method-empty',
    templates: [],
    skills: [],
    tools: [],
  }

  const sealed: MethodRevision = sealMethodRevision(payload)

  assert.equal(sealed.digest, computeDigest('method', payload))
  assert.equal(digestSchema.safeParse(sealed.digest).success, true)
  assert.equal(verifyMethodRevision(sealed), true)
  assert.equal(verifyDigest('method', sealed), true)
  assert.equal(verifyDigest('contract', sealed), false)
  assert.equal('entryTemplateId' in sealed, false)
  assert.equal('parent' in sealed, false)
  assert.deepEqual(sealed.templates, [])
  assert.deepEqual(sealed.skills, [])
  assert.deepEqual(sealed.tools, [])
  assert.deepEqual(methodRevisionPayloadSchema.parse(payload), payload)
  assert.deepEqual(methodRevisionSchema.parse(sealed), sealed)
  assert.equal(sealMethodRevision(payload).digest, sealed.digest)
})

void test('recursive and dangling child bindings remain structural only', () => {
  const recursiveBinding: ChildBinding = childBinding({
    bindingId: 'recursive',
    templateId: 'template-a',
  })
  const missingBinding: ChildBinding = childBinding({
    bindingId: 'missing-target',
    templateId: 'template-not-in-catalog',
    join: 'probe',
  })

  const templateA: TaskTemplate = minimalTemplate({
    id: 'template-a',
    children: [recursiveBinding, missingBinding],
    skills: ['skill-not-in-catalog'],
    tools: ['server-not-in-catalog'],
  })
  const templateB: TaskTemplate = minimalTemplate({
    id: 'template-b',
    children: [
      childBinding({
        bindingId: 'back-to-a',
        templateId: 'template-a',
      }),
    ],
  })

  assert.deepEqual(childBindingSchema.parse(recursiveBinding), recursiveBinding)
  assert.deepEqual(taskTemplateSchema.parse(templateA), templateA)

  const sealed = sealMethodRevision({
    v: 1,
    id: 'method-recursive',
    parent: objectRef('method-parent'),
    entryTemplateId: 'template-a',
    templates: [templateA, templateB],
    skills: [],
    tools: [],
  })

  assert.equal(verifyMethodRevision(sealed), true)
  assert.deepEqual(sealed.parent, objectRef('method-parent'))
  assert.equal(sealed.entryTemplateId, 'template-a')
  assert.equal(sealed.templates[0].children[0].templateId, 'template-a')
  assert.equal(sealed.templates[0].children[1].templateId, 'template-not-in-catalog')
  assert.equal(sealed.templates[1].children[0].templateId, 'template-a')
  assert.deepEqual(sealed.templates[0].skills, ['skill-not-in-catalog'])
  assert.deepEqual(sealed.templates[0].tools, ['server-not-in-catalog'])
})

void test('full MCP server assets preserve every frozen server field', () => {
  const parsedStdio: ToolAsset = toolAssetSchema.parse(stdioTool)
  const parsedHttp: ToolAsset = toolAssetSchema.parse(httpTool)
  const parsedSkill: SkillAsset = skillAssetSchema.parse(skillAsset())

  assert.deepEqual(parsedStdio, stdioTool)
  assert.deepEqual(parsedHttp, httpTool)
  assert.deepEqual(parsedSkill, skillAsset())
  assert.equal(parsedStdio.server.transport, 'stdio')
  assert.equal(parsedHttp.server.transport, 'streamable-http')
  assert.equal(parsedStdio.server.exposedTools.length, 2)
  assert.deepEqual(parsedStdio.server.exposedTools[1].parameters, {
    type: 'object',
    additionalProperties: false,
  })
  assert.equal(parsedStdio.server.exposedTools[1].output, undefined)
  assert.deepEqual(parsedHttp.server.exposedTools[0].output, { type: 'object' })

  const sealed = sealMethodRevision({
    v: 1,
    id: 'method-tools',
    templates: [minimalTemplate({ tools: [stdioTool.id, httpTool.id] })],
    skills: [parsedSkill],
    tools: [parsedStdio, parsedHttp],
  })

  assert.equal(verifyMethodRevision(sealed), true)
  assert.deepEqual(sealed.tools, [stdioTool, httpTool])
})

void test('rejects unsupported transport, invalid join, unknown fields, and malformed refs', () => {
  const unsupportedTransport = ['s', 's', 'e'].join('')
  for (const transport of [unsupportedTransport, 'websocket']) {
    assert.throws(() =>
      toolAssetSchema.parse({
        ...stdioTool,
        server: { ...stdioTool.server, transport },
      }),
    )
  }

  const invalidJoin: string = 'optional'
  assert.throws(() => childBindingSchema.parse({ ...childBinding(), join: invalidJoin }))
  assert.throws(() => childBindingSchema.parse(withExtra(childBinding())))

  const criterion = { id: 'criterion-a', statement: 'The result is traceable.', required: true }
  const output: OutputSpec = {
    id: 'result',
    path: 'result.json',
    kind: 'file',
    role: 'deliverable',
    required: true,
  }
  assert.deepEqual(
    taskTemplateSchema.parse(minimalTemplate({ requiredCriteria: [criterion], requiredOutputs: [output] }))
      .requiredOutputs,
    [output],
  )

  const sealed = sealMethodRevision({
    v: 1,
    id: 'method-validation',
    templates: [minimalTemplate()],
    skills: [skillAsset()],
    tools: [stdioTool],
  })
  const exposedTool = stdioTool.server.exposedTools[0]
  for (const invalid of [
    () => methodRevisionPayloadSchema.parse(withExtra(methodRevisionPayload())),
    () => methodRevisionSchema.parse(withExtra(sealed)),
    () => taskTemplateSchema.parse(withExtra(minimalTemplate())),
    () =>
      taskTemplateSchema.parse({
        ...minimalTemplate(),
        requiredCriteria: [withExtra(criterion)],
      }),
    () =>
      taskTemplateSchema.parse({
        ...minimalTemplate(),
        requiredOutputs: [withExtra(output)],
      }),
    () =>
      taskTemplateSchema.parse({
        ...minimalTemplate(),
        children: [withExtra(childBinding())],
      }),
    () => skillAssetSchema.parse(withExtra(skillAsset())),
    () => toolAssetSchema.parse(withExtra(stdioTool)),
    () =>
      toolAssetSchema.parse({
        ...stdioTool,
        server: withExtra(stdioTool.server),
      }),
    () =>
      toolAssetSchema.parse({
        ...stdioTool,
        server: {
          ...stdioTool.server,
          exposedTools: [withExtra(exposedTool)],
        },
      }),
    () =>
      methodRevisionPayloadSchema.parse({
        ...methodRevisionPayload(),
        parent: { id: 'method-parent' },
      }),
    () =>
      methodRevisionPayloadSchema.parse({
        ...methodRevisionPayload(),
        parent: { id: 'method-parent', digest: 'not-a-digest' },
      }),
    () => taskTemplateSchema.parse({ ...minimalTemplate(), guidance: { id: 'guidance-a' } }),
    () =>
      toolAssetSchema.parse({
        ...stdioTool,
        server: { ...stdioTool.server, bundle: { id: 'bundle-calculator' } },
      }),
  ]) {
    assert.throws(invalid)
  }
})

void test('detects digest tampering, wrong domains, and unsealed values', () => {
  const sealed = sealMethodRevision({
    v: 1,
    id: 'method-digest',
    templates: [minimalTemplate()],
    skills: [],
    tools: [],
  })

  assert.equal(verifyMethodRevision(sealed), true)
  assert.equal(verifyMethodRevision({ ...sealed, id: 'tampered' }), false)
  assert.equal(verifyMethodRevision({ ...sealed, templates: [] }), false)
  assert.equal(verifyMethodRevision({ ...sealed, extra: true }), false)
  assert.equal(verifyMethodRevision({ ...sealed, digest: `sha256:${'0'.repeat(64)}` }), false)
  assert.equal(
    verifyMethodRevision({ ...sealed, digest: computeDigest('contract', sealed) }),
    false,
  )
  assert.equal(verifyMethodRevision({ ...sealed, digest: sealed.digest.toUpperCase() }), false)
  assert.equal(verifyMethodRevision({ ...sealed, digest: 1 }), false)
  assert.equal(
    verifyMethodRevision({
      v: 1,
      id: 'method-digest',
      templates: [],
      skills: [],
      tools: [],
    }),
    false,
  )
  assert.equal(verifyMethodRevision(null), false)
  assert.equal(verifyDigest('contract', sealed), false)
  assert.equal(verifyDigest('method', sealed), true)
})

void test('sealMethodRevision rejects malformed payloads before sealing', () => {
  const payload: MethodRevisionPayload = {
    v: 1,
    id: 'method-malformed',
    templates: [],
    skills: [],
    tools: [],
  }

  assert.throws(() => sealMethodRevision(withExtra(payload) as MethodRevisionPayload))
  assert.throws(() =>
    sealMethodRevision({
      ...payload,
      templates: [{ ...minimalTemplate(), instanceSchema: [] }],
    } as unknown as MethodRevisionPayload),
  )
})

void test('index exports existing protocol surface plus Method schemas and helpers', () => {
  const exported = [
    'CanonicalJsonError',
    'canonicalize',
    'parseJsonText',
    'jsonValueSchema',
    'jsonObjectSchema',
    'DIGEST_DOMAINS',
    'digestDomainSchema',
    'digestSchema',
    'computeDigestBytes',
    'computeDigest',
    'seal',
    'verifyDigest',
    'closedObject',
    'parseProtocolValue',
    'protocolJsonSchema',
    'ProtocolSchemaError',
    'refSchema',
    'methodRevisionSchema',
    'methodRevisionPayloadSchema',
    'taskTemplateSchema',
    'outputSpecSchema',
    'childBindingSchema',
    'skillAssetSchema',
    'toolAssetSchema',
    'sealMethodRevision',
    'verifyMethodRevision',
    'remainingBudgetPctSchema',
    'TOOL_ERROR_CODES',
    'toolErrorCodeSchema',
    'toolErrorSchema',
  ] as const

  for (const name of exported) {
    assert.ok(Object.hasOwn(protocol, name), `${name} must be exported from the protocol index`)
  }
  assert.equal(protocol.methodRevisionSchema, methodRevisionSchema)
  assert.equal(protocol.taskTemplateSchema, taskTemplateSchema)
  assert.equal(protocol.childBindingSchema, childBindingSchema)
  assert.equal(protocol.skillAssetSchema, skillAssetSchema)
  assert.equal(protocol.toolAssetSchema, toolAssetSchema)
  assert.equal(protocol.sealMethodRevision, sealMethodRevision)
  assert.equal(protocol.verifyMethodRevision, verifyMethodRevision)
})

function methodRevisionPayload(): MethodRevisionPayload {
  return {
    v: 1,
    id: 'method-validation',
    templates: [minimalTemplate()],
    skills: [skillAsset()],
    tools: [stdioTool],
  }
}
