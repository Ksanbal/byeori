# Installation, update and removal

**Release status:** The current release is the explicit prerelease `v0.1.0-rc.2`. Download the plugin ZIP or consumer tarball from [GitHub Releases](https://github.com/Ksanbal/byeori/releases); verify current asset digests and host limits in [Verification](verification.md).

Read [Verification](verification.md) for the latest Claude and Codex host-test evidence. A local install or hook discovery alone does not establish active enforcement.

## Runtime prerequisite

Packaged consumer runtime requires Node `>=24.13.0 <25`. The standalone CLI does not require pnpm, a project build or registry dependencies. Development uses pnpm `12.10.1`, which is not a consumer prerequisite.

For a local extracted release, run the included CLI directly:

```sh
BYEORI_CLI="/path/to/byeori-plugin/runtime/cli.mjs"
PROJECT="/path/to/project"
node "$BYEORI_CLI" --help
node "$BYEORI_CLI" doctor --root "$PROJECT" --json
node "$BYEORI_CLI" status --root "$PROJECT" --json
```

Initialization writes managed planning setup into the selected project:

```sh
node "$BYEORI_CLI" init --root "$PROJECT" --json
```

Check the result before continuing. The runtime reports Node, SQLite/FTS5, schema and write-access observations. Host `configured`, `trusted`, `probed` and `active` states are distinct; the CLI being available does not mean a native hook is active.

## Host installation

The root catalog is named `byeori-plugins`; its plugin entry is `byeori`. Use these marketplace commands to install the published `v0.1.0-rc.2` release. The earlier rc.1 marketplace installation was verified; current release evidence and native-host limits are separated in [Verification](verification.md).

Before updating or removing a plugin, close the owning host session and use an independent terminal. Start a fresh host session after the change. An observed Codex uninstall from an active protected chat left hook dispatch pointing at the removed runtime and blocked tools until the plugin was restored. Do not bypass the trust prompt or disable security controls.

### Claude Code

From the public repository marketplace:

```sh
claude plugin marketplace add 'Ksanbal/byeori#v0.1.0-rc.2' --scope user --json
claude plugin install byeori@byeori-plugins --scope user --json
claude plugin list
```

Claude Code asks the user to review/install the plugin at the chosen scope. Review hooks and their permissions before accepting. See the [official marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces) and [plugin command reference](https://code.claude.com/docs/en/plugins/cli-reference). To update the marketplace and plugin:

```sh
claude plugin marketplace update byeori-plugins
claude plugin update byeori@byeori-plugins
```

To remove the user-scope plugin, then the marketplace:

```sh
claude plugin uninstall byeori@byeori-plugins --scope user
claude plugin marketplace remove byeori-plugins
```

Use the scope where you actually installed it (`user`, `project` or `local`). Removing a marketplace also uninstalls its plugins. Claude Code plugin setup writes host settings; consult the host's current prompt and documentation before proceeding.

### Codex CLI

The command names below were observed in `codex-cli 0.161.0 --help`. It supports plugin commands `add`, `list`, `remove`, and marketplace commands `add`, `list`, `upgrade`, `remove` (not `install`/`uninstall`). The earlier rc.1 public marketplace install was verified; see [Verification](verification.md) for version-specific evidence and remaining native-host limits:

```sh
codex plugin marketplace add Ksanbal/byeori --ref v0.1.0-rc.2 --json
codex plugin add byeori@byeori-plugins --json
codex plugin list
```

To refresh the currently configured Git ref (this does **not** change a pinned release tag):

```sh
codex plugin marketplace upgrade byeori-plugins
```

To move an existing `v0.1.0-rc.1` installation to `v0.1.0-rc.2` with Codex CLI `0.161.0`, first stop all Byeori-using sessions and quit Codex Desktop. Run the following from an independent OS terminal, one command at a time; stop on any error:

```sh
codex plugin remove byeori@byeori-plugins
codex plugin marketplace remove byeori-plugins
codex plugin marketplace add Ksanbal/byeori --ref v0.1.0-rc.2 --json
codex plugin add byeori@byeori-plugins --json
codex plugin list --json
```

This version's [marketplace source matching](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core-plugins/src/marketplace_add/metadata.rs) includes the ref. [Adding a different source/ref under the same name](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core-plugins/src/marketplace_add.rs) is rejected while the prior marketplace remains installed. Do not run this replacement sequence inside an active protected chat. These commands affect only the named plugin/marketplace; project planning records are separate. The sequence is checked against the installed CLI help and official versioned source; an in-place upgrade of a user's live installation is not part of the release tests.

Confirm the reported version is `0.1.0-rc.2`, then relaunch Codex and reopen the same project/conversation. Invoke `$byeori-start` or `$byeori-change` and ask it to recover the saved workflow, active change and unanswered questions before continuing. Do not reinitialize the project or infer approval from conversation history. There is no verified hot-reload promise for the currently running session. Host trust prompts remain the user's decision.

To return to the previous release, use the same closed-session sequence with `--ref v0.1.0-rc.1`; do not overwrite release tags or manually patch the installed cache. Updating or rolling back the plugin does not rewrite `planning/hosts/codex.yaml`. If that project file contains an invalid advisory record, stop and arrange a separately authorized repair; installing this version cannot correct it. Advisory also continues to reject unknown operations.

To uninstall the plugin and then remove its marketplace:

```sh
codex plugin remove byeori@byeori-plugins
codex plugin marketplace remove byeori-plugins
```

These commands change user plugin configuration/cache when executed. Review the host's confirmation and current documentation. Do not treat hook discovery alone as proof that enforcement is active.

### Skills

The installed Claude Code skill entrypoints are `/byeori:init`, `/byeori:start`, `/byeori:change` and `/byeori:review`. In Codex, use `$byeori-init`, `$byeori-start`, `$byeori-change` and `$byeori-review`.

## Project guidance versus plugin removal

The CLI command `host remove` removes only Byeori-managed project instruction spans and host observations. It leaves planning, workflow, review and source records in place; it does not uninstall host plugins. Use the host's plugin-removal flow separately. Back up project records according to your project's normal policy before any manual cleanup. There is no general Byeori command that deletes the complete project planning history.

## Release source

Public source and releases: <https://github.com/Ksanbal/byeori>. See [Verification](verification.md) for the published tag, asset hashes, CI evidence and host limits.
