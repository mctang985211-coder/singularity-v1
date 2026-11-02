import {checkRecipeRef} from './check-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type {
JsonObject,
JsonValue,
MethodRevision,
Ref,
SkillAsset,
TaskContract,
TaskTemplate,
} from '@singularity/protocol'
import {
canonicalize,
computeDigest,
computeDigestBytes,
seal,
sealMethodRevision,
sealTaskContract,
} from '@singularity/protocol'

import { materializeSkills } from '../src/agent-skills.ts'
import { TreeBundleError,readTreeBundle } from '../src/resource-bundle.ts'
import { MethodResourceError,assertCompositionResources,loadMethodResources } from '../src/resources.ts'
import { DomainStore } from '../src/store.ts'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const RESOURCE_BASE = {
  kind: 'directory' as const,
  path: '.',
}
const SKILL_NAME = 'bounded-work'
const SKILL_DESCRIPTION = 'Use the frozen instructions for one bounded work step.'
let counter = 0

interface TreeFileInput {
  readonly path: string
  readonly bytes: Uint8Array
}

interface TreeVariant {
  readonly reverse?: boolean
  readonly unsealed?: boolean
  readonly nonCanonical?: boolean
  readonly manifest?: unknown
}

function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${String(counter)}`
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalize(value as JsonValue))
}

async function putValue(store: DomainStore, value: unknown, id: string, domain: 'object' | 'method' = 'object'): Promise<Ref> {
  return store.putObject(id, jsonBytes(value), domain)
}

function comparePath(left: string, right: string): number {
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

async function putTree(
  store: DomainStore,
  files: readonly TreeFileInput[],
  variant: TreeVariant = {},
): Promise<Ref> {
  const leaves = []
  for (const file of files) {
    const object = await store.putObject(nextId(`tree-file:${file.path}`), file.bytes, 'object')
    leaves.push({ path: file.path, bytes: file.bytes.byteLength, object })
  }
  const ordered = variant.reverse === true ? [...leaves].reverse() : [...leaves].sort((a, b) => comparePath(a.path, b.path))
  const body = variant.manifest ?? { v: 1, kind: 'tree', files: ordered }
  const manifest = variant.unsealed === true ? body : seal('object', body as JsonObject)
  const bytes = variant.nonCanonical === true
    ? textEncoder.encode(JSON.stringify(manifest, null, 2))
    : jsonBytes(manifest)
  return store.putObject(nextId('tree-manifest'), bytes, 'object')
}

async function buildSkillBundle(
  store: DomainStore,
  content: string | Uint8Array,
  extra: readonly TreeFileInput[] = [],
): Promise<Ref> {
  const skillBytes = typeof content === 'string' ? textEncoder.encode(content) : content
  return putTree(store, [{ path: 'SKILL.md', bytes: skillBytes }, ...extra])
}

function skillAsset(id: string, name: string, description: string, bundle: Ref): SkillAsset {
  return { id, name, description, bundle }
}

function templateFor(guidance: Ref, skillIds: readonly string[]): TaskTemplate {
  return {
    id: 'template:skill',
    brief: 'Execute one bounded skill step.',
    guidance,
    example: guidance,
    instanceSchema: {},
    requiredCriteria: [],
    requiredOutputs: [],
    acceptancePolicy: guidance,
    skills: [...skillIds],
    tools: [],
    children: [],
  }
}

function methodFor(guidance: Ref, skills: readonly SkillAsset[], template?: TaskTemplate): MethodRevision {
  return sealMethodRevision({
    v: 1,
    id: 'method:skill',
    entryTemplateId: 'template:skill',
    templates: [template ?? templateFor(guidance, skills.map(skill => skill.id))],
    skills: [...skills],
    tools: [],
  })
}

function contractFor(method: MethodRevision, skillRefs: readonly Ref[]): TaskContract {
  const dummy = computeDigest('object', { v: 1, kind: 'dummy' })
  const template = method.templates[0]
  assert.ok(template)
  return sealTaskContract({
    v: 1,
    taskId: 'task:skill',
    spec: {
      goal: { summary: 'Exercise one frozen skill.', deliverable: 'out.txt', scope: [], constraints: [] },
      criteria: [{id:'task-goal',statement:'The local result is checked.',required:true,checks:[{checkId:'task-goal',recipeRef:checkRecipeRef,params:{}}]}],
      inputs: [],
      outputs: [],
    },
    origin: { kind: 'root', purpose: 'work', requestRef: { id: 'request', digest: dummy } },
    method: { id: method.id, digest: method.digest },
    template: { id: template.id, digest: method.digest },
    resources: { baseTools: [], skills: [...skillRefs], mcpServers: [] },
    acceptance: { id: 'acceptance', digest: dummy },
    environment: {
      seed: { id: 'seed', digest: dummy },
      profile: { id: 'profile', digest: dummy },
    },
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

async function withStore(run: (store: DomainStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-s4a2-unit-'))
  const store = await DomainStore.open({ root })
  try {
    await run(store, root)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof MethodResourceError)
    assert.equal(error.code, code)
    return true
  })
}

async function scenario(
  store: DomainStore,
  options: {
    readonly skills?: readonly {
      readonly id: string
      readonly name: string
      readonly description: string
      readonly content: string | Uint8Array
      readonly extra?: readonly TreeFileInput[]
    }[]
    readonly templateSkillIds?: readonly string[]
    readonly contractRefs?: readonly Ref[]
    readonly template?: (guidance: Ref, ids: readonly string[]) => TaskTemplate
  } = {},
): Promise<{ contract: TaskContract; method: MethodRevision; bundles: Ref[]; guidance: Ref; templateRef: Ref }> {
  const guidance = await putValue(store, { v: 1, text: 'Frozen skill guidance.' }, nextId('guidance'))
  const bundles: Ref[] = []
  const assets: SkillAsset[] = []
  for (const skill of options.skills ?? []) {
    const bundle = await buildSkillBundle(store, skill.content, skill.extra)
    bundles.push(bundle)
    assets.push(skillAsset(skill.id, skill.name, skill.description, bundle))
  }
  const template = options.template?.(guidance, options.templateSkillIds ?? assets.map(skill => skill.id))
    ?? templateFor(guidance, options.templateSkillIds ?? assets.map(skill => skill.id))
  const method = methodFor(guidance, assets, template)
  await store.putObject(method.id, jsonBytes(method), 'method')
  const contract = contractFor(method, options.contractRefs ?? bundles)
  const templateRef = await putValue(store, method.templates[0] as unknown as JsonValue, nextId('composition-template'))
  return { contract, method, bundles, guidance, templateRef }
}

function oneSkill(content = '# Bounded work\n\nFollow these steps.') {
  return [{
    id: 'skill:bounded-work',
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    content,
  }]
}

void test('S4-A2 resolves bound skills in template order and matches Composition bundles', async () => {
  await withStore(async store => {
    const a = { id: 'skill:a', name: 'skill-a', description: 'First skill.', content: '# A\n' }
    const b = { id: 'skill:b', name: 'skill-b', description: 'Second skill.', content: '# B\n' }
    const state = await scenario(store, { skills: [a, b] })
    const resources = await loadMethodResources(store, state.contract)
    assert.deepEqual(resources.skills.map(skill => skill.id), ['skill:a', 'skill:b'])
    assert.deepEqual(resources.skills.map(skill => skill.bundle), state.bundles)
    await assertCompositionResources(store, resources, {
      template: state.templateRef,
      guidance: state.guidance,
      skills: state.bundles,
      mcpServers: [],
    })
    await expectCode(
      assertCompositionResources(store, resources, {
        template: state.templateRef,
        guidance: state.guidance,
        skills: [...state.bundles].reverse(),
        mcpServers: [],
      }),
      'COMPOSITION_MISMATCH',
    )
  })
})

void test('S4-A2 resolves template order, not Method catalog order', async () => {
  await withStore(async store => {
    const a = { id: 'skill:a', name: 'skill-a', description: 'First skill.', content: '# A\n' }
    const b = { id: 'skill:b', name: 'skill-b', description: 'Second skill.', content: '# B\n' }
    const state = await scenario(store, {
      skills: [a, b],
      templateSkillIds: ['skill:b', 'skill:a'],
      contractRefs: [],
    })
    // Rebuild with the actual bundle refs in template order.
    const reordered = contractFor(
      state.method,
      [state.bundles[1], state.bundles[0]],
    )
    const resources = await loadMethodResources(store, reordered)
    assert.deepEqual(resources.skills.map(skill => skill.id), ['skill:b', 'skill:a'])
    assert.deepEqual(resources.skills.map(skill => skill.bundle), [state.bundles[1], state.bundles[0]])
  })
})

void test('S4-A2 rejects dangling, duplicate, and invalid skill identities', async () => {
  await withStore(async store => {
    const good = oneSkill()
    const dangling = await scenario(store, { skills: good, templateSkillIds: ['skill:missing'] })
    await expectCode(loadMethodResources(store, dangling.contract), 'CONTRACT_INVALID')

    const duplicateTemplate = await scenario(store, {
      skills: good,
      templateSkillIds: ['skill:bounded-work', 'skill:bounded-work'],
    })
    await expectCode(loadMethodResources(store, duplicateTemplate.contract), 'CONTRACT_INVALID')

    const duplicateName = await scenario(store, {
      skills: [good[0], { ...good[0], id: 'skill:other' }],
    })
    await expectCode(loadMethodResources(store, duplicateName.contract), 'CONTRACT_INVALID')

    const sharedGuidance = await putValue(store, { v: 1, text: 'Frozen skill guidance.' }, nextId('guidance'))
    const sharedBundle = await buildSkillBundle(store, '# Shared\n')
    const sharedMethod = methodFor(sharedGuidance, [
      skillAsset('skill:a', 'skill-a', 'First shared skill.', sharedBundle),
      skillAsset('skill:b', 'skill-b', 'Second shared skill.', sharedBundle),
    ])
    await store.putObject(sharedMethod.id, jsonBytes(sharedMethod), 'method')
    await expectCode(
      loadMethodResources(store, contractFor(sharedMethod, [sharedBundle, sharedBundle])),
      'CONTRACT_INVALID',
    )

    const invalidName = await scenario(store, {
      skills: [{ ...good[0], name: 'Not Kebab' }],
    })
    await expectCode(loadMethodResources(store, invalidName.contract), 'CONTRACT_INVALID')

    const emptyDescription = await scenario(store, {
      skills: [{ ...good[0], description: '' }],
    })
    await expectCode(loadMethodResources(store, emptyDescription.contract), 'CONTRACT_INVALID')

    const whitespaceDescription = await scenario(store, {
      skills: [{ ...good[0], description: '   ' }],
    })
    await expectCode(loadMethodResources(store, whitespaceDescription.contract), 'CONTRACT_INVALID')

    const catalogGuidance = await putValue(store, { v: 1, text: 'Frozen skill guidance.' }, nextId('guidance'))
    const boundBundle = await buildSkillBundle(store, '# Bound\n')
    const invalidNameBundle = await buildSkillBundle(store, '# Invalid\n')
    const invalidNameMethod = methodFor(catalogGuidance, [
      skillAsset('skill:bound', 'bound-skill', 'Bound skill.', boundBundle),
      skillAsset('skill:unbound', 'Not Kebab', 'Unbound invalid name.', invalidNameBundle),
    ], templateFor(catalogGuidance, ['skill:bound']))
    await store.putObject(invalidNameMethod.id, jsonBytes(invalidNameMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(invalidNameMethod, [boundBundle])), 'CONTRACT_INVALID')

    const unboundWhitespaceBundle = await buildSkillBundle(store, '# Whitespace\n')
    const unboundWhitespaceMethod = methodFor(catalogGuidance, [
      skillAsset('skill:bound', 'bound-skill', 'Bound skill.', boundBundle),
      skillAsset('skill:unbound', 'unbound-skill', '   ', unboundWhitespaceBundle),
    ], templateFor(catalogGuidance, ['skill:bound']))
    await store.putObject(unboundWhitespaceMethod.id, jsonBytes(unboundWhitespaceMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(unboundWhitespaceMethod, [boundBundle])), 'CONTRACT_INVALID')

    const duplicateUnboundMethod = methodFor(catalogGuidance, [
      skillAsset('skill:bound', 'bound-skill', 'Bound skill.', boundBundle),
      skillAsset('skill:bound', 'other-skill', 'Duplicate id.', invalidNameBundle),
    ], templateFor(catalogGuidance, ['skill:bound']))
    await store.putObject(duplicateUnboundMethod.id, jsonBytes(duplicateUnboundMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(duplicateUnboundMethod, [boundBundle])), 'CONTRACT_INVALID')
  })
})

void test('S4-A2 rejects contract resource refs that differ from the pinned Method bundles', async () => {
  await withStore(async store => {
    const good = oneSkill()
    const state = await scenario(store, { skills: good })
    const missing = await scenario(store, { skills: good, contractRefs: [] })
    await expectCode(loadMethodResources(store, missing.contract), 'CONTRACT_INVALID')

    const wrongDigest: Ref = { id: state.bundles[0]?.id ?? 'bundle', digest: computeDigest('object', { v: 1 }) }
    const wrong = await scenario(store, { skills: good, contractRefs: [wrongDigest] })
    await expectCode(loadMethodResources(store, wrong.contract), 'CONTRACT_INVALID')

    const extra = await scenario(store, { skills: good, contractRefs: [state.bundles[0], wrongDigest] })
    await expectCode(loadMethodResources(store, extra.contract), 'CONTRACT_INVALID')

    const reordered = await scenario(store, {
      skills: [
        good[0],
        { id: 'skill:b', name: 'skill-b', description: 'Second skill.', content: '# B\n' },
      ],
    })
    const reorderedBundles = reordered.bundles
    const reversedState = await scenario(store, {
      skills: [
        good[0],
        { id: 'skill:b', name: 'skill-b', description: 'Second skill.', content: '# B\n' },
      ],
      contractRefs: [reorderedBundles[1], reorderedBundles[0]],
    })
    await expectCode(loadMethodResources(store, reversedState.contract), 'CONTRACT_INVALID')
  })
})

void test('S4-A2 validates sealed tree bundles, paths, file bytes, and raw/structured digests', async () => {
  await withStore(async store => {
    const good = oneSkill()
    const valid = await scenario(store, { skills: good })
    assert.ok((await loadMethodResources(store, valid.contract)).skills.length === 1)

    const guidance = await putValue(store, { v: 1, text: 'Frozen skill guidance.' }, nextId('guidance'))
    const unsealed = await putTree(store, [{ path: 'SKILL.md', bytes: textEncoder.encode('# A\n') }], { unsealed: true })
    const unsealedMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, unsealed)])
    await store.putObject(unsealedMethod.id, jsonBytes(unsealedMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(unsealedMethod, [unsealed])), 'CONTRACT_INVALID')

    const nonCanonicalManifest = seal('object', {
      v: 1,
      kind: 'tree',
      files: [{
        path: 'SKILL.md',
        bytes: textEncoder.encode('# A\n').byteLength,
        object: await store.putObject(nextId('noncanonical-file'), textEncoder.encode('# A\n'), 'object'),
      }],
    })
    const nonCanonicalBytes = textEncoder.encode(JSON.stringify(nonCanonicalManifest, null, 2))
    const nonCanonicalDigest = computeDigestBytes('object', nonCanonicalBytes)
    const nonCanonical: Ref = { id: 'noncanonical-tree', digest: nonCanonicalDigest }
    await writeFile(join(store.objectsPath, nonCanonicalDigest.slice('sha256:'.length)), nonCanonicalBytes)
    const nonCanonicalMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, nonCanonical)])
    await store.putObject(nonCanonicalMethod.id, jsonBytes(nonCanonicalMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(nonCanonicalMethod, [nonCanonical])), 'CONTRACT_INVALID')

    const unsorted = await putTree(store, [
      { path: 'SKILL.md', bytes: textEncoder.encode('# A\n') },
      { path: 'zzz.txt', bytes: textEncoder.encode('z') },
    ], { reverse: true })
    const unsortedMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, unsorted)])
    await store.putObject(unsortedMethod.id, jsonBytes(unsortedMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(unsortedMethod, [unsorted])), 'CONTRACT_INVALID')

    const traversal = await putTree(store, [{ path: '../SKILL.md', bytes: textEncoder.encode('# A\n') }])
    const traversalMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, traversal)])
    await store.putObject(traversalMethod.id, jsonBytes(traversalMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(traversalMethod, [traversal])), 'CONTRACT_INVALID')

    const badFile = await store.putObject(nextId('bad-bytes-file'), textEncoder.encode('# A\n'), 'object')
    const badBytes = await store.putObject(nextId('bad-bytes'), jsonBytes(seal('object', {
      v: 1,
      kind: 'tree',
      files: [{ path: 'SKILL.md', bytes: 999, object: badFile }],
    })), 'object')
    const badBytesMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, badBytes)])
    await store.putObject(badBytesMethod.id, jsonBytes(badBytesMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(badBytesMethod, [badBytes])), 'CONTRACT_INVALID')

    const tamperFile = await store.putObject(nextId('tamper-file'), textEncoder.encode('# A\n'), 'object')
    const tampered = await store.putObject(nextId('tampered-tree'), jsonBytes(seal('object', {
      v: 1,
      kind: 'tree',
      files: [{
        path: 'SKILL.md',
        bytes: textEncoder.encode('# A\n').byteLength,
        object: tamperFile,
      }],
    })), 'object')
    const tamperedMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, tampered)])
    await store.putObject(tamperedMethod.id, jsonBytes(tamperedMethod), 'method')
    await writeFile(join(store.objectsPath, tamperFile.digest.slice('sha256:'.length)), textEncoder.encode('tampered'))
    await assert.rejects(loadMethodResources(store, contractFor(tamperedMethod, [tampered])), { code: 'OBJECT_CORRUPT' })
  })
})

void test('S4-A2 validates SKILL.md presence, UTF-8, frontmatter, and limits', async () => {
  await withStore(async store => {
    const guidance = await putValue(store, { v: 1, text: 'Frozen skill guidance.' }, nextId('guidance'))

    const missing = await putTree(store, [{ path: 'other.txt', bytes: textEncoder.encode('x') }])
    const missingMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, missing)])
    await store.putObject(missingMethod.id, jsonBytes(missingMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(missingMethod, [missing])), 'CONTRACT_INVALID')

    const empty = await putTree(store, [{ path: 'SKILL.md', bytes: new Uint8Array() }])
    const emptyMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, empty)])
    await store.putObject(emptyMethod.id, jsonBytes(emptyMethod), 'method')
    await expectCode(loadMethodResources(store, contractFor(emptyMethod, [empty])), 'CONTRACT_INVALID')

    const invalidUtf8 = await putTree(store, [{ path: 'SKILL.md', bytes: new Uint8Array([0xff]) }])
    const invalidUtf8Method = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, invalidUtf8)])
    await store.putObject(invalidUtf8Method.id, jsonBytes(invalidUtf8Method), 'method')
    await expectCode(loadMethodResources(store, contractFor(invalidUtf8Method, [invalidUtf8])), 'CONTRACT_INVALID')

    const frontmatterVariants = [
      '---\nname: other\n---\n# A\n',
      '---\r\nname: other\r\n---\r\n# A\r\n',
      '---   \nname: other\n---\n# A\n',
      '---\t\nname: other\n---\n# A\n',
      '--- # frontmatter\nname: other\n---\n# A\n',
      '\uFEFF---\nname: other\n---\n# A\n',
    ]
    for (const content of frontmatterVariants) {
      const frontmatter = await putTree(store, [{
        path: 'SKILL.md',
        bytes: textEncoder.encode(content),
      }])
      const frontmatterMethod = methodFor(guidance, [skillAsset('skill:a', SKILL_NAME, SKILL_DESCRIPTION, frontmatter)])
      await store.putObject(frontmatterMethod.id, jsonBytes(frontmatterMethod), 'method')
      const loaded = await loadMethodResources(store, contractFor(frontmatterMethod, [frontmatter]))
      assert.equal(loaded.skills[0]?.content, content.replace(/^\uFEFF/, ''))
      assert.equal(loaded.skills[0]?.name, SKILL_NAME)
      assert.equal(loaded.skills[0]?.description, SKILL_DESCRIPTION)
    }

    const resultFixed = textEncoder.encode(renderSkillContent({
      name: SKILL_NAME,
      provider: 'runtime',
      resourceBase: RESOURCE_BASE,
      content: '',
    })).byteLength
    const exactContent = 'x'.repeat(16 * 1024 - resultFixed)
    const overContent = `${exactContent}x`
    const exact = await scenario(store, { skills: [{
      id: 'skill:a',
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: exactContent,
    }] })
    const exactSkills = (await loadMethodResources(store, exact.contract)).skills
    assert.equal(exactSkills[0]?.content.length, exactContent.length)
    await expectCode(materializeSkills(exactSkills, '/workspace/.singularity/skills'), 'CONTRACT_INVALID')
    const over = await scenario(store, { skills: [{
      id: 'skill:a',
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: overContent,
    }] })
    await expectCode(loadMethodResources(store, over.contract), 'CONTRACT_INVALID')

    const name = SKILL_NAME
    const fixed = Buffer.byteLength(`- \`${name}\`: \n`)
    const exactDescription = 'x'.repeat(8 * 1024 - fixed)
    const overDescription = `${exactDescription}x`
    const discoveryExact = await scenario(store, { skills: [{
      id: 'skill:a',
      name,
      description: exactDescription,
      content: '# A\n',
    }] })
    await loadMethodResources(store, discoveryExact.contract)
    const discoveryOver = await scenario(store, { skills: [{
      id: 'skill:a',
      name,
      description: overDescription,
      content: '# A\n',
    }] })
    await expectCode(loadMethodResources(store, discoveryOver.contract), 'CONTRACT_INVALID')
  })
})

