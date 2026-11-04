import assert from 'node:assert/strict'
import { access,readFile,rm,writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import test from 'node:test'

import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

import type { ExecutionRecord,InputRef,Ref,TaskContract } from '@singularity/protocol'
import {
computeDigest,
executionRecordSchema,
parseProtocolValue,
sealPublicReceipt,
submissionManifestSchema
} from '@singularity/protocol'
import {
CommandService,
DomainStore,
executeSingleRun,
executeTaskTree,
retrySingleRun
} from '@singularity/runtime'

import { buildSingleRunComposition } from '../src/host-composition.ts'
import type { bootSpikeProfile } from '../src/host-composition.ts'
import type { VerifierRequest } from '@singularity/runtime'
import type { ChatCompletionsFixture } from './fixtures/chat-completions.ts'
import { contextEpochFrom,messageTexts,toolSchemaNames } from './fixtures/chat-completions.ts'

import { previewDigestFrom,s4b2Example } from './method-fixture.ts'
import {
planReply,
assertSecretNotPersisted,
captureAgentContexts,
currentComposition,
factsOfType,
passingVerifier,
readFacts,
readJson,
recordSessionEvents,
requireLiveEnv,
selfReadAndPlan,
sequenceOf,
submitReply,
toolCallNames,
userMessageIds,
withHarness,
withLiveHarness,
writeOutputReply
} from './run-fixture.ts'
import type { ReplyScript,Scenario } from './task-fixture.ts'
import {
FROZEN_OUTPUT,
LIVE,
LIVE_TIMEOUT_MS,
OUTPUT_PATH,
agentOptions,
fixtureUsage,
makeScenario,
textDecoder
} from './task-fixture.ts'

void test('fresh retry starts attempt 2 with a new session and workspace and keeps both fact chains', { timeout: 240_000 }, async () => {
  const taskId = `task-s3c-retry-${String(process.pid)}-${String(Date.now())}`
  const firstRunId = `${taskId}-run-1`
  const firstSessionId = `${taskId}-session-1`
  const secondRunId = `${taskId}-run-2`
  const secondSessionId = `${taskId}-session-2`
  let scenario: Scenario | undefined
  let secondWorkspace = ''
  let now = Date.now()

  const fixtureScript: ReplyScript = (request, index) => {
    if (index === 0) {
      return { content: 'The first attempt ends without submitting.', usage: { promptTokens: 199_992, completionTokens: 8, totalTokens: 200_000, cachedTokens: 0 } }
    }
    if (index === 1) {
      const reply = selfReadAndPlan(request, 0, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 2) {
      const reply = selfReadAndPlan(request, 1, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 3) return writeOutputReply()
    if (index === 4) return submitReply()
    return { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }

  await withHarness(fixtureScript, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 2, deadlineAt: now + 10 * 60_000 })
    const active = scenario

    const first = await executeSingleRun({
      ctx: spike.ctx,
      journalRoot: storeRoot,
      workspace,
      sessionId: firstSessionId,
      runId: firstRunId,
      admission: active.runAdmission,
      composition: await currentComposition(spike.ctx, storeRoot, active),
      agentOptions: agentOptions(),
      maxOutputBytes: 1024 * 1024,
      verifier: {
        provider: active.provider,
        verify() {
          throw new Error('the first attempt must not invoke the verifier')
        },
      },
      transientInvalidReasons: [],
      clock: () => now,
    })
    assert.ok(first.kind === 'settled')
    assert.equal(first.classification, 'failed')
    assert.equal(first.retry.allowed, true, 'maxRuns=2 must leave the Task open for retry')
    assert.ok(first.executionRecordRef)
    await assert.rejects(access(join(workspace, OUTPUT_PATH)), 'the first attempt wrote no output')

    const factsAfterFirst = await readFacts(storeRoot)
    assert.deepEqual(sequenceOf(factsAfterFirst), ['task/admitted', 'run/opened', 'run/closed'])
    const firstOpened = factsOfType(factsAfterFirst, 'run/opened')[0]
    assert.ok(firstOpened)
    const firstOpenedDigest = firstOpened.digest
    const firstCompositionDigest = firstOpened.data.composition.digest
    const firstClosed = factsOfType(factsAfterFirst, 'run/closed')[0]
    assert.ok(firstClosed)
    assert.equal(firstClosed.data.classification, 'failed')
    const firstClosedDigest = firstClosed.digest
    const firstRecordRef = 'executionRecordRef' in firstClosed.data
      ? firstClosed.data.executionRecordRef
      : undefined
    assert.ok(firstRecordRef)
    const firstRecordStore = await DomainStore.open({ root: storeRoot })
    let firstRecord: ExecutionRecord
    try {
      firstRecord = parseProtocolValue(
        executionRecordSchema,
        await readJson(firstRecordStore, firstRecordRef, 'object'),
      )
    } finally {
      await firstRecordStore.close()
    }

    secondWorkspace = join(storeRoot, 'retry-workspace')
    now += 5 * 60_000
    const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
    try {
      const second = await retrySingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        previousRunId: firstRunId,
        runId: secondRunId,
        sessionId: secondSessionId,
        workspace: secondWorkspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(active, secondRunId, secondWorkspace, verifierCalls),
        transientInvalidReasons: [],
        clock: () => now,
      })
      assert.ok(second.kind === 'settled')
      const retryWire = messageTexts(fixture.requests[1] ?? {}).join('\n')
      assert.ok(retryWire.includes('"tokensPct":80'), 'the retry starts with 80% of the original Task token quota')
      assert.ok(retryWire.includes('"wallClockPct":50'), 'the retry retains the Task time origin')
      assert.ok(retryWire.includes('Remaining percentages: tokens=80%, steps=100%, wall-clock=50%, task-slots=0%.'), 'the start wake uses the same cumulative budget as NodeView')
      const afterSelf = messageTexts(fixture.requests[2] ?? {}).join('\n')
      assert.ok(afterSelf.includes('"tokensPct":79'), 'the self result includes prior usage and this attempt usage')
      assert.ok(afterSelf.includes('"wallClockPct":50'))

      assert.equal(second.previousRunId, firstRunId)
      assert.equal(second.attempt, 2)
      assert.equal(second.retryPolicy.allowed, true)
      assert.equal(second.runId, secondRunId)
      assert.notEqual(second.runId, firstRunId)
      assert.equal(second.sessionId, secondSessionId)
      assert.notEqual(second.sessionId, firstSessionId)
      assert.equal(second.classification, 'verified')
      assert.equal(verifierCalls.length, 1)
      assert.equal(second.receipt?.operationId, `${secondRunId}:verify`)
      assert.equal(first.executionRecord?.digest, firstRecord.digest)
      assert.equal(first.receipt, undefined)
      assert.equal(second.executionRecord, undefined, 'a verified retry must not reuse the old record')
      assert.notEqual(second.evidenceRef?.digest, firstRecord.digest)
      assert.equal(
        await readFile(join(secondWorkspace, OUTPUT_PATH), 'utf8'),
        'mutated-after-submit\n',
        'the verifier ran against the new attempt workspace after freezing CAS',
      )
      await assert.rejects(access(join(workspace, OUTPUT_PATH)), 'the old workspace remains untouched')

      const facts = await readFacts(storeRoot)
      assert.deepEqual(sequenceOf(facts), [
        'task/admitted',
        'run/opened',
        'run/closed',
        'run/opened',
        'run/submitted',
        'run/closed',
        'task/closed',
      ])
      const opened = factsOfType(facts, 'run/opened')
      assert.deepEqual(opened.map(fact => fact.data.attempt), [1, 2])
      assert.deepEqual(opened.map(fact => fact.data.runId), [firstRunId, secondRunId])
      assert.deepEqual(opened.map(fact => fact.data.sessionId), [firstSessionId, secondSessionId])
      assert.deepEqual(opened.map(fact => fact.data.workspaceKey), [firstRunId, secondRunId])
      assert.equal(opened[0].digest, firstOpenedDigest, 'the first run/opened fact is preserved')
      assert.equal(opened[0].data.composition.digest, firstCompositionDigest)
      assert.equal(opened[1].data.composition.digest, firstCompositionDigest)
      assert.notEqual(
        opened[0].data.composition.id,
        opened[1].data.composition.id,
        'the retry stores its own composition object while the content stays identical',
      )

      const closed = factsOfType(facts, 'run/closed')
      assert.equal(closed[0]?.digest, firstClosedDigest, 'the first closure must be preserved unchanged')
      assert.equal(closed[0]?.data.classification, 'failed')
      assert.equal(closed[1]?.data.classification, 'verified')
      const secondClosed = closed[1]
      assert.ok(secondClosed)
      assert.equal('evidenceRef' in secondClosed.data, true)
      assert.equal('executionRecordRef' in firstClosed.data, true)

      const submitted = factsOfType(facts, 'run/submitted')
      assert.equal(submitted.length, 1)
      assert.equal(submitted[0]?.data.runId, secondRunId)
      const manifestRef = submitted[0]?.data.outputs
      assert.ok(manifestRef)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const manifest = parseProtocolValue(
          submissionManifestSchema,
          await readJson(store, manifestRef, 'object'),
        )
        assert.equal(manifest.runId, secondRunId)
        assert.equal(manifest.digest, manifestRef.digest)
        const outputRef = manifest.outputs[0]?.object
        assert.ok(outputRef)
        const { bytes } = await store.readObject(outputRef, 'object')
        assert.equal(textDecoder.decode(bytes), FROZEN_OUTPUT)
        const firstRecordAfter = parseProtocolValue(
          executionRecordSchema,
          await readJson(store, firstRecordRef, 'object'),
        )
        assert.equal(firstRecordAfter.digest, firstRecord.digest)
        assert.equal(second.manifestRef?.digest, manifestRef.digest)
        const secondEvidence = second.evidence
        assert.ok(secondEvidence)
        assert.equal(secondEvidence.runId, secondRunId)
        assert.equal(secondEvidence.verification.operationId, `${secondRunId}:verify`)
      } finally {
        await store.close()
      }

      const taskClosed = factsOfType(facts, 'task/closed')
      assert.equal(taskClosed.length, 1)
      assert.equal(taskClosed[0]?.data.outcome, 'verified')
      assert.equal(taskClosed[0]?.data.decisiveRunId, secondRunId)

      assert.equal(fixture.requests.length, 5, 'attempt 1 buys one request; attempt 2 buys four')
      assert.equal(
        (fixture.requests[0]?.messages ?? []).some(message => (message.tool_calls ?? []).length > 0),
        false,
        'the no-submission attempt must end with a plain text turn',
      )
      assert.ok(
        toolSchemaNames(fixture.requests[1] ?? {}).includes('singularity_submit'),
        'the retry attempt exposes the Task tools',
      )
    } finally {
      await rm(secondWorkspace, { recursive: true, force: true })
    }
  })
})

