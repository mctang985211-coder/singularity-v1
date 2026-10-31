import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalize, sealMethodRevision } from '@singularity/protocol'
import type { FactPayloadMap, FactType, JsonValue } from '@singularity/protocol'

import { CommandService } from '../src/service.ts'

const actor = { kind: 'operator', id: 'round-test' } as const

void test('the shared writer serializes expected-head CAS and replay preserves the winning head', async t => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-round-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = await CommandService.open({ root, actor, clock: () => 1000 })
  t.after(() => service.close())
  const commit = <Type extends FactType>(type: Type, data: FactPayloadMap[Type], id: string) => service.commit({
    command: { v: 1, commandId: id, actor, tool: 'round-fixture', toolVersion: 1, scope: {}, input: data as JsonValue },
    type, data,
  }, [])
  const refs = []
  for (const id of ['base', 'candidate-a', 'candidate-b']) {
    const method = sealMethodRevision({ v: 1, id, templates: [], skills: [], tools: [] })
    const ref = await service.putObject(id, new TextEncoder().encode(canonicalize(method)), 'method')
    refs.push(ref)
    await commit('method/registered', { revision: ref }, `register:${id}`)
  }
  const [base, candidateA, candidateB] = refs
  const approval = await service.putObject('approval', new TextEncoder().encode('{}'))
  await commit('method/activated', { next: base, approval }, 'initial')
  const competing = await Promise.allSettled([candidateA, candidateB].map((next, index) => commit('method/activated', {
    expectedPrevious: base, previous: base, next, approval,
  }, `activation:${String(index)}`)))
  assert.deepEqual(competing.map(result => result.status), ['fulfilled', 'rejected'])
  assert.match(String(competing[1]?.status === 'rejected' ? competing[1].reason : ''), /expected head/)
  assert.deepEqual((await service.methodRoundState()).productionHead, candidateA)
  await service.close()
  const replay = await CommandService.open({ root, actor, clock: () => 1001 })
  t.after(() => replay.close())
  assert.deepEqual((await replay.methodRoundState()).productionHead, candidateA)
})
