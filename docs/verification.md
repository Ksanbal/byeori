# Verification and support status

Release snapshot: 2026-10-08. The published `v0.1.0-rc.1` is an explicit prerelease, not a stable release. See [GitHub Releases](https://github.com/Ksanbal/byeori/releases/tag/v0.1.0-rc.1) and the [CI run](https://github.com/Ksanbal/byeori/actions/runs/37764471600) for the current artifacts and checks. This page separates verified distribution and consumer behavior from native behavior that remains unverified.

## Runtime and host support

| Area | Verified evidence and limits |
| --- | --- |
| Consumer runtime | Node `v24.13.0`; packaged CLI and Studio worked without pnpm, build tools, package installation or `node_modules`. |
| Development | Node `24.13.0`, pnpm `12.10.1`, frozen lockfile. Full local check passed 124 product tests, including policy tests; a separate 11-probe UI policy run repeats policy cases. See recorded checks below. |
| OS | Native host checks used macOS `27.0.1` (build `26A434`), Darwin kernel `27.0.0`, arm64. Release CI ran on Linux; local build/tests ran on macOS. Linux and Windows native host support were not verified. |
| Claude Code | Public marketplace install and plugin cache verification passed with Claude Code `2.1.294`, run from a verified temporary binary (not globally installed or added to `PATH`). Plugin-directory and marketplace validators passed without warnings; all 130 installed files matched the release payload. Auth readback was `loggedIn: false` / `authMethod: none`; authenticated model use, native hook activation and compact behavior were not tested. |
| Codex CLI | Public marketplace install passed with Codex CLI `0.161.0`. All 130 installed files matched the release payload; 42 other plugin entries and seven other marketplace entries were unchanged. TUI listed four skills and discovered both hooks. The human trust decision remains unanswered; active Core-gate enforcement is not claimed. |
| Remote CI | [Run 37764471600](https://github.com/Ksanbal/byeori/actions/runs/37764471600) passed 124 product tests, including policy tests, plus 11 separate UI policy probes that repeat policy cases. Do not count these as 135 unique tests. The Linux CI artifact and local macOS build archives matched the published assets. |

## Published release and anonymous consumer checks

Public tag `v0.1.0-rc.1` resolves to commit `c0fcae646d2a461c66e8dfa0045fc7f5a978743f`. Four assets were downloaded anonymously and verified:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `byeori-0.1.0-rc.1-plugins.zip` | 1,272,574 | `9825e013eafdd6166a70c387ada10c0a5675bdbdc2e6bba45f626b77cbad190c` |
| `byeori-0.1.0-rc.1.tgz` | 648,417 | `7c58ada8bc0f0fd2dbc4f2fe349caba51fffae6cff5b74bb1c91a400a6d19140` |
| `SHA256SUMS` | 184 | `9292bfe25d5ea8c4090e8477f0d9380d38d2a6c41e7602387365e69c04f8af60` |
| `VERIFICATION.md` | 4,743 | `4f8ebc078ec145d1c248542319c777588802b88494a5a5b72cfb67a4f1dd3316` |

An anonymous checkout verified 431 tracked source files and all 264 shipped payload hashes. Three fresh projects were tested from the single released plugin ZIP (Claude and Codex plugin directories) and tarball, each outside a Git repository and without `package.json` or `node_modules`. With Node `24.13.0` and no pnpm/build install, each passed CLI help, init, doctor, status, search, and Studio start/status/stop. Doctor confirmed SQLite FTS5; Studio served its HTTP assets and stopped cleanly. This verifies packaged consumer behavior, not native model workflows or human approval.

The matching installed skill entrypoints are Claude Code `/byeori:init`, `/byeori:start`, `/byeori:change`, `/byeori:review`, and Codex `$byeori-init`, `$byeori-start`, `$byeori-change`, `$byeori-review`. These names are present in the shipped host payloads. Their real task behavior was not covered by the release consumer smoke test.

## Recorded checks

The full local check completed on 2026-10-08 from 09:59:13.844Z to 10:01:29.657Z, exit 0. It reported 124/124 product tests, including policy tests, plus 11/11 separate UI policy probes that repeat policy cases; do not count these as 135 unique tests. It also passed lint, UI lint, TypeScript checking, deterministic release build and release verification for 264 payload files. It used Node `24.13.0` and pnpm `12.10.1`; the lock hash was `f16ab1b1f72697714a6c312a398808058f99681a08cf30feacbad2f4cf587cf7`.

Claude Code plugin-directory and marketplace validation passed without warnings. Public marketplace installation then succeeded at user scope and readback confirmed its GitHub source, release ref and 130 payload file hashes. The CLI itself ran from a verified private temporary executable, not a global install or PATH change. Auth remained absent; no authenticated model request was made.

Codex public marketplace installation and cache readback passed. The installed plugin was enabled from the GitHub tag, its 130 files matched the release payload, and the other 42 plugin entries and seven marketplace entries matched their pre-install inventory. TUI discovery showed the four skills and `SessionStart`/`PreToolUse` hooks. The host still awaits a human trust decision. A configured or dispatched hook is not evidence that the product's Core gate enforced an operation.

An earlier native `workspace-write` run of `init`, `doctor` and `status` exited `6` (`CAPABILITY_UNAVAILABLE`) when process identity could not be observed. Normal on-request execution was not tested, so that result does not establish behavior in other permission modes.

## Not established

- Codex hook trust approval, successful hook enforcement through the Core gate, per-command escalation results, and actual model-driven skill behavior were not tested. Native product compact/resume behavior was not tested.
- Claude authenticated model behavior, native hook activation and compact/resume remain unverified because the CLI was signed out.
- Human approval tests use synthetic fixtures; they do not replace an actual user decision in a real project.
- Actual LLM interview quality, agent adoption/search expansion, and remote GitHub response-loss recovery have not been verified.
- Linux and Windows native host support have not been verified. The passing Linux CI run is not native host support evidence.
- There is an incomplete independent server review. The completed local tests are not a substitute for that review.
- Development checkpoint fingerprints are not an independent durable backup. The build provides no hosted recovery service or guarantee if the user's project/workspace is lost.

For plugin updates or removal, close the owning host session and use an independent terminal, then relaunch the host session. The observed Codex uninstall inside an active protected chat removed the hook module while that chat kept dispatching to it, blocking tools until the plugin was restored externally. See [Installation](installation.md) for the safe update/remove sequence; do not bypass host trust or disable security controls.