void test('retry passes an unchanged evidence InputRef to a fresh child and integrates its result', { timeout: 240_000 }, async () => {
  const taskId = `retry-findings-${String(process.pid)}-${String(Date.now())}`
  const firstRunId = `${taskId}:run:1`, secondRunId = `${taskId}:run:2`
  const reason = 'The boundary case is missing; repair the frozen result through a new child.'
  const previousPath = `attempts/${encodeURIComponent(firstRunId)}/result`
  let scenario: Scenario | undefined, child: TaskContract | undefined, childRunId = '', retryWorkspace = ''
  let previous: InputRef | undefined
  await withHarness((request, index) => {
    assert.ok(scenario)
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `retry-${String(index)}`, name, arguments: JSON.stringify(args) }], usage: fixtureUsage(index) })
    if ([0, 4, 9, 14].includes(index)) return call('singularity_read', { kind: 'self' })
    if ([1, 5, 10, 15].includes(index)) {
      const contract = index === 10 ? child : scenario.contract
      assert.ok(contract)
      return planReply({ ...scenario, contract }, contract.taskId, index === 10 ? childRunId : index === 1 ? firstRunId : secondRunId,
        contextEpochFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }) ?? '')
    }
    if (index === 2) return writeOutputReply()
    if (index === 3 || index === 18) return submitReply()
    if (index === 6) return call('singularity_read', { kind: 'evidence', id: firstRunId })
    if (index === 7) {
      const wire = messageTexts(request)
      const response = wire.map(text => { try { return JSON.parse(text) as { data?: string } } catch { return {} } })
        .find(value => typeof value.data === 'string' && value.data.includes('publicReceipt'))
      assert.ok(response?.data)
      const evidence = JSON.parse(response.data) as { outputs: InputRef[]; publicReceipt: { criteria: { reason: string }[] } }
      assert.equal(evidence.publicReceipt.criteria[0].reason, reason)
      previous = evidence.outputs[0]
      assert.equal(previous.path, previousPath)
      return call('singularity_decompose', { action: 'prepare', bindingId: 'repair' })
    }
    if (index === 8) return call('singularity_decompose', { action: 'commit', children: [{ bindingId: 'repair',
      ackPreview: previewDigestFrom({ ...request, messages: [...(request.messages ?? [])].reverse() }), task: {
        goal: { summary: 'Consume the previous frozen result and return exact bytes.', deliverable: 'child.txt', scope: [], constraints: [] }, inputs: [previous],
        acceptanceCriteria: [{ id: 'copy', statement: 'Preserve frozen bytes.', check: `test "$(cat child.txt)" = '${FROZEN_OUTPUT}'` }],
        localOutputs: [{ id: 'copy', path: 'child.txt', kind: 'file', description: 'Repaired result.' }],
      } }] })
    if (index === 11) return call('singularity_read', { kind: 'resource', id: previous?.id })
    if (index === 12) {
      assert.ok(messageTexts(request).some(text => text.includes(FROZEN_OUTPUT)))
      return call('bash', { command: `printf %s '${FROZEN_OUTPUT}' > child.txt` })
    }
    if (index === 13) return call('singularity_submit', { outputIds: ['copy'], includeLearningDrafts: false })
    if (index === 16) return call('singularity_read', { kind: 'children' })
    assert.equal(index, 17)
    assert.ok(child)
    return call('bash', { command: `cat 'children/${encodeURIComponent(child.taskId)}/copy' > result.txt` })
  }, async ({ spike, fixture, workspace, storeRoot }) => {
    scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 2, maxStepsPerRun: 24, maxTasks: 2,
      childBinding: { bindingId: 'repair', templateId: 'repair-child', brief: 'Repair a frozen result.', join: 'probe', example: s4b2Example() } })
    const active = scenario
    retryWorkspace = join(workspace, 'fresh-runs', computeDigest('object', { runId: secondRunId }).slice('sha256:'.length))
    const service = await CommandService.open({ root: storeRoot, actor: { kind: 'runtime', id: 'singularity-runtime' }, clock: Date.now })
    const verify = async (request: VerifierRequest) => {
      assert.equal(new TextDecoder().decode((await request.readObject(request.outputs[0], 'object')).bytes), FROZEN_OUTPUT)
      const failed = request.operationId === `${firstRunId}:verify`
      if (failed) await writeFile(join(workspace, OUTPUT_PATH), 'mutable old workspace must not be reused')
      if (request.task.origin.kind === 'child') assert.deepEqual(request.inputs, [previous?.object])
      return sealPublicReceipt({ v: 1, provider: request.task.acceptance, operationId: request.operationId, contractDigest: request.task.digest,
        inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
        criteria: request.task.spec.criteria.map(value => ({ id: value.id, verdict: failed ? 'fail' : 'pass', reason: failed ? reason : 'Frozen bytes independently checked.' })),
        exit: { code: 0, signal: null }, timedOut: false })
    }
    try {
      const result = await executeTaskTree({ ctx: spike.ctx, journalRoot: storeRoot, workspace, runId: firstRunId, sessionId: `${firstRunId}:session`,
        admission: active.runAdmission, composition: active.composition, agentOptions: agentOptions(), maxOutputBytes: 1024,
        verifier: { provider: active.provider, verify }, maxActive: 1, workspaceRoot: join(workspace, 'fresh-runs'),
        async resolveRun(input) {
          if (input.contract.origin.kind === 'child') { child = input.contract; childRunId = input.runId; assert.deepEqual(child.spec.inputs, [previous]) }
          return { composition: await buildSingleRunComposition(spike.ctx, { store: service, id: input.runId, contract: input.contract, agentOptions: agentOptions(), base: { v: 1, seed: input.contract.environment.seed } }),
            agentOptions: agentOptions(), maxOutputBytes: 1024, verifier: { provider: input.contract.acceptance, verify } }
        },
      }, service)
      assert.equal(result.root.classification, 'verified', result.root.executionRecord?.reason)
      assert.equal(result.runs.length, 3)
      assert.equal(await readFile(join(retryWorkspace, previousPath), 'utf8'), FROZEN_OUTPUT)
      assert.equal(await readFile(join(workspace, OUTPUT_PATH), 'utf8'), 'mutable old workspace must not be reused')
      assert.ok(result.root.evidence?.inputs.some(ref => ref.digest === previous?.object.digest))
      assert.equal(fixture.requests.length, 19)
    } finally { await service.close() }
  })
})

