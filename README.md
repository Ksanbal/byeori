# Byeori

Byeori keeps product planning in reviewable files beside a project. Claude Code and Codex help interview, draft, search and discuss frozen reviews in their terminal conversations. A separate human-only terminal reviewer records the person's explicit judgment. Planning approval and permission to implement an exact file scope remain separate.

## Workflow

1. Install the appropriate host plugin, select supported Node 24.13 or newer Node 24, then run `init` and `doctor` through its packaged `runtime/cli.mjs`.
2. Use the host's start/change/review skill. Answer native questions or chat fallback. Facts, assumptions and unanswered questions are saved with workflow CAS; interview answers do not grant implementation permission.
3. Draft the nine planning document kinds through change operations, lint, then `review prepare`. The assistant explains frozen documents, deletions, manifest and proposed implementation paths in the conversation.
4. **The person** runs `node <plugin>/runtime/review.mjs --root <project>` directly in their own supported terminal. Read the frozen before/after content, choose each judgment, explicitly choose `planning-only` or `allow-implementation`, and type the displayed final confirmation. No selection or empty response defaults to approval.
5. Tell the assistant the review is submitted. It reads `review results` and `status`; valid planning can be applied, while every code operation still needs current host protection and exact frozen implementation authorization.

The human reviewer cannot run through agent tools, pipes or arbitrary wrappers. It does not accept approval JSON or flags. See [terminal review](docs/terminal-review.md) for supported terminals, pause/resume, rejection and transport limits. There is no local web server, review website or browser dependency. External WebFetch/WebSearch research remains available under the host's own permissions.

## Data and protection

Planning/source, immutable frozen rounds, human submissions, responses, workflow, journals and gate checks remain local. Existing review receipts remain readable without changing their judgments or permissions. Hashes check consistency; they are not protection against a malicious same-user filesystem writer. Supported hooks bound what an agent can execute. Unknown tool/shell coverage fails closed; no skip-permissions or automatic advisory fallback is provided.

See [product model](docs/product-model.md), [architecture](docs/architecture-overview.md), [installation](docs/installation.md), [Korean quickstart](docs/quickstart.ko.md) and [native acceptance](docs/native-host-verification.md).

## Development and delivery

Requires supported Node 24 and pnpm 12.10.1. `pnpm check` builds deterministic CLI/reviewer/hook payloads, lints, typechecks, tests and verifies release contents. `pnpm pack:release` and `pnpm verify:release -- --archives` exercise clean consumer archives. Claude and Codex carry byte-identical runtime files with host-specific manifests and skills. No consumer dependency install or build is required.

Version 0.1.0-rc.4 is an explicit prerelease of the terminal review replacement. Direct human-terminal acceptance and the complete native Claude Code/Codex flows remain unverified; see [verification](docs/verification.md) and [release notes](docs/releases/v0.1.0-rc.4.md). Automated checks do not establish native enforcement or grant implementation permission.
