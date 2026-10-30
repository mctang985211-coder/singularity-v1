# S3 replay supporting objects

## Goal / Spec refs

Complete existing CAS reference validation for the S3 submission path, under framework §10.1–10.3, §15.2–15.3 and C-11. A committed manifest or Evidence must not hide a missing, corrupt or wrong-domain nested CAS object during replay.

## Scope / non-goals

Only runtime `store.ts`, its existing CAS-reference tests, and this card. Reuse protocol schemas and the existing reference walker; no new public API, authority, fact, dependency, registry or abstraction. Keep private receipts and acceptance payload opaque. Do not enter S4, alter framework/spec-lock, or promote conformance.

## Done when / checks

First reproduce replay accepting a missing nested manifest/Evidence/receipt reference. Cover append rejection before journal bytes change and restart/replay rejection. Remove duplicated parsing only when directly replaced. Run `pnpm install --frozen-lockfile`, root `pnpm verify` and `git diff --check`; distinguish fixture evidence from live-model evidence.
