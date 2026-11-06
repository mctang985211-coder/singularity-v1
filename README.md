# Singularity V1

Task-centred domain RSI framework in TypeScript, built on DeepSeek Harness `0.2.2-alpha.2`.

The [framework](docs/framework.md) is the protocol authority. [Progress](docs/progress.md) records implementation coverage and its evidence limits; [AGENTS.md](AGENTS.md) defines construction rules.

Use Node >=24.9.0 and pnpm 11.18.0:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

- `packages/singularity/protocol`: schemas, immutable identities, admission and fact reducers.
- `packages/singularity/runtime`: Task trees, frozen outputs, native DSH composition and RSI Rounds.
- `apps/singularity`: DSH profile and host composition.
- `packages/domains/inventory`: public example domain, verifier and comparator.
- `apps/singularity/examples/inventory-validation.ts`: optional bounded model exercise.
- `domain-tasks/template`: standalone JSON/data domain authoring example; no host imports or required domain TypeScript.
- `domain-tasks/buckyball`: external MXMM task, frozen cases and standard MCP assets.

Raw materials can be prepared by an ordinary DSH env-builder session, then loaded as data by a fresh execution. The builder has no Task, RSI or Method write authority and does not hot-update a live run:

```bash
node apps/singularity/src/env-builder.ts <materials-directory> <fresh-preparation-root>
node apps/singularity/src/domain.ts <fresh-execution-root> <fresh-preparation-root/domain>
```

An execution root belongs to one live process. Exit archives it; start new work with a new root. Configure trusted assets, provider, budgets, deadline and deployment permissions before launch. Private fixtures and untrusted code require a real OS/container/broker boundary supplied by the deployment. Local public fixtures do not establish that boundary.

The inventory example makes model requests. The native profile defaults to `deepseek-flash`, max reasoning, a 700000-token context and a 40000-token output limit. Set `SINGULARITY_SPIKE_BASE_URL` and `SINGULARITY_SPIKE_API_KEY` in the launch environment. With an approved budget, run:

```bash
pnpm --filter @singularity/app exec node examples/inventory-validation.ts <fresh-root> 1 <previous-root> --config <config.json>
```

The optional previous root supplies cumulative usage counters only. It does not resume prior execution. Automated tests use local DSH fixtures and do not purchase model requests or activate production Methods.

The JSON config accepts `scenario: "warehouse-network"`, `initialMethod: "empty" | "guided"`, `publicResources: true`, and `activateWinners: true`. Public resources supply a native skill and inventory MCP. Winner activation uses the completed comparison and expected previous head in the isolated example domain; subsequent rounds and a final work Task consume the active head. Set absolute `deadlineAt`, `maxRequests`, `maxReportedTokens` and Task/Round budgets before launch. When the environment requires its configured HTTP proxy, pass Node's native `--use-env-proxy` flag.

[The 2026-11-01 validation report](docs/validation-20261101.md) distinguishes actual model runs, local fixtures, failures and remaining domain validation.

[Buckyball MXMM Ball task preparation](docs/buckyball-mxmm-ball.md) defines a bounded executable tiling task, frozen cases and correctness-qualified RSI cost comparison. The model authors its implementation, workflow and non-root checks; real environment preflight is separate from model success.
