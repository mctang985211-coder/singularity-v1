# S3 bounded lifecycle correction

## Goal / Spec refs

Close S3 lifecycle correctness gaps using framework §11.4, §15.3 and §19.1: an Agent cleanup failure must prevent Evidence, owned lifecycle waits must terminate, and existing ExecutionRecord.drainPending must identify unfinished cleanup. Preserve DSH as the sole Agent/session/loop owner.

## Scope

Only runtime `run.ts`, `recovery.ts`, `verification.ts` and their existing runtime tests. Read the exact alpha2 public lifecycle types before changing code. No framework, protocol, dependencies, app composition, store/writer, S4 summary/ancestor features or new authority.

## Non-goals / stop boundary

No custom process runner, generic lifecycle service, registry, new public lifecycle interface or guessed external-job contract. If alpha2 and the frozen DomainAdapter interface cannot provide a required cancellation/quarantine capability, record the exact limitation rather than create an unapproved interface.

## Done when / checks

1. Establish behavior negatives before each fix.
2. Drain failure/timeout cannot produce Evidence; unknown work remains explicit in an existing invalid ExecutionRecord.
3. Bound Agent creation, wake/idle and cleanup waits using native cancellation/disposal and local host deadlines.
4. Run focused runtime tests, typecheck/lint and report production line delta; parent runs the final root `pnpm verify` after integration.
5. Report unproved real-model/process isolation evidence and any frozen-interface gap.

## Evidence / implementation

- Against `c5957d6`, four negatives fail: cleanup after a durable submission still returns `verified`; uncooperative create, idle and dispose each leave Run settlement waiting. The same four pass after the correction, including disposal of a late-created handle with zero wake and zero submitted fact.
- Agent creation/resume and idle waits use the original reservation deadline. Native `AgentHandle.dispose()` owns cancel, scope/job drain and persistence close; remove the duplicate `sessions.flush()` wait. Its host cleanup grace is fixed at 5 seconds and admits no new action. Failure/timeout closes invalid with existing `ExecutionRecord.drainPending: true`; it cannot call the verifier or create Evidence.
- The same private budget gate becomes permanently closed before cleanup; the existing submit callback checks it again before the writer command. Native fallback creation checks the original signal before and after input preparation. No additional loop, registry, public interface, protocol field or dependency.
- Remove the single-consumer `executeWithService` forwarder and route the duplicate invalid-submission settlement through the existing `settleRecord`; retain output refs, manifest refs and the existing closure/diagnostic reasons.
- Exact alpha2 lifecycle contract and implementation inspected: create/resume have creation-only signal; dispose cancels, waits idle, disposes scope and closes the persistence handle. `dsh-jobs-local` owns session cleanup and waits registered jobs; the host does not recreate a job registry.

## Commands / scale

- Isolated HOME/cache/store; `pnpm install --frozen-lockfile`: pass, no lock/manifest change.
- Node `24.22.2`, pnpm `11.18.0`, DSH `0.2.2-alpha.2`.
- `pnpm build`, runtime `typecheck`, runtime `lint`: pass. Runtime tests `72/72` pass; four new lifecycle negatives, no skip/cancel. Parent must run final root `pnpm verify` after integrating all slices.
- `git diff --check`: pass. This slice changes production `run.ts` only, `+73/-65`, net **8 lines**. No new production file. Framework/spec-lock/conformance unchanged.

## Unproved / stopped at the frozen interface boundary

This is fixture evidence, not real-model, process-isolation or complete S3 conformance. The current `RunVerifier.verify(VerifyRequest)` has no cancel/drain capability; its host deadline rejects late receipts but cannot stop an arbitrary external job. Alpha2 jobs cleanup can force-fail a registry record when producer cancellation throws, while the underlying process may remain orphaned. The current host also lacks a durable mapping from frozen `workspaceKey` to actual leased filesystem path. Thus this slice cannot prove external-job quarantine or prevent every cross-Run reuse of an orphan-writable path; `drainPending` explicitly does not claim that isolation. Those requirements need a verified deployment/DSH isolation capability, or an approved minimal amendment if the existing interfaces cannot express it. Do not declare S3 complete or promote conformance on this evidence.
