# Verification and support status

The current local refactor removes the review website, server, browser toolchain and assets. It adds a guarded human terminal review transport while preserving Core validation, immutable history, host hooks, WebFetch offset and bounded native question/discovery handling. Version 0.1.0-rc.4 is being published as an explicitly authorized prerelease with the human/native stages below still incomplete.

Prior evidence before this refactor: 145/145 product cases, 11 repeated UI policy cases and 272 public payload files passed. Those are historical counts, not the current terminal-only suite or native acceptance. The removed web-only cases are not relabeled as passing replacements. Current runs must report their actual case/file counts, commands, failures and omissions.

Required automated checks: deterministic build, lint, TypeScript, Core/path/schema/ownership/recovery tests, terminal judgments/denial/scope/pause-resume, transport guard and agent entry denial, both relocated consumer payloads, archive checksums and a scan for removed web entrypoints/dependencies.

Required native checks remain distinct for Claude Code and Codex; see [native host verification](native-host-verification.md). Synthetic human I/O/service calls, ordinary CLI checks, process-boundary fixtures and regenerated hooks do not prove actual native tools or a human-operated TTY. Preserve failures and report blocked/not-run stages accurately.

The rc.4 release assets include VERIFICATION.md with the exact commit, CI, artifact hashes and executed commands. See [rc.4 release notes](releases/v0.1.0-rc.4.md). The MacBook Air registration check before publication found no Byeori plugin or byeori-plugins marketplace registered in either default Claude Code or Codex configuration. Earlier isolated test loading must not be reported as an existing installed plugin or native acceptance.

Local rc.4 candidate verification on the MacBook Air: supported Node24.14.1, pnpm12.10.1, deterministic public build, lint/typecheck, **111/111 tests** (0 failed/cancelled/skipped; file concurrency1), normal 158-file payload/archive readback and clean initialized consumers passed. Normal frozen-lockfile/supply-chain policy checks covered137 entries. Claude Code2.1.303 validated the plugin and marketplace manifests; both bundles reported rc.4, rejected the removed studio command and denied noninteractive human review without project mutation. These are automated/manifest/child-process observations, not positive human TTY or native-host acceptance.
