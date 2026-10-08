# Contributing

Contributions should preserve the product boundary: Core owns validation, lifecycle, durable writes and gate decisions; the CLI, Studio and host adapters translate requests into Core operations. Human review cannot be inferred from a chat message, a test fixture or an agent command.

## Development setup

- Node `>=24.13.0 <25` for the runtime and test suite.
- pnpm `12.10.1`, as pinned by `package.json` and the lockfile.
- A supported local environment; cross-platform support has not yet been established. See [Verification](docs/verification.md).

Install and run the complete local check:

```sh
corepack pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` builds the release payload, runs ESLint and the UI policy probes, type-checks, runs the Node test suites, then verifies the generated release payload. Do not change the package manager, regenerate the lock with another manager, skip release verification, or weaken the UI policy checks to make a local run pass.

Useful narrower commands are `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build:release`, and `pnpm verify:release`. A narrower result does not replace `pnpm check` for a complete local validation claim.

## Change boundaries

- Keep consumer runtime commands Node-only and preserve the `>=24.13.0 <25` requirement.
- Keep both generated host runtimes aligned with their source and regenerate only through the documented release build.
- Do not add commands that write planning source, create review submissions or select advisory mode on behalf of a person.
- Do not store secrets, full conversations, private build records or real sensitive planning samples in the public project.
- Keep host support claims tied to real native execution. Synthetic hook input verifies adapter code paths, not host activation.
- Preserve the MIT license and bundled third-party notices.

Run documentation examples only against a disposable project unless an example explicitly says it writes a selected workspace. Report the exact command and scope when proposing a change. Public issue and pull request availability is pending repository publication.
