import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sealTaskContract, validateSubmissionManifest } from '@singularity/protocol'
import type { OutputSpec, TaskContract } from '@singularity/protocol'

import { DomainStore } from '../src/store.ts'
import {
  SubmissionError,
  freezeSubmission,
  prepareWorkspace,
} from '../src/workspace.ts'

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

function output(
  id: string,
  path: string,
  kind: 'file' | 'tree',
  role: OutputSpec['role'],
  required: boolean,
): OutputSpec {
  return { id, path, kind, role, required }
}

function contract(outputs: readonly OutputSpec[]): TaskContract {
  return sealTaskContract({
    v: 1,
    taskId: 'task-submit',
    spec: {
      goal: {
        summary: 'freeze outputs',
        deliverable: 'files and a tree',
        scope: [],
        constraints: [],
      },
      criteria: [],
      inputs: [],
      outputs: [...outputs],
    },
    origin: { kind: 'root', purpose: 'work', requestRef: { id: 'request', digest: digestA } },
    method: { id: 'method', digest: digestB },
    template: { id: 'template', digest: digestB },
    resources: { baseTools: [], skills: [], mcpServers: [] },
    acceptance: { id: 'acceptance', digest: digestA },
    environment: {
      seed: { id: 'seed', digest: digestA },
      profile: { id: 'profile', digest: digestB },
    },
    limits: {
      maxRuns: 1,
      maxStepsPerRun: 10,
      maxTokens: 1000,
      deadlineAt: 10_000,
      maxDepth: 1,
      maxTasks: 1,
      maxBatchChildren: 1,
    },
  })
}

