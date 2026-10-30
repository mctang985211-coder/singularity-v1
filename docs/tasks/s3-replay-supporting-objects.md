# S3 replay supporting objects

## Goal / Spec refs

Complete existing CAS reference validation for the S3 submission path, under framework §10.1–10.3, §15.2–15.3 and C-11. A committed manifest or Evidence must not hide a missing, corrupt or wrong-domain nested CAS object during replay.

## Scope / non-goals

Only runtime `store.ts`, its existing CAS-reference tests, and this card. Reuse protocol schemas and the existing reference walker; no new public API, authority, fact, dependency, registry or abstraction. Keep private receipts and acceptance payload opaque. Do not enter S4, alter framework/spec-lock, or promote conformance.

## Done when / checks

First reproduce replay accepting a missing nested manifest/Evidence/receipt reference. Cover append rejection before journal bytes change and restart/replay rejection. Remove duplicated parsing only when directly replaced. Run `pnpm install --frozen-lockfile`, root `pnpm verify` and `git diff --check`; distinguish fixture evidence from live-model evidence.
## Evidence / size

- Negative fixtures first reproduced `Missing expected rejection` for a missing manifest output, missing Evidence output/public/private receipt, and a wrong-domain Evidence output/receipt provider. A separate tree fixture reproduced an absent leaf passing restart when only the tree's top object was checked.
- The existing `ReferenceValidator` now consumes the three frozen protocol schemas and the existing workspace `SealedTreeManifest` type. Private receipt and acceptance payloads remain opaque; only their `object` refs are verified. Tree traversal is selected solely by declared manifest `kind='tree'`.
- Frozen fixtures previously using arbitrary raw bytes as manifests/Evidence now use the real existing schemas. No schema or business acceptance rule was relaxed.
- Isolated frozen install passed. Root `pnpm verify` passed project/build/typecheck/lint/protocol tests, then runtime `77/78`: the old recovery test attempted to commit a malformed manifest, which the strengthened commit boundary correctly rejected. Integration must adapt that fixture to assert rejection before append/recovery. No live model or domain evidence was generated; conformance remains unchanged.
- Final focused CAS tests: `20/20` passed. `git diff --check` passed. Production TypeScript is `+58/-7` (net `+51`); the workspace change only exports its existing tree type. No new production file, dependency, writer, state, fact or runtime entry point.
- Framework §2 explicitly assumes a single project process owning the journal. Existing process-local writer ownership matches this deployment assumption; no distributed or OS lock mechanism was added.