void test('S4-A2 validates referenced files, ancestor conflicts, and declared-size cap before CAS reads', async () => {
  await withStore(async store => {
    const skill = {
      id: 'skill:a',
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: '# A\n',
      extra: [{ path: 'refs/notes.txt', bytes: textEncoder.encode('S4A2 REFERENCE NOTES') }],
    }
    const state = await scenario(store, { skills: [skill] })
    const resources = await loadMethodResources(store, state.contract)
    assert.equal(textDecoder.decode(resources.skills[0]?.bundleFiles.find(file => file.path === 'refs/notes.txt')?.data), 'S4A2 REFERENCE NOTES')
    const bundleRef = resources.skills[0]?.bundle
    assert.ok(bundleRef)
    const bundle = await readTreeBundle(store, bundleRef, 1024 * 1024)
    assert.equal(
      textDecoder.decode(bundle.contents.get('refs/notes.txt') ?? new Uint8Array()),
      'S4A2 REFERENCE NOTES',
    )

    const notes = bundle.manifest.files.find(file => file.path === 'refs/notes.txt')
    assert.ok(notes)
    await writeFile(join(store.objectsPath, notes.object.digest.slice('sha256:'.length)), textEncoder.encode('tampered'))
    await assert.rejects(loadMethodResources(store, state.contract), { code: 'OBJECT_CORRUPT' })

    const ancestor = await putTree(store, [
      { path: 'a', bytes: textEncoder.encode('file') },
      { path: 'a/b', bytes: textEncoder.encode('child') },
    ])
    await assert.rejects(
      readTreeBundle(store, ancestor, 1024 * 1024),
      error => error instanceof TreeBundleError && /conflict/.test(error.message),
    )

    const missingFile: Ref = { id: 'missing-file', digest: computeDigest('object', { v: 1 }) }
    const oversized = await store.putObject(nextId('oversized-tree'), jsonBytes(seal('object', {
      v: 1,
      kind: 'tree',
      files: [{ path: 'SKILL.md', bytes: 2 * 1024 * 1024, object: missingFile }],
    })), 'object')
    await assert.rejects(
      readTreeBundle(store, oversized, 1024 * 1024),
      error => error instanceof TreeBundleError && /declares.*cap/.test(error.message),
    )
  })
})
