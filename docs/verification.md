# Verification and support status

This page distinguishes automated local evidence from native-host, remote and publication evidence. The current package is prerelease `0.1.0-rc.1` (tag `v0.1.0-rc.1`), not stable `0.1.0`. This page is not a release or security certification.

## Runtime support

| Area | Current evidence |
| --- | --- |
| Consumer runtime | Packaged CLI declares Node `>=24.13.0 <25`; no consumer pnpm/build dependency. |
| Development | Node `24.13.0`, pnpm `12.10.1`, frozen lockfile. |
| OS | Local QA observed macOS `27.0.1` (build `26A434`), Darwin kernel `27.0.0`, arm64. Linux and Windows consumer/host support have not been verified. |
| Claude Code | Actual CLI `2.1.294` binary provenance (version, official artifact SHA-256 and macOS code signature) was verified; plugin-directory and marketplace validation passed without warnings. Auth status was `loggedIn: false` / `authMethod: none`. Authenticated model use, native hook activation and compact validation remain unverified. |
| Codex CLI | The current `0.1.0-rc.1` package is locally installed with all 42 pre-existing plugin entries preserved (43 total); 130 cached files matched the exported plugin, the TUI showed four skills, and both Byeori `SessionStart` and `PreToolUse` hooks were discovered. Codex requires reviewing the hooks before trust; active enforcement remains unverified. An earlier `0.1.0` portable package omitted hooks. |
| Remote CI | Workflow definitions and action pins were inspected, but GitHub Actions execution has not been observed. |
| Public GitHub release | Planned repository and assets are not yet verified as public or installable. |

## Recorded local checks

The full local check completed on 2026-10-08 from 09:59:13.844Z to 10:01:29.657Z, exit 0. It reported `124/124` product tests, `11/11` separate UI policy probes, lint, UI lint, TypeScript checking, deterministic release build and release verification for 264 payload files. The check used Node `24.13.0` and pnpm `12.10.1`; the lock hash was `f16ab1b1f72697714a6c312a398808058f99681a08cf30feacbad2f4cf587cf7`.

Claude Code was run from a private temporary executable path as version `2.1.294` after official artifact SHA-256 and macOS code-signature checks; plugin-directory validation and separate marketplace validation passed without warnings. The read-only auth result was `loggedIn: false`, `authMethod: none`. No account or credentials were added. This is plugin validation and executable provenance only: no authenticated model request, native hook event, trust-backed activation, or compact/resume pass was observed.

Codex CLI `0.161.0` installed the current RC package from a local marketplace. Readback preserved all 42 pre-existing plugin entries (43 total); the 130 cached plugin files matched the exported plugin, and a native TUI displayed four Byeori skills. Both Byeori `SessionStart` and `PreToolUse` hooks were discovered. The host displayed a trust-review requirement for the newly discovered hooks; that review is pending, so active enforcement is not claimed. An earlier `0.1.0` portable package omitted hooks. This does not establish the public GitHub marketplace installation path.

One earlier native Codex `workspace-write` run of `init`, `doctor` and `status` exited `6` (`CAPABILITY_UNAVAILABLE`) when process identity could not be observed. Normal on-request execution has not been tested, so the result does not establish behavior for other permission modes.

An independent focused recheck at source revision `b1d6915eb134edb97e2016b9e8cf599dc9a5467a` reproduced changed-risk cases, checked all 423 source hashes and confirmed generated CLI/hook/worker bytes and release archives matched recorded artifacts. It was not a second full check on a later integrated revision.

Earlier integrated browser and package tests exercised the real local Core-backed HTTP/React Studio, nine document views, review save/submit/apply flows, cache removal, project relocation and standalone tarball commands. UI policy probes include positive and negative cases. These are local automated tests, often against synthetic projects and reviews; they are not native host operation evidence or end-user signoff.

## Not established

- For Claude Code, artifact provenance and local plugin validation passed without warnings; authenticated model use, native hook activation and compact/resume remain unverified while signed out. For Codex, local RC installation, cache readback and discovery of both Byeori hooks passed. Codex requires a trust review for newly discovered hooks; until that review is complete and activation is observed, enforcement is unverified. An earlier `0.1.0` package used a portable format that omitted hooks. One earlier `workspace-write` command run exited `6` because process identity could not be observed; normal on-request execution has not been tested. Generated manifests and synthetic hook tests are not native activation evidence.
- Human approval tests use synthetic product fixtures; they do not stand in for an actual user decision in a real project.
- Actual LLM interview behavior, agent adoption/search expansion and remote GitHub response-loss recovery have not been verified.
- Remote CI, public repository visibility, public marketplace listing, prerelease publication and clean remote installation remain pending.
- There is an incomplete independent server review. The completed local tests are not a substitute for that review.
- Development checkpoint fingerprints are not an independent durable backup. The build does not provide a hosted recovery service or guarantee recovery if the user's project/workspace is lost.

Use `doctor` and `status` in the actual selected project after setup. A configured file, recorded trust choice or simulated event must not be described as active native enforcement; rely on the returned current observation and its coverage limits.
