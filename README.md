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

An execution root belongs to one live process. Exit archives it; start new work with a new root. Configure trusted assets, provider, budgets, deadline and deployment permissions before launch. Private fixtures and untrusted code require a real OS/container/broker boundary supplied by the deployment. Local public fixtures do not establish that boundary.

The inventory example makes model requests. With an explicitly approved budget and provider profile, run:

```bash
pnpm --filter @singularity/app exec node examples/inventory-validation.ts <fresh-root> 1 <previous-root> --config <config.json>
```

The optional previous root supplies cumulative usage counters only. It does not resume prior execution. Automated tests use local DSH fixtures and do not purchase model requests or activate production Methods.
