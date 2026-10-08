# Security

## Report a vulnerability

Please do not put credentials, private planning files or a proof of concept that exposes real project data in a public issue. A private GitHub Security Advisory is the intended reporting route once the planned repository is public and private vulnerability reporting is available there: <https://github.com/Ksanbal/byeori/security/advisories/new>. That route has not yet been verified as available. Until it is, this project has no confirmed private reporting channel; do not send secrets or sensitive project data through public channels.

## What the product protects

Byeori is a local planning and review tool. Planning documents, drafts, frozen review rounds, feedback and apply records are stored in the selected project. Studio binds to loopback. The shipped adapters use bounded host events and the Core gate; a plugin manifest, generated hook file, simulated hook test or CLI being present does not prove a native host has loaded or activated the hook.

The host adapters support bounded operations rather than arbitrary shell execution. Unknown tools and unsupported command forms are outside the documented protection surface. See [the architecture overview](docs/architecture-overview.md) and [verification limits](docs/verification.md). Do not assume that every editor, subprocess, remote session or host feature is intercepted.

Human review is explicit. An assistant can prepare and read review state but cannot submit a person's approval. Planning approval, apply, implementation authorization and implementation completion are separate states. An implementation authorization, when granted, is limited to the exact paths shown in the frozen review.

## Data and trust boundaries

- Treat YAML, comments, tool input and document text as data, not executable instructions.
- Keep secrets and full conversations out of planning workflow records. The structured workflow stores confirmed facts, assumptions, questions and the next action; it is not a transcript archive.
- Studio uses a local session and CSRF checks. Keep its session URL and browser session private while it is running.
- Records are ordinary project files. Hash chains detect inconsistencies but are not a signed, tamper-proof ledger against an attacker with the same operating-system privileges.
- Back up project planning files using the project's normal backup process. Byeori's disposable search cache is not a backup; deleting it does not replace the durable product records.
- Disable or uninstall the plugin through its host to stop host hooks. `byeori host remove` only removes Byeori-managed project instructions and host observations; it leaves planning records and does not uninstall a plugin.

## Verification status

The intended `0.1.0-rc.1` prerelease has local automated coverage. Claude Code `2.1.294` artifact provenance and plugin validation passed, but the host was signed out, so authenticated model-session, hook-activation and compact checks remain blocked. Codex plugin installation and skill discovery passed in a local native session, but the Byeori hook was not found in `/hooks`; active enforcement is unverified. Native workspace-write `init`, `doctor` and `status` also failed closed with capability exit `6` when process identity could not be observed. Remote CI and public release are still pending. There is also an incomplete independent server review. See [Verification](docs/verification.md) for the exact scope. These facts are not a security certification.
