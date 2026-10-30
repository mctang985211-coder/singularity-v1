# S3 resume workspace

- Goal: refuse an existing persisted session whose Run workspace is missing, without recreating an empty workspace or buying another request.
- Spec refs: framework §19.1 (recover the same session/workspace intent); §11.2.
- Allowed changes: runtime `src/run.ts`, its existing recovery tests, and this task card.
- Non-goals: protocol changes, workspace identity registry, new options, or changing fresh creation/materialization.
- Done when: missing workspace with persisted session settles invalid before wake/tool/model work; absent persistence still initializes the original intent; existing workspace edits remain intact.
- Checks: regression fails before the fix; recovery tests and root `pnpm verify` pass in the existing agent-isolated toolchain/cache/store/temp directories.
- Evidence: new missing-workspace regression first returned `failed` and purchased a wake; after checking the existing directory in resume setup it settles `invalid` without a wake or recreated directory. Source recovery tests pass 17/17, including preserving edited inputs and materializing inputs into an absent workspace when persistence is absent.
- Root gate: this isolated base (`e9485d1`) already lacks the `checkBudget` callback required by its tool controller, so `pnpm build` reports TS2345 before this change. The parent owns the callback fix and final integrated `pnpm verify`; this slice does not copy that parallel work or claim an independent root-gate pass. No real-model/RSI evidence is claimed.
