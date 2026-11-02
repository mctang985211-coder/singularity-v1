import { execFile } from 'node:child_process'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { AdmissionError,canonicalize,checkRecipeSchema,parseJsonText,sealPublicCheckReport,sealPublicReceipt } from '@singularity/protocol'
import type { ExecutableCheck,JsonObject,Ref,TaskSpec } from '@singularity/protocol'
import { readTreeBundle } from '@singularity/runtime'
import type { CasObjectWriter,DescribeCheck,VerifierRequest } from '@singularity/runtime'
import { z } from 'zod'

const params = z.object({ candidate: z.string().regex(/^result\/[A-Za-z0-9_./-]+\.py$/), suite: z.enum(['kernel', 'stream', 'all']) })
const sourcePath = fileURLToPath(new URL('./conv1d/verify.py', import.meta.url))
const maxWallClockMs = 5 * 60 * 1000
export async function freezeConv1dChecks(writer: CasObjectWriter) {
  const script = await writer.putObject('conv1d:verifier-source', await readFile(sourcePath))
  const recipe = { v: 1, name: 'causal-int8-conv1d', entrypoint: ['python3', sourcePath], dependencies: [script],
    paramsSchema: { type: 'object', additionalProperties: false, required: ['candidate', 'suite'], properties: {
      candidate: { type: 'string', pattern: '^result/[A-Za-z0-9_./-]+\\.py$' }, suite: { enum: ['kernel', 'stream', 'all'] } } },
    resultSchema: { anyOf: [{ type: 'object', required: ['schema', 'checkId', 'verdict', 'metrics', 'candidateDigest', 'verifierDigest', 'specDigest', 'caseSetDigest', 'failures'],
      properties: { schema: { const: 'local-check-result/v1' }, checkId: { type: 'string' }, verdict: { enum: ['pass', 'fail'] },
        metrics: { type: 'object', required: ['casesRun', 'valuesCompared', 'mismatches', 'executionErrors'], properties: {
          casesRun: { type: 'integer', minimum: 1 }, valuesCompared: { type: 'integer', minimum: 0 }, mismatches: { type: 'integer', minimum: 0 }, executionErrors: { type: 'integer', minimum: 0 } } } } },
      { type: 'object', additionalProperties: false, required: ['executionStatus', 'reason'], properties: {
        executionStatus: { const: 'timeout' }, reason: { type: 'string', minLength: 1 } } }] },
    publicDataPolicy: '29 public boundary and fixed-seed cases per profile. kernel: exact batch convolution; stream: independently partitioned chunks. all runs both profiles. No candidate solutions are solver inputs.',
    passRule: 'All 29 cases/profile run, all expected elements compared, no execution error or integer mismatch. Exact signed int32 outputs; no approximation.', maxWallClockMs }
  const recipeRef = await writer.putObject('conv1d:recipe', new TextEncoder().encode(canonicalize(recipe)))
  const policy = await writer.putObject('conv1d:policy', new TextEncoder().encode(canonicalize({ v: 1, checkRecipes: [recipeRef], checkResources: [script] })))
  return { recipeRef, policy, script }
}
export function conv1dCheck(recipeRef: Ref, suite: 'kernel' | 'stream' | 'all'): ExecutableCheck {
  return { checkId: suite, recipeRef, params: { candidate: 'result/candidate.py', suite } }
}
export const describeConv1dCheck: DescribeCheck = ({ check, spec }) => {
  const value = params.parse(check.params)
  if (!spec.outputs.some(output => output.id === 'result' && output.path === 'result' && output.kind === 'tree')) throw new AdmissionError('INVALID_ARGUMENT', 'Conv1D checks require the declared result/ tree output')
  if (value.candidate.split('/').includes('..')) throw new AdmissionError('INVALID_ARGUMENT', 'Conv1D candidate must remain inside the declared result output')
  return { displayCommand: ['python3', sourcePath, '--candidate', value.candidate, '--suite', value.suite, '--report', `checks/${encodeURIComponent(check.checkId)}.json`],
    expectedReport: { verdict: 'pass', metrics: { casesRun: value.suite === 'all' ? 58 : 29, valuesCompared: value.suite === 'all' ? 512 : 256, mismatches: 0, maxAbsError: 0, executionErrors: 0 } } }
}
export function conv1dTaskSpec(recipeRef: Ref): TaskSpec {
  return { goal: { summary: 'Implement exact causal INT8 Conv1D with a JSON stdin/stdout batch kernel and streaming interface. Use the public checker and returned differences to debug.',
    deliverable: 'result/candidate.py', scope: ['Public exact-integer numerical/interface task.'], constraints: ['y[t]=sum(kernel[j]*x[t-j*dilation]); x[t<0]=0; int8 inputs and weights, exact int32 outputs.', 'Read one JSON request from stdin and emit {"y":[int32,...]} on stdout. Request fields: op=kernel|stream; x=int8[]; kernel=int8[] of size 1,2,3,5; dilation=1,2,3; chunks=positive lengths summing to len(x), or [] for empty x. Diagnostic text belongs on stderr.', 'Streaming chunks preserve history within the request and must equal concatenated batch output. Exact integer arithmetic: no truncation or saturation. Public all check executes 58 cases and compares 512 values; kernel and stream each execute 29 cases/256 values.'] },
    criteria: [{ id: 'conv1d-exact', statement: 'All batch and stream public boundary cases match exact independent integer reference.', required: true, checks: [conv1dCheck(recipeRef, 'all')] }],
    inputs: [], outputs: [{ id: 'result', path: 'result', kind: 'tree', role: 'deliverable', required: true }] }
}
export function conv1dVerifier(options: { root: string; writer: CasObjectWriter; recipeRef: Ref; script: Ref }) {
  return async (request: VerifierRequest) => {
    const recipe = checkRecipeSchema.parse(parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(
      (await request.readObject(options.recipeRef, 'object')).bytes)))
    const workspace = join(options.root, Buffer.from(request.operationId).toString('hex'))
    await mkdir(workspace, { recursive: true })
    const verifier = join(workspace, 'verify.py')
    await writeFile(verifier, (await request.readObject(options.script, 'object')).bytes)
    const output = request.outputs.find(ref => ref.id.endsWith(':output:result'))
    if (output !== undefined) for (const [path, bytes] of (await readTreeBundle({ readObject: request.readObject }, output, 1024 * 1024)).contents) {
      const target = join(workspace, 'result', path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    }
    const criteria = []
    for (const criterion of request.task.spec.criteria.filter(value => value.required)) {
      const checks = []
      for (const check of criterion.checks) {
        request.signal.throwIfAborted()
        if (check.recipeRef.id !== options.recipeRef.id || check.recipeRef.digest !== options.recipeRef.digest) throw new Error('Unsupported Conv1D recipe')
        const value = params.parse(check.params)
        describeConv1dCheck({ check, recipeRef: options.recipeRef, recipe: {} as never, spec: request.task.spec, limits: request.task.limits })
        const reportPath = join(workspace, 'checks', encodeURIComponent(criterion.id), `${encodeURIComponent(check.checkId)}.json`)
        const deadline = AbortSignal.timeout(Math.max(0, Math.min(recipe.maxWallClockMs, request.task.limits.deadlineAt - Date.now())))
        const signal = AbortSignal.any([request.signal, deadline])
        const execution = promisify(execFile)('python3', [verifier, '--candidate', value.candidate, '--suite', value.suite, '--report', reportPath],
          { cwd: workspace, signal })
        // The abort callback can precede process exit; the verifier owns both.
        const closed = new Promise<void>(resolve => { execution.child.once('close', () => { resolve() }) })
        let timedOut = false
        try { await execution }
        catch (error) {
          request.signal.throwIfAborted()
          if (deadline.aborted && error instanceof Error && error.name === 'AbortError' && error.cause === deadline.reason) timedOut = true
          else if ((error as { code?: number }).code !== 1) throw error
        } finally { await closed }
        request.signal.throwIfAborted()
        const data: JsonObject = timedOut ? { executionStatus: 'timeout', reason: 'The frozen Conv1D check execution deadline elapsed.' }
          : JSON.parse(await readFile(reportPath, 'utf8')) as JsonObject
        const verdict = timedOut ? 'invalid' as const : data.verdict === 'pass' ? 'pass' as const : 'fail' as const
        const report = sealPublicCheckReport({ v: 1, operationId: request.operationId, contractDigest: request.task.digest, criterionId: criterion.id,
          checkId: check.checkId, recipeRef: check.recipeRef, inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest),
          exit: { code: execution.child.exitCode, signal: execution.child.signalCode }, timedOut, verdict, data })
        checks.push({ checkId: check.checkId, verdict, reportRef: await options.writer.putObject(`${request.operationId}:${criterion.id}:${check.checkId}`, new TextEncoder().encode(canonicalize(report))) })
      }
      const invalid = checks.some(check => check.verdict === 'invalid')
      criteria.push({ id: criterion.id, verdict: invalid ? 'invalid' as const : checks.every(check => check.verdict === 'pass') ? 'pass' as const : 'fail' as const,
        reason: invalid ? 'A frozen Conv1D check exceeded its execution deadline.' : 'Independent frozen checker compared actual candidate output with exact int32 oracle.', checks })
    }
    return sealPublicReceipt({ v: 1, provider: request.task.acceptance, operationId: request.operationId, contractDigest: request.task.digest,
      inputDigests: request.inputs.map(ref => ref.digest), outputDigests: request.outputs.map(ref => ref.digest), criteria, exit: { code: 0, signal: null }, timedOut: false })
  }
}
