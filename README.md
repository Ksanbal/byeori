# Byeori

Byeori keeps product planning in reviewable files beside a project. An AI assistant can help draft and search the plans; a person reviews a frozen snapshot in the local Studio before planning is applied. Any implementation work still needs its own explicit path scope and authorization.

**Status:** The current package is the explicit prerelease `0.1.0-rc.1` (tag `v0.1.0-rc.1`), not stable `0.1.0`. Claude Code `2.1.294` artifact provenance and local plugin validation passed without warnings, but the host was signed out, so authenticated model-session, native hook-activation and compact checks remain unverified. The current Codex RC package is installed locally; its two hooks were discovered, and the host requires reviewing them before trust. Active enforcement is not yet established. Remote/public release checks remain pending. See [Verification](docs/verification.md) and [Installation](docs/installation.md) before relying on host protection.

## What it does

- Stores planning as YAML in the project: PRD, actor, scenario, feature, information architecture, screen, entity, OpenAPI 3.1.1 and architecture documents.
- Lets an assistant search approved plans, draft a change and prepare a review without writing approved source directly.
- Opens a local Studio for item-by-item review, comments, deletions and optional implementation scope. Saving feedback is not approval; the person explicitly submits the frozen review.
- Keeps drafts, frozen before/after rounds, review submissions, responses, applied changes and implementation records as distinct product records. Search cache is disposable.
- Ships a Node-only consumer runtime. A project does not need pnpm, a build step or Byeori developer dependencies to run the packaged CLI.

See [the product model](docs/product-model.md), [architecture](docs/architecture-overview.md), and [Korean quick start](docs/quickstart.ko.md).

## Four-step workflow

1. **Install the host plugin when the native installation gate is complete.** Current commands and their pending status are in [Installation](docs/installation.md).
2. **Initialize a selected project.** From an extracted release or installed plugin, resolve its `runtime/cli.mjs` and run:

   ```sh
   BYEORI_CLI="/path/to/byeori-plugin/runtime/cli.mjs"
   PROJECT="/path/to/project"
   node "$BYEORI_CLI" init --root "$PROJECT" --json
   node "$BYEORI_CLI" doctor --root "$PROJECT" --json
   node "$BYEORI_CLI" status --root "$PROJECT" --json
   ```

   These commands require Node `>=24.13.0 <25`. The first writes the managed planning setup; review its result before continuing. `doctor` reports runtime and host observations, and `status` reports the bound project state.

3. **Draft and prepare.** Ask the installed assistant skill to start or change the plan. It uses versioned drafts, then validates and freezes a review round. You can inspect the supported command contract with `node "/path/to/byeori-plugin/runtime/cli.mjs" --help`.
4. **Review, submit and apply.** Start Studio with `studio --action start`, inspect all decisions, comments, deletions and any implementation allowlist, then explicitly submit in Studio. Afterward, ask the assistant to read the durable results. Approval of planning and permission to edit code are separate; the latter is bounded by the reviewed file or directory paths.

## Runtime and development

Consumer runtime: Node `>=24.13.0 <25`; no consumer pnpm installation. Development uses Node 24 and pnpm `12.10.1` with the committed lockfile:

```sh
corepack pnpm install --frozen-lockfile
pnpm check
```

See [Contributing](CONTRIBUTING.md) for the full local workflow. The product is licensed under [MIT](LICENSE); bundled dependency terms are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## Release and security

The planned public repository is [github.com/Ksanbal/byeori](https://github.com/Ksanbal/byeori); public availability and release assets are not yet verified. Installation, update and removal instructions are explicitly labeled as candidate commands until the release gates complete. For current test scope and limits, see [Verification](docs/verification.md). For vulnerability reporting and product boundaries, see [Security](SECURITY.md).