async function withStore<T>(operation: (store: DomainStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'singularity-freeze-store-'))
  const store = await DomainStore.open({ root })
  try {
    return await operation(store)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function withWorkspace<T>(operation: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), 'singularity-freeze-work-'))
  try {
    return await operation(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

void test('freezes files, trees, drafts, checks, and a strict manifest in CAS', async () => {
  await withStore(async store => {
    await withWorkspace(async workspace => {
      await writeFile(join(workspace, 'result.txt'), 'result-bytes')
      await mkdir(join(workspace, 'artifacts', 'nested'), { recursive: true })
      await writeFile(join(workspace, 'artifacts', 'a.txt'), 'alpha')
      await writeFile(join(workspace, 'artifacts', 'nested', 'b.txt'), 'beta')
      await mkdir(join(workspace, 'learning-drafts', 'skills'), { recursive: true })
      await writeFile(join(workspace, 'learning-drafts', 'skills', 'SKILL.md'), '# skill')
      await mkdir(join(workspace, 'learning-drafts', 'mcp-servers'), { recursive: true })
      await writeFile(join(workspace, 'learning-drafts', 'mcp-servers', 'manifest.json'), '{}')

      const frozenContract = contract([
        output('out-file', 'result.txt', 'file', 'deliverable', true),
        output('out-tree', 'artifacts', 'tree', 'supporting', false),
        output('__skill-drafts', 'learning-drafts/skills', 'tree', 'skill-draft', false),
        output('__mcp-drafts', 'learning-drafts/mcp-servers', 'tree', 'mcp-draft', false),
      ])
      const frozen = await freezeSubmission({
        contract: frozenContract,
        runId: 'run-submit',
        workspace,
        outputIds: ['out-file', 'out-tree'],
        includeLearningDrafts: true,
        maxOutputBytes: 1024,
        writer: store,
      })

      assert.deepEqual(frozen.manifest.outputs.map(item => item.id), ['out-file', 'out-tree'])
      assert.deepEqual(frozen.manifest.learningDrafts.map(item => item.id), [
        '__skill-drafts',
        '__mcp-drafts',
      ])
      assert.deepEqual(frozen.manifest.checks.map(check => check.outputId), [
        'out-file',
        'out-tree',
        '__skill-drafts',
        '__mcp-drafts',
      ])
      assert.equal(frozen.outputRefs.length, 4)
      for (const ref of frozen.outputRefs) {
        const { bytes } = await store.readObject(ref, 'object')
        assert.ok(bytes.byteLength > 0)
      }

      const validation = validateSubmissionManifest(frozen.manifest, {
        contract: frozenContract,
        runId: 'run-submit',
      })
      assert.equal(validation.valid, true)

      const again = await freezeSubmission({
        contract: frozenContract,
        runId: 'run-submit',
        workspace,
        outputIds: ['out-file', 'out-tree'],
        includeLearningDrafts: true,
        maxOutputBytes: 1024,
        writer: store,
      })
      assert.equal(again.manifest.digest, frozen.manifest.digest)
      assert.equal(again.manifestRef.digest, frozen.manifestRef.digest)
    })
  })
})

void test('optional outputs may be absent and drafts stay empty when disabled', async () => {
  await withStore(async store => {
    await withWorkspace(async workspace => {
      await writeFile(join(workspace, 'required.txt'), 'required')
      await mkdir(join(workspace, 'learning-drafts', 'skills'), { recursive: true })
      await writeFile(join(workspace, 'learning-drafts', 'skills', 'SKILL.md'), '# skill')
      const frozenContract = contract([
        output('required', 'required.txt', 'file', 'deliverable', true),
        output('optional', 'missing.txt', 'file', 'supporting', false),
      ])
      const frozen = await freezeSubmission({
        contract: frozenContract,
        runId: 'run-optional',
        workspace,
        outputIds: ['required', 'optional'],
        includeLearningDrafts: false,
        maxOutputBytes: 1024,
        writer: store,
      })
      assert.equal(frozen.manifest.outputs[1]?.object, undefined)
      assert.deepEqual(frozen.manifest.learningDrafts, [])
      assert.equal(frozen.manifest.checks.length, 1)
    })
  })
})

void test('rejects symlinks, traversal, missing required outputs, and size overflow', async () => {
  await withStore(async store => {
    await withWorkspace(async workspace => {
      await writeFile(join(workspace, 'target.txt'), 'target')
      await symlink('target.txt', join(workspace, 'link.txt'))
      const symlinkContract = contract([output('link', 'link.txt', 'file', 'deliverable', true)])
      await assert.rejects(
        freezeSubmission({
          contract: symlinkContract,
          runId: 'run-link',
          workspace,
          outputIds: ['link'],
          includeLearningDrafts: false,
          maxOutputBytes: 1024,
          writer: store,
        }),
        (error: unknown) => error instanceof SubmissionError && error.code === 'OUTPUT_SYMLINK',
      )

      const traversalContract = contract([output('bad', '../escape.txt', 'file', 'deliverable', true)])
      await assert.rejects(
        freezeSubmission({
          contract: traversalContract,
          runId: 'run-traversal',
          workspace,
          outputIds: ['bad'],
          includeLearningDrafts: false,
          maxOutputBytes: 1024,
          writer: store,
        }),
        (error: unknown) => error instanceof SubmissionError && error.code === 'OUTPUT_PATH_INVALID',
      )

      const missingContract = contract([output('missing', 'missing.txt', 'file', 'deliverable', true)])
      await assert.rejects(
        freezeSubmission({
          contract: missingContract,
          runId: 'run-missing',
          workspace,
          outputIds: ['missing'],
          includeLearningDrafts: false,
          maxOutputBytes: 1024,
          writer: store,
        }),
        (error: unknown) => error instanceof SubmissionError && error.code === 'OUTPUT_MISSING',
      )

      await writeFile(join(workspace, 'large.txt'), 'x'.repeat(32))
      const largeContract = contract([output('large', 'large.txt', 'file', 'deliverable', true)])
      await assert.rejects(
        freezeSubmission({
          contract: largeContract,
          runId: 'run-large',
          workspace,
          outputIds: ['large'],
          includeLearningDrafts: false,
          maxOutputBytes: 8,
          writer: store,
        }),
        (error: unknown) => error instanceof SubmissionError && error.code === 'OUTPUT_TOO_LARGE',
      )
    })
  })
})

void test('tree traversal rejects a symlinked node without freezing it', async () => {
  await withStore(async store => {
    await withWorkspace(async workspace => {
      await mkdir(join(workspace, 'tree'), { recursive: true })
      await writeFile(join(workspace, 'tree', 'file.txt'), 'file')
      await symlink('file.txt', join(workspace, 'tree', 'link.txt'))
      const treeContract = contract([output('tree', 'tree', 'tree', 'deliverable', true)])
      await assert.rejects(
        freezeSubmission({
          contract: treeContract,
          runId: 'run-tree-link',
          workspace,
          outputIds: ['tree'],
          includeLearningDrafts: false,
          maxOutputBytes: 1024,
          writer: store,
        }),
        (error: unknown) => error instanceof SubmissionError && error.code === 'OUTPUT_SYMLINK',
      )
    })
  })
})

for (const kind of ['file', 'tree', 'draft'] as const) {
  void test(`rejects a symlinked ancestor of a ${kind} output`, async () => {
    await withStore(async store => {
      await withWorkspace(async workspace => {
        await withWorkspace(async outside => {
          const draft = kind === 'draft'
          const ancestor = draft ? 'learning-drafts' : 'linked'
          await writeFile(join(outside, 'result.txt'), 'outside-file')
          await mkdir(join(outside, 'tree'))
          await writeFile(join(outside, 'tree', 'result.txt'), 'outside-tree')
          await mkdir(join(outside, 'skills'))
          await writeFile(join(outside, 'skills', 'SKILL.md'), '# outside')
          await symlink(outside, join(workspace, ancestor))
          const outputs = draft
            ? [output('__skill-drafts', 'learning-drafts/skills', 'tree', 'skill-draft', false)]
            : [output('out', `linked/${kind === 'file' ? 'result.txt' : 'tree'}`, kind, 'deliverable', true)]
          await assert.rejects(
            freezeSubmission({
              contract: contract(outputs),
              runId: `run-ancestor-link-${kind}`,
              workspace,
              outputIds: draft ? [] : ['out'],
              includeLearningDrafts: draft,
              maxOutputBytes: 1024,
              writer: store,
            }),
            (error: unknown) => error instanceof SubmissionError && error.code === 'OUTPUT_SYMLINK',
          )
        })
      })
    })
  })
}

void test('prepareWorkspace copies only copy-to-work inputs from CAS', async () => {
  await withStore(async store => {
    await withWorkspace(async workspace => {
      const copied = await store.putObject('input-copy', new TextEncoder().encode('copy-me'), 'object')
      const readOnly = await store.putObject('input-read', new TextEncoder().encode('read-only'), 'object')
      const root = await prepareWorkspace(workspace, [
        { id: 'copy', object: copied, path: 'inputs/copied.txt', access: 'copy-to-work' },
        { id: 'read', object: readOnly, path: 'inputs/read.txt', access: 'read' },
      ], store)
      assert.equal(root, workspace)
      const bytes = await readFile(join(workspace, 'inputs/copied.txt'))
      assert.equal(bytes.toString(), 'copy-me')
      await assert.rejects(readFile(join(workspace, 'inputs/read.txt')))
    })
  })
})