void test('live C-03 no-submission then fresh retry verified (fixture when LIVE=0)', { timeout: LIVE ? LIVE_TIMEOUT_MS : 240_000 }, async () => {
  const taskId = `task-s3c-live-c03-${String(process.pid)}-${String(Date.now())}`
  const firstRunId = `${taskId}-run-1`
  const firstSessionId = `${taskId}-session-1`
  const secondRunId = `${taskId}-run-2`
  const secondSessionId = `${taskId}-session-2`
  let scenario: Scenario | undefined
  let secondWorkspace = ''

  const fixtureScript: ReplyScript = (request, index) => {
    if (index === 0) {
      // Mirror the live first step: the host closes it after one admitted
      // step, before the model can plan, write, or submit.
      const reply = selfReadAndPlan(request, 0, scenario, taskId, firstRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 1) {
      const reply = selfReadAndPlan(request, 0, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 2) {
      const reply = selfReadAndPlan(request, 1, scenario, taskId, secondRunId)
      assert.ok(reply)
      return reply
    }
    if (index === 3) return writeOutputReply()
    if (index === 4) return submitReply()
    return { content: 'unexpected extra model request', usage: fixtureUsage(index) }
  }

  const runScenario = async (
    spike: Awaited<ReturnType<typeof bootSpikeProfile>>,
    workspace: string,
    storeRoot: string,
    fixture: ChatCompletionsFixture | undefined,
    live: boolean,
  ): Promise<void> => {
    scenario = await makeScenario(storeRoot, spike.ctx, {
      taskId,
      maxRuns: 2,
      deadlineAt: Date.now() + (live ? 30 : 10) * 60_000,
    })
    const active = scenario
    const firstEvents = recordSessionEvents(spike, firstSessionId)
    const secondEvents = recordSessionEvents(spike, secondSessionId)
    const retryContexts: string[] = []
    const disposeContexts = captureAgentContexts(spike, secondSessionId, retryContexts)
    const verifierCalls: { readonly inputs: readonly Ref[]; readonly outputs: readonly Ref[] }[] = []
    try {
      // The first attempt receives one host step so the fixed budget boundary
      // closes it as failed/no-submission before any output or submission.
      const first = await executeSingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        workspace,
        sessionId: firstSessionId,
        runId: firstRunId,
        admission: {
          ...active.runAdmission,
          budgetReservation: { ...active.runAdmission.budgetReservation, steps: 1 },
        },
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: {
          provider: active.provider,
          verify() {
            throw new Error('the first attempt must not invoke the verifier')
          },
        },
        transientInvalidReasons: [],
      })
      assert.ok(first.kind === 'settled')

      assert.equal(first.runId, firstRunId)
      assert.equal(first.sessionId, firstSessionId)
      assert.equal(first.classification, 'failed')
      assert.equal(first.retry.allowed, true, 'maxRuns=2 must leave the Task open for retry')
      assert.equal(first.manifest, undefined)
      assert.equal(first.manifestRef, undefined)
      assert.equal(first.receipt, undefined)
      assert.equal(first.receiptRef, undefined)
      assert.equal(first.evidence, undefined)
      assert.equal(first.evidenceRef, undefined)
      assert.ok(first.executionRecord)
      assert.ok(first.executionRecordRef)
      assert.match(first.executionRecord.reason, /^(?:no-submission|stop:)/)
      assert.ok(first.usage.inputTokens + first.usage.outputTokens > 0, 'the first attempt must report real usage')
      assert.equal(first.usage.steps, 1)
      await assert.rejects(access(join(workspace, OUTPUT_PATH)), 'the first attempt wrote no output')

      const factsAfterFirst = await readFacts(storeRoot)
      assert.deepEqual(sequenceOf(factsAfterFirst), ['task/admitted', 'run/opened', 'run/closed'])
      const firstOpened = factsOfType(factsAfterFirst, 'run/opened')[0]
      assert.ok(firstOpened)
      const firstClosed = factsOfType(factsAfterFirst, 'run/closed')[0]
      assert.ok(firstClosed)
      assert.equal(firstClosed.data.classification, 'failed')
      assert.equal('evidenceRef' in firstClosed.data, false)
      assert.equal('executionRecordRef' in firstClosed.data, true)
      const firstReason = firstClosed.data.reason
      const firstOpenedDigest = firstOpened.digest
      const firstClosedDigest = firstClosed.digest
      const firstCompositionDigest = firstOpened.data.composition.digest
      const firstRecordRef = 'executionRecordRef' in firstClosed.data
        ? firstClosed.data.executionRecordRef
        : undefined
      assert.ok(firstRecordRef)
      const firstRecordStore = await DomainStore.open({ root: storeRoot })
      let firstRecord: ExecutionRecord
      try {
        firstRecord = parseProtocolValue(
          executionRecordSchema,
          await readJson(firstRecordStore, firstRecordRef, 'object'),
        )
        assert.equal(firstRecord.digest, first.executionRecord.digest)
        assert.match(firstRecord.reason, /^(?:no-submission|stop:)/)
      } finally {
        await firstRecordStore.close()
      }

      assert.equal(
        toolCallNames(firstEvents.events).includes('singularity_submit'),
        false,
        'the first attempt must not submit',
      )
      assert.ok(
        userMessageIds(firstEvents.events).includes(`${firstRunId}:start`),
        'the first attempt must persist its own start wake',
      )

      secondWorkspace = join(storeRoot, 'retry-workspace')
      const second = await retrySingleRun({
        ctx: spike.ctx,
        journalRoot: storeRoot,
        previousRunId: firstRunId,
        runId: secondRunId,
        sessionId: secondSessionId,
        workspace: secondWorkspace,
        composition: await currentComposition(spike.ctx, storeRoot, active),
        agentOptions: agentOptions(),
        maxOutputBytes: 1024 * 1024,
        verifier: passingVerifier(active, secondRunId, secondWorkspace, verifierCalls),
        transientInvalidReasons: [],
      })
      assert.ok(second.kind === 'settled')

      assert.equal(second.previousRunId, firstRunId)
      assert.equal(second.attempt, 2)
      assert.equal(second.runId, secondRunId)
      assert.equal(second.sessionId, secondSessionId)
      assert.notEqual(second.sessionId, firstSessionId, 'retry must use a fresh session')
      assert.equal(second.classification, 'verified')
      assert.equal(verifierCalls.length, 1)
      assert.equal(second.receipt?.operationId, `${secondRunId}:verify`)
      assert.equal(first.executionRecord.digest, firstRecord.digest)
      assert.equal(second.executionRecord, undefined, 'a verified retry must not reuse the old record')
      assert.ok(second.evidence)
      assert.ok(second.evidenceRef)
      assert.notEqual(second.evidenceRef.digest, firstRecord.digest)
      assert.deepEqual(second.evidence.usage, second.usage)
      assert.equal(second.usage.unknownRequests, 0)
      assert.ok(second.usage.inputTokens + second.usage.outputTokens > 0)
      assert.equal(
        await readFile(join(secondWorkspace, OUTPUT_PATH), 'utf8'),
        'mutated-after-submit\n',
        'the verifier ran against the new attempt workspace after freezing CAS',
      )

      assert.equal(retryContexts.length, 1, 'the retry worker context is assembled before its first request')
      const retryContext = retryContexts[0]
      assert.ok(retryContext)
      assert.ok(
        retryContext.includes(`"lastAttempt":{"runId":"${firstRunId}","reason":${JSON.stringify(firstReason)}}`),
        'the retry worker sees only the previous public Run id and closure reason',
      )

      const secondNames = toolCallNames(secondEvents.events)
      for (const name of ['singularity_read', 'singularity_plan', 'bash', 'singularity_submit']) {
        assert.ok(secondNames.includes(name), `the retry worker must call ${name}`)
      }
      assert.ok(
        secondNames.indexOf('singularity_read') < secondNames.indexOf('singularity_plan'),
        'the retry worker must read self before planning',
      )
      assert.ok(
        secondNames.indexOf('singularity_plan') < secondNames.lastIndexOf('bash'),
        'the retry worker must plan before writing the output',
      )
      assert.ok(
        secondNames.lastIndexOf('bash') < secondNames.lastIndexOf('singularity_submit'),
        'the retry worker must write the output before submitting',
      )
      assert.ok(userMessageIds(secondEvents.events).includes(`${secondRunId}:start`))
      assert.equal(
        userMessageIds(secondEvents.events).includes(`${firstRunId}:start`),
        false,
        'the retry session must not replay the previous start wake',
      )

      const facts = await readFacts(storeRoot)
      assert.deepEqual(sequenceOf(facts), [
        'task/admitted',
        'run/opened',
        'run/closed',
        'run/opened',
        'run/submitted',
        'run/closed',
        'task/closed',
      ])
      const opened = factsOfType(facts, 'run/opened')
      assert.deepEqual(opened.map(fact => fact.data.attempt), [1, 2])
      assert.deepEqual(opened.map(fact => fact.data.runId), [firstRunId, secondRunId])
      assert.deepEqual(opened.map(fact => fact.data.sessionId), [firstSessionId, secondSessionId])
      assert.deepEqual(opened.map(fact => fact.data.workspaceKey), [firstRunId, secondRunId])
      assert.equal(opened[0]?.digest, firstOpenedDigest, 'the first run/opened fact is preserved')
      assert.equal(opened[0]?.data.composition.digest, firstCompositionDigest)
      assert.equal(opened[1]?.data.composition.digest, firstCompositionDigest)

      const closed = factsOfType(facts, 'run/closed')
      assert.equal(closed[0]?.digest, firstClosedDigest, 'the first closure must be preserved unchanged')
      assert.equal(closed[0]?.data.classification, 'failed')
      assert.equal(closed[1]?.data.classification, 'verified')
      const secondClosed = closed[1]
      assert.ok(secondClosed)
      assert.equal('evidenceRef' in secondClosed.data, true)
      assert.equal('executionRecordRef' in firstClosed.data, true)

      const submitted = factsOfType(facts, 'run/submitted')
      assert.equal(submitted.length, 1)
      assert.equal(submitted[0]?.data.runId, secondRunId)
      const manifestRef = submitted[0]?.data.outputs
      assert.ok(manifestRef)
      const store = await DomainStore.open({ root: storeRoot })
      try {
        const manifest = parseProtocolValue(
          submissionManifestSchema,
          await readJson(store, manifestRef, 'object'),
        )
        assert.equal(manifest.runId, secondRunId)
        assert.equal(manifest.digest, manifestRef.digest)
        assert.equal(second.manifestRef?.digest, manifestRef.digest)
        const outputRef = manifest.outputs[0]?.object
        assert.ok(outputRef)
        const { bytes } = await store.readObject(outputRef, 'object')
        assert.equal(textDecoder.decode(bytes), FROZEN_OUTPUT)
        const firstRecordAfter = parseProtocolValue(
          executionRecordSchema,
          await readJson(store, firstRecordRef, 'object'),
        )
        assert.equal(firstRecordAfter.digest, firstRecord.digest)
      } finally {
        await store.close()
      }

      const taskClosed = factsOfType(facts, 'task/closed')
      assert.equal(taskClosed.length, 1)
      assert.equal(taskClosed[0]?.data.outcome, 'verified')
      assert.equal(taskClosed[0]?.data.decisiveRunId, secondRunId)

      if (live) {
        assert.equal(fixture, undefined, 'live mode must not start the scripted fixture')
        console.log('S3-C C-03 live evidence:', JSON.stringify({
          firstRunId,
          firstReason,
          firstExecutionRecord: first.executionRecordRef.digest,
          firstUsage: first.usage,
          secondRunId,
          secondSessionId,
          manifest: second.manifestRef.digest,
          receipt: second.receiptRef?.digest,
          evidence: second.evidenceRef.digest,
          usage: second.usage,
          sessionCut: second.sessionCut,
          taskClosed: taskClosed[0]?.digest,
        }))
      } else {
        assert.ok(fixture)
        assert.equal(fixture.requests.length, 5, 'attempt 1 buys one request; attempt 2 buys four')
        const retryWire = messageTexts(fixture.requests[1] ?? {}).join('\n')
        assert.ok(
          retryWire.includes(`"lastAttempt":{"runId":"${firstRunId}","reason":${JSON.stringify(firstReason)}}`),
          'the retry NodeView reaches the first retry request on the wire',
        )
      }

      const archive = await DomainStore.open({ root: storeRoot })
      try { assert.deepEqual(archive.facts(), facts) } finally { await archive.close() }
    } finally {
      disposeContexts()
      firstEvents.dispose()
      secondEvents.dispose()
      if (secondWorkspace.length > 0) {
        await rm(secondWorkspace, { recursive: true, force: true })
      }
    }
  }

  if (LIVE) {
    const credentials = {
      apiKey: requireLiveEnv('SINGULARITY_SPIKE_API_KEY'),
    }
    await withLiveHarness(credentials, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, undefined, true)
      // Close DSH before scanning its home so every session/log write is durable.
      await harness.spike.dispose()
      await assertSecretNotPersisted(harness.home, credentials.apiKey)
    })
  } else {
    await withHarness(fixtureScript, async harness => {
      await runScenario(harness.spike, harness.workspace, harness.storeRoot, harness.fixture, false)
    })
  }
})

