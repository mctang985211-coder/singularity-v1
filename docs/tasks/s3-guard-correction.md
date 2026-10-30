# S3 guard correction

## Goal

Close two runtime gaps without expanding the protocol: bind verifier receipts to the frozen `TaskContract.acceptance` reference, and let the host deny domain tool dispatch when its exact run budget/deadline check says no budget remains.

## Spec refs

- `docs/framework.md` §4.3 (acceptance authority)
- `docs/framework.md` §11.5 (host receipt validation)
- `docs/framework.md` §14.2 (tool guard)
- `docs/framework.md` §15.3 (receipt provider and host classification)

## Allowed changes

- `packages/singularity/runtime/src/verification.ts`
- `packages/singularity/runtime/src/tools.ts`
- `packages/singularity/runtime/test/run-verification.test.ts`
- focused existing runtime tool tests

The run owner may connect the already-defined internal budget callback at the controller construction site. No protocol fields, public error codes, acceptance schema, domain broker, or model loop may be added.

## Non-goals

No reducer, recovery, workspace, service, framework, lockfile, dependency, or README changes; no percentage-based budget inference; no new acceptance resolver.

## Done when

- A receipt produced by a provider different from the frozen contract acceptance is invalid even when the verifier argument names that provider.
- The shared tool guard invokes the host's exact budget callback before domain tools and returns the existing `LIMIT_EXCEEDED` refusal when denied.
- Regression tests fail before the fix and pass after it.

## Checks

```text
pnpm install --frozen-lockfile
pnpm --filter @singularity/runtime test
pnpm verify
```

## Evidence

- Both regression tests failed before the fix and passed afterward.
- Node `24.22.2` frozen install passed; runtime tests passed `56/56`; runtime lint passed.
- Typecheck reports only the expected missing `checkBudget` at the run owner's construction site. The run owner will wire the callback and run the root `pnpm verify` gate after integration.
- These are fixture/unit checks, not real-model or domain RSI evidence.
