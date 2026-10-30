# S3 resume workspace

- Goal: refuse an existing persisted session whose Run workspace is missing, without recreating an empty workspace or buying another request.
- Spec refs: framework §19.1 (recover the same session/workspace intent); §11.2.
- Allowed changes: runtime `src/run.ts`, its existing recovery tests, and this task card.
- Non-goals: protocol changes, workspace identity registry, new options, or changing fresh creation/materialization.
- Done when: missing workspace with persisted session settles invalid before wake/tool/model work; absent persistence still initializes the original intent; existing workspace edits remain intact.
- Checks: regression fails before the fix; recovery tests and root `pnpm verify` pass in the existing agent-isolated toolchain/cache/store/temp directories.
- Evidence: new missing-workspace regression first returned `failed` and purchased a wake; after checking the existing directory in resume setup it settles `invalid` without a wake or recreated directory. Source recovery tests pass 17/17, including preserving edited inputs and materializing inputs into an absent workspace when persistence is absent.
- Root gate: the isolated base (`e9485d1`) lacked the parallel `checkBudget` integration, so its build reported TS2345. The integrated branch supplies the callback and passes root `pnpm verify` with 318/318 tests; see `s3-minimal-corrections.md`. No real-model/RSI evidence is claimed.
