# S3 workspace correction

- Goal: reject symlink ancestors before freezing declared file/tree outputs and learning drafts, preserving the existing no-follow traversal.
- Spec refs: framework §§11.4, 15.3, 19.1; no protocol changes.
- Allowed changes: `packages/singularity/runtime/src/workspace.ts`, its existing `test/workspace-submission.test.ts`, and this task card.
- Non-goals: new filesystem abstractions, public options, protocol fields, initialization semantics, or run recovery changes. The run recovery slice owns avoiding repeated input initialization on resume.
- Done when: external bytes reached through symlink ancestors cannot produce a submission/check; optional missing outputs and ordinary snapshots still work; root verification passes.
- Checks: establish failing file/tree/draft symlink-ancestor regressions, rerun them after the minimal fix, then `pnpm verify` with Node 24.22.2 and pnpm 11.18.0 in isolated HOME/cache/store/temp directories.
- Evidence: all three new regressions first failed with `Missing expected rejection`; the two-line fix passes the existing workspace suite (8/8) and root `pnpm verify` (build, typecheck, lint, protocol/runtime/app tests). These are unit and DSH fixture evidence, not real-model or domain/RSI evidence.
