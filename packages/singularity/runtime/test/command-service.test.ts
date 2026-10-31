import type { UnsealedFact } from '@singularity/protocol'
import { canonicalize,computeDigestBytes,computeCommandDigest,sealMethodRevision,verifyFact } from '@singularity/protocol'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { access,mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import test from 'node:test'
import { promisify } from 'node:util'
import { CommandService } from '../src/service.ts'
import { CAS_DIGEST_DOMAINS,DomainStore } from '../src/store.ts'

const actor = { kind: 'operator', id: 'storage-test' } as const
const encoder = new TextEncoder()
const runNode = promisify(execFile)

async function root(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'singularity-sqlite-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
async function writer(t: TestContext, path: string) {
  const service = await CommandService.open({ root: path, actor, clock: () => 1 })
  t.after(() => service.close())
  return service
}
async function registration(service: CommandService, id: string) {
  const method = sealMethodRevision({ v: 1, id, templates: [], skills: [], tools: [] })
  const revision = await service.putObject(id, encoder.encode(canonicalize(method)), 'method')
  return { command: { v: 1, commandId: `register:${id}`, tool: 'register', toolVersion: 1,
    actor, scope: {}, input: { revision } }, type: 'method/registered', data: { revision } } as const
}

void test('mandatory state guard rejects an illegal event before commit, without an optional policy argument', async t => {
  const service = await writer(t, await root(t))
  await assert.rejects(service.commit({
    command: { v: 1, commandId: 'illegal', tool: 'host', toolVersion: 1, actor, scope: {}, input: {} },
    type: 'rsi/round-closed', data: { roundId: 'never-opened', outcome: 'cancelled' },
  }), /Round|round/)
  assert.equal(service.facts().length, 0)
  const fact = await service.commit(await registration(service, 'first'))
  assert.equal(fact.seq, 0)
  assert.equal((await service.domainState()).methods.size, 1)
})

void test('same command is idempotent; changed payload conflicts without a second event', async t => {
  const service = await writer(t, await root(t))
  const command = await registration(service, 'one')
  const first = await service.commit(command)
  assert.deepEqual(await service.commit(command), first)
  await assert.rejects(service.commit({ ...command, command: { ...command.command, input: { changed: true } } }),
    { code: 'IDEMPOTENCY_CONFLICT' })
  assert.equal(service.facts().length, 1)
})

void test('concurrent commands serialize and queries reuse the committed domain projection', async t => {
  const service = await writer(t, await root(t))
  const commands = await Promise.all(Array.from({ length: 20 }, (_, i) => registration(service, `m${String(i)}`)))
  const facts = await Promise.all(commands.map(command => service.commit(command)))
  for (let index = 0; index < facts.length; index += 1) {
    assert.equal(facts[index].seq, index)
    assert.equal(facts[index].prev, facts[index - 1]?.digest ?? null)
    assert.equal(verifyFact(facts[index]), true)
  }
  const state = await service.domainState()
  assert.equal(state.methods.size, 20)
  assert.strictEqual(await service.taskRunState(), state)
  assert.strictEqual(await service.methodRoundState(), state)
})

void test('SQLite rolls back when the business guard fails and enforces command uniqueness', async t => {
  const store = await DomainStore.open(await root(t))
  t.after(() => store.close())
  const command = { v: 1, commandId: 'c', tool: 'test', toolVersion: 1, actor, scope: {}, input: {} } as const
  const event: UnsealedFact = { v: 1, seq: 0, prev: null, commandId: command.commandId,
    commandDigest: computeCommandDigest(command), actor, at: 1, type: 'rsi/round-closed',
    data: { roundId: 'round', outcome: 'cancelled' } }
  const failure = new Error('guard refused')
  await assert.rejects(store.appendFact(event, () => Promise.reject(failure)), error => error === failure)
  assert.deepEqual(await store.replay(), [])
  const first = await store.appendFact(event, () => Promise.resolve())
  await assert.rejects(store.appendFact({ ...event, seq: 1, prev: first.digest }, () => Promise.resolve()), /UNIQUE/)
  assert.deepEqual(await store.replay(), [first])
})

void test('a second live writer is refused; a closed writer can be replaced only in the same process', async t => {
  const path = await root(t)
  const service = await writer(t, path)
  await assert.rejects(CommandService.open({ root: join(path, '.'), actor, clock: () => 1 }), { code: 'WRITER_ALREADY_OPEN' })
  await service.commit(await registration(service, 'archive-method'))
  await service.close()
  const next = await writer(t, path)
  assert.equal((await next.domainState()).methods.size, 1)
  await next.close()
  const script = `import { CommandService } from './src/service.ts';
    try { await CommandService.open({root: ${JSON.stringify(path)}, actor: {kind:'operator',id:'next-process'},clock:()=>1}); process.exit(2) }
    catch(error) { if(error.code !== 'ARCHIVE_READ_ONLY') throw error; }`
  await runNode(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: {} })
  const archive = await DomainStore.open(path)
  t.after(() => archive.close())
  assert.equal(archive.facts().length, 1)
})

void test('an exited process leaves only archived facts; fresh work uses another root', async t => {
  const path = await root(t)
  const script = `import { CommandService } from './src/service.ts';
    await CommandService.open({root: ${JSON.stringify(path)},actor:{kind:'operator',id:'exited'},clock:()=>1});
    process.exit(7)`
  await assert.rejects(runNode(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: {} }), { code: 7 })
  await assert.rejects(CommandService.open({ root: path, actor, clock: () => 1 }), { code: 'ARCHIVE_READ_ONLY' })
  const archive = await DomainStore.open(path)
  t.after(() => archive.close())
  assert.deepEqual(archive.facts(), [])
  const fresh = await writer(t, await root(t))
  assert.equal((await fresh.commit(await registration(fresh, 'fresh'))).seq, 0)
})

