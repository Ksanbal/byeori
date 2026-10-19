# Release promotion

Local implementation and tests do not authorize a push, release or installed-user update. Keep version provisional until explicit publisher approval.

1. Run the supported Node/pnpm deterministic build, lint, typecheck, tests and release verification. Report actual counts and failures.
2. Pack both host plugins and the CLI package; verify checksums, relocated clean consumers, identical runtime bytes and bundled licenses/schemas. Neither consumer fetches packages or starts a web server implicitly; the separate viewer starts only when explicitly invoked.
3. Verify the exact read-only viewer asset/entrypoint allowlist and bundled licenses. Confirm there are no review/edit/approval HTTP routes, public-network listeners, unexpected web entrypoints, remote browser dependencies or leaked local paths/secrets in active deliverables. Legacy receipt provenance and removal-negative tests are compatibility evidence, not entrypoints.
4. Stable/viewer/native-support claims require real-browser visual/interaction acceptance and the separate human-terminal and Claude/Codex native gates in native-host-verification.md. An explicitly authorized prerelease may publish with those stages marked not run and their limits visible in release notes and VERIFICATION.md. Fixture success never substitutes for actual host evidence, and prerelease publication never changes trust, permissions or approval requirements.
5. Review final change scope and remaining limitations with the publisher before committing/pushing/promoting. Release scripts must use their normal concurrency/ref/tag protections; never bypass a failure.

Consumers require supported Node24 and a host-installed plugin. New packages contain cli.mjs, review.mjs, hook.mjs, the opt-in read-only viewer.mjs and offline resources. Existing local planning and receipts survive updates. A user must operate the terminal reviewer directly; the agent CLI cannot grant itself implementation permission.
