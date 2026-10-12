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

For automatic updates, register a moving branch such as `Ksanbal/byeori#release` instead of a fixed tag, then enable auto-update for `byeori-plugins` in `/plugin` → Marketplaces. Third-party marketplaces default to auto-update off. See the [official update guide](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated); follow the host reload prompt after an update. Existing fixed-tag sources do not advance by themselves.

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

To follow tested releases, use the `release` branch instead of a fixed version tag. It includes explicit prereleases; it is not a promise of stable/native-host support. For a **new** installation, use `--ref release` in the marketplace-add command above. An existing fixed-tag installation needs a one-time configuration change, not removal/reinstallation.

Quit Codex and use an independent terminal. Back up `~/.codex/config.toml`, then change only `ref` in its existing `[marketplaces.byeori-plugins]` section:

```toml
ref = "release"
```

Keep all other settings intact; do not add a duplicate section. To stay pinned instead, set `ref = "v0.1.0-rc.2"`. Then explicitly refresh and inspect the installed version:

```sh
codex plugin marketplace upgrade byeori-plugins --json
codex plugin list --marketplace byeori-plugins --json
```

Codex 0.161.0's [startup path](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/app-server/src/message_processor.rs#L544-L563) starts background Git marketplace upgrades when plugins are enabled. Its [upgrade implementation](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core-plugins/src/manager.rs#L2811-L3019) also refreshes installed plugin caches. This is a startup check, not a guaranteed polling interval or immediate hot reload. Fixed tags remain fixed; GitHub's Latest release label does not select a new Git ref. Network or host-policy failures can leave an update pending. See the official [ref configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

Start a fresh session after the update. Invoke `$byeori-start` or `$byeori-change` to recover saved workflow, active change and unanswered questions before continuing. Do not reinitialize the project or infer approval from conversation history. Changed hook definitions may need a new trust review; downloading a plugin does not grant that trust. See [Codex plugin loading](https://learn.chatgpt.com/docs/plugins) and [hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

To return to an older release, change the same `ref` to its immutable tag and run the same closed-session refresh. Do not move published tags or manually patch the installed cache. Updating or rolling back does not rewrite `planning/hosts/codex.yaml` or repair an invalid advisory record. Project protection and trust changes require separate decisions.

Maintainers update the channel only after the published tag passes verification; see [Release promotion](releasing.md). The initial channel commit is the verified `v0.1.0-rc.2` release.

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
