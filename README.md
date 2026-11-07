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
- `domain-tasks/template`: standalone JSON/data domain authoring example; no host imports or required domain TypeScript.
- `domain-tasks/buckyball`: external MXMM task, frozen cases and standard MCP assets.

Raw materials can be prepared by an ordinary DSH env-builder session, then loaded as data by a fresh execution. The builder has no Task, RSI or Method write authority and does not hot-update a live run:

```bash
node apps/singularity/src/env-builder.ts <materials-directory> <fresh-preparation-root>
node apps/singularity/src/domain.ts <fresh-execution-root> <fresh-preparation-root/domain>
```

An execution root belongs to one live process. Exit archives it; start new work with a new root. Configure trusted assets, provider, budgets, deadline and deployment permissions before launch. Private fixtures and untrusted code require a real OS/container/broker boundary supplied by the deployment. Local public fixtures do not establish that boundary.

Domain executions use the generic host entry point above. Domain directories are data-only bundles; they do not ship a TypeScript adapter, verifier, comparator, scheduler, or activation loop. A domain CLI is exposed to the model only through a standard MCP server declared by the bundle, while root checks are run by the host against frozen CAS inputs and outputs.

[Buckyball MXMM Ball task preparation](docs/buckyball-mxmm-ball.md) defines a bounded executable tiling task, frozen cases and correctness-qualified RSI cost comparison. The model authors its implementation, workflow and non-root checks; real environment preflight is separate from model success.