void test('CAS preserves domain-separated and structured identities; read errors remain host errors', async t => {
  const store = await DomainStore.open(await root(t))
  t.after(() => store.close())
  for (const domain of CAS_DIGEST_DOMAINS) {
    const bytes = encoder.encode(`asset ${domain}`)
    const ref = await store.putObject(`asset:${domain}`, bytes, domain)
    assert.deepEqual((await store.readObject(ref, domain)).bytes, bytes)
    assert.deepEqual(await store.putObject(ref.id, bytes, domain), ref)
    await assert.rejects(store.readObject(ref, domain === 'object' ? 'method' : 'object'), { code: 'OBJECT_DOMAIN_MISMATCH' })
  }
  const method = sealMethodRevision({ v: 1, id: 'sealed', templates: [], skills: [], tools: [] })
  const ref = await store.putObject(method.id, encoder.encode(canonicalize(method)), 'method')
  assert.equal(ref.digest, method.digest)
  await writeFile(store.objectPath(ref.digest), 'corrupt')
  await assert.rejects(store.readObject(ref, 'method'), { code: 'OBJECT_CORRUPT' })
  await assert.rejects(store.readObject({ id: 'absent', digest: `sha256:${'f'.repeat(64)}` }), { code: 'OBJECT_MISSING' })
})

void test('duplicate concurrent CAS puts share the writer queue and never expose a partial object', async t => {
  const store = await DomainStore.open(await root(t))
  t.after(() => store.close())
  const bytes = new Uint8Array(2 * 1024 * 1024).fill(91)
  const refs = await Promise.all(Array.from({ length: 8 }, (_, index) => store.putObject(`asset:${String(index)}`, bytes)))
  assert.equal(new Set(refs.map(ref => ref.digest)).size, 1)
  assert.deepEqual((await store.readObject(refs[0])).bytes, bytes)
})

void test('an archive cannot be mutated through the lower-level CAS writer', async t => {
  const path = await root(t)
  const script = `import { DomainStore } from './src/store.ts';
    const store = await DomainStore.open(${JSON.stringify(path)});
    await store.putObject('old', new TextEncoder().encode('archived')); await store.close()`
  await runNode(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env: {} })
  const archive = await DomainStore.open(path)
  t.after(() => archive.close())
  await assert.rejects(archive.putObject('new', encoder.encode('new bytes')), { code: 'ARCHIVE_READ_ONLY' })
})

void test('legacy NDJSON roots are refused before a parallel SQLite history can be created', async t => {
  const path = await root(t)
  await writeFile(join(path, 'journal.ndjson'), 'historical archive')
  await assert.rejects(DomainStore.open(path), { code: 'ARCHIVE_READ_ONLY' })
  await assert.rejects(access(join(path, 'domain.sqlite')), { code: 'ENOENT' })
})

void test('CAS final filenames become visible only with complete bytes to independent readers', { timeout: 10_000 }, async t => {
  const store = await DomainStore.open(await root(t))
  t.after(() => store.close())
  const bytes = new Uint8Array(32 * 1024 * 1024).fill(73)
  const ref = { id: 'published', digest: computeDigestBytes('object', bytes) }
  const observed = new Promise<void>((resolve, reject) => {
    const watcher = watch(store.objectsPath, (_event, name) => {
      if (String(name) !== ref.digest.slice(7)) return
      watcher.close()
      store.readObject(ref).then(result => {
        assert.deepEqual(result.bytes, bytes)
        resolve()
      }).catch(reject)
    })
    t.after(() => { watcher.close() })
  })
  await Promise.all([store.putObject(ref.id, bytes), observed])
})

void test('the method consumer rejects a missing CAS ref without committing a fact', async t => {
  const service = await writer(t, await root(t))
  const revision = { id: 'missing-method', digest: `sha256:${'f'.repeat(64)}` }
  await assert.rejects(service.commit({
    command: { v: 1, commandId: 'missing-ref', tool: 'host', toolVersion: 1, actor, scope: {}, input: { revision } },
    type: 'method/registered', data: { revision },
  }), { code: 'OBJECT_MISSING' })
  assert.equal(service.facts().length, 0)
  assert.equal((await service.commit(await registration(service, 'present-method'))).seq, 0)
})