for (const complete of [false, true]) {
  void test(`composition freezes the actual scoped platform prompt (complete=${String(complete)})`, { timeout: 240_000 }, async () => {
    const taskId = `task-s3c-prompt-${String(complete)}-${String(process.pid)}-${String(Date.now())}`
    await withHarness((_request, index) => ({ content: 'Finished without submitting.', usage: fixtureUsage(index) }), async ({ spike, fixture, workspace, storeRoot }) => {
      if (complete) {
        spike.ctx.systemPrompt.section({ name: 's3c:complete', order: 50, text: 'Complete host prompt.', complete: true })
      } else {
        spike.ctx.systemPrompt.section({ name: 's3c:after-worker', order: 200, text: 'Host guidance after the worker card.' })
      }
      const scenario = await makeScenario(storeRoot, spike.ctx, { taskId, maxRuns: 1 })
      let observed: Awaited<ReturnType<typeof spike.ctx.systemPrompt.assemble>> | undefined
      const dispose = spike.ctx.on('agent/created', async ({ agent }) => {
        observed = await spike.ctx.systemPrompt.assemble({ scope: agent })
      })
      try {
        await executeSingleRun({
          ctx: spike.ctx,
          journalRoot: storeRoot,
          workspace,
          sessionId: `${taskId}-session`,
          runId: `${taskId}-run`,
          admission: scenario.runAdmission,
          composition: scenario.composition,
          agentOptions: agentOptions(),
          maxOutputBytes: 1024,
          verifier: { provider: scenario.provider, verify() { throw new Error('no submission') } },
          transientInvalidReasons: [],
        })
        assert.ok(observed)
        const text = renderPrompt(observed)
        assert.equal(scenario.composition.platformPrompt, computeDigest('object', { v: 1, text }))
        if (complete) assert.equal(text, 'Complete host prompt.')
        else assert.ok(observed.sections.findIndex(section => section.name === 'singularity:worker-card')
          < observed.sections.findIndex(section => section.name === 's3c:after-worker'))
        assert.equal(fixture.requests.length, 1)
      } finally {
        dispose()
      }
    })
  })
}
