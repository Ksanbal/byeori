# Verification and support status

This page distinguishes automated local evidence from native-host, remote and publication evidence. The intended release is prerelease `0.1.0-rc.1` (tag `v0.1.0-rc.1`), not stable `0.1.0`; generated package metadata still needs regeneration from the final version before publication. This page is not a release or security certification.

## Runtime support

| Area | Current evidence |
| --- | --- |
| Consumer runtime | Packaged CLI declares Node `>=24.13.0 <25`; no consumer pnpm/build dependency. |
| Development | Node `24.13.0`, pnpm `12.10.1`, frozen lockfile. |
| OS | Local QA observed macOS `27.0.1` (build `26A434`), Darwin kernel `27.0.0`, arm64. Linux and Windows consumer/host support have not been verified. |
| Claude Code | Actual CLI `2.1.294` binary provenance (version, official artifact SHA-256 and macOS code signature) was verified; plugin-directory and marketplace validation passed. Auth status was `loggedIn: false` / `authMethod: none`. An authenticated model session, native hook activation and compact validation are blocked; no pass is claimed. |
| Codex CLI | Local `codex-cli 0.161.0` marketplace registration/cache installation passed. The 42 pre-existing plugin entries were preserved (43 total after install); the 130-file plugin cache matched the exported plugin. A native TUI session showed the four Byeori skills. `/hooks` showed the pre-existing user hook file but no Byeori source, so hook activation/enforcement remain unverified. |
| Remote CI | Workflow definitions and action pins were inspected, but GitHub Actions execution has not been observed. |
| Public GitHub release | Planned repository and assets are not yet verified as public or installable. |

## Recorded local checks

The B12 repair's full check completed on 2026-10-08 from 09:29:49.313Z to 09:32:06.073Z, exit 0. It reported `123/123` product tests, `11/11` separate UI policy probes, ESLint, UI lint, TypeScript checking, deterministic release build and release verification for 264 payload files. The check used Node `24.13.0` and pnpm `12.10.1`; the lock hash remained `f16ab1b1f72697714a6c312a398808058f99681a08cf30feacbad2f4cf587cf7`.

Claude Code was run from a private temporary executable path as version `2.1.294` after official artifact SHA-256 and macOS code-signature checks; plugin-directory validation and separate marketplace validation passed. The marketplace emitted an optional missing-description warning; no warning-free claim is made. The read-only auth result was `loggedIn: false`, `authMethod: none`. No account or credentials were added. This is plugin validation and executable provenance only: no authenticated model request, native hook event, trust-backed activation, or compact/resume pass was observed.

Codex CLI `0.161.0` registered the local marketplace and installed the plugin into its cache. Readback preserved all 42 pre-existing plugin entries (43 installed afterward); the 130 cached plugin files matched the exported local plugin files. A native TUI session displayed four Byeori skills. The native `/hooks` view showed the pre-existing user hook file and no Byeori hook source. Therefore local plugin registration/cache and skill discovery passed, while hook discovery, hook activation and active enforcement remain unverified. This does not establish the public GitHub marketplace installation path.

In an actual native Codex `workspace-write` run, `init`, `doctor` and `status` each exited `6` (`CAPABILITY_UNAVAILABLE`) because the process could not observe process start/boot identity. A normal permission-flow investigation did not establish a resolution. No validation was bypassed, and no native write succeeded. The four observed fixture guidance/workflow files remained byte-identical. This environment limitation is separate from plugin installation and skill discovery.

The B12 independent recheck at fixed source revision `b1d6915eb134edb97e2016b9e8cf599dc9a5467a` separately reproduced the changed-risk cases, checked all 423 source hashes and confirmed the generated CLI/hook/worker bytes and release archives matched their recorded artifacts. This was a focused changed-risk recheck; it did not claim a second full `pnpm check` run on a later integrated primary revision.

Earlier integrated browser and package tests exercised the real local Core-backed HTTP/React Studio, nine document views, review save/submit/apply flows, cache removal, project relocation and standalone tarball commands. UI policy probes include positive and negative cases. These are local automated tests, often against synthetic projects and reviews; they are not native host operation evidence or end-user signoff.

## Not established

- For Claude Code, artifact provenance and local plugin validation passed; authenticated model use, native hook activation and compact/resume remain blocked by the signed-out state. For Codex, local registration/cache installation and TUI skill discovery passed, but the Byeori hook was absent from `/hooks`; hook activation and enforcement are unverified. Actual `workspace-write` `init`/`doctor`/`status` also fail closed with capability exit `6` while process identity cannot be observed. Generated manifests and synthetic hook tests are not native activation evidence.
- Human approval tests use synthetic product fixtures; they do not stand in for an actual user decision in a real project.
- Actual LLM interview behavior, agent adoption/search expansion and remote GitHub response-loss recovery have not been verified.
- Remote CI, public repository visibility, public marketplace listing, prerelease publication and clean remote installation remain pending.
- There is an incomplete independent server review. The completed local tests are not a substitute for that review.
- Development checkpoint fingerprints are not an independent durable backup. The build does not provide a hosted recovery service or guarantee recovery if the user's project/workspace is lost.

Use `doctor` and `status` in the actual selected project after setup. A configured file, recorded trust choice or simulated event must not be described as active native enforcement; rely on the returned current observation and its coverage limits.
