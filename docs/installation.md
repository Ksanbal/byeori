# Installation, update and removal

**Release status:** The intended public prerelease is `0.1.0-rc.1` (tag `v0.1.0-rc.1`), not stable `0.1.0`. Generated package metadata still says `0.1.0`; it must be regenerated before publication.

**Native status:** Claude Code `2.1.294` binary provenance and both local plugin-directory and marketplace validation passed. The CLI's auth status was `loggedIn: false` / `authMethod: none`, so authenticated model-session, native hook activation and compact checks are blocked. Codex CLI `0.161.0` successfully registered the local marketplace and installed the plugin; the native TUI displayed its four skills. This is local registration/cache evidence, not a public GitHub marketplace install. `/hooks` showed pre-existing user hooks but no Byeori hook source, so hook activation/enforcement remains unverified. Native `init`, `doctor` and `status` in ordinary `workspace-write` each exited `6` (`CAPABILITY_UNAVAILABLE`) because the process could not observe start/boot identity. A normal-permission-flow investigation did not establish a resolution. The public repository and release are not yet confirmed. The public-source commands below remain candidate instructions. See [Verification](verification.md).

## Runtime prerequisite

Packaged consumer runtime requires Node `>=24.13.0 <25`. The standalone CLI does not require pnpm, a project build or registry dependencies. Development uses pnpm `12.10.1`, which is not a consumer prerequisite.

For a local extracted release, run the included CLI directly:

```sh
node <plugin-root>/runtime/cli.mjs --help
node <plugin-root>/runtime/cli.mjs doctor --root <project-directory> --json
node <plugin-root>/runtime/cli.mjs status --root <project-directory> --json
```

Initialization writes managed planning setup into the selected project:

```sh
node <plugin-root>/runtime/cli.mjs init --root <project-directory> --json
```

Check the result before continuing. The runtime reports Node, SQLite/FTS5, schema and write-access observations. Host `configured`, `trusted`, `probed` and `active` states are distinct; the CLI being available does not mean a native hook is active.

## Candidate host installation after publication and native verification

The root catalog is named `byeori-plugins`; its plugin entry is `byeori`. The following sequences are derived from the bundled catalogs and each host's documented marketplace commands. They are examples for the future public source, not completed installation instructions for the current provisional build.

### Claude Code

From the public repository marketplace:

```sh
claude plugin marketplace add Ksanbal/byeori#v0.1.0-rc.1
claude plugin install byeori@byeori-plugins --scope user
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

The command names below were observed in local `codex-cli 0.161.0 --help`; the local marketplace registration and plugin cache installation have passed. Before install, 42 existing plugin entries were present; all 42 were preserved and the total became 43. All 130 cached plugin files matched the exported local plugin. The native TUI displayed the four Byeori skills. This did not test the GitHub remote path. The CLI reported plugin commands `add`, `list`, `remove`, and marketplace commands `add`, `list`, `upgrade`, `remove` (not `install`/`uninstall`):

```sh
codex plugin marketplace add Ksanbal/byeori --ref v0.1.0-rc.1
codex plugin add byeori@byeori-plugins
codex plugin list
```

To refresh the Git marketplace and uninstall the plugin:

```sh
codex plugin marketplace upgrade byeori-plugins
codex plugin remove byeori@byeori-plugins
codex plugin marketplace remove byeori-plugins
```

These public-source Codex commands will change user plugin configuration/cache when executed. Review the host's confirmation and current documentation. The Byeori GitHub marketplace add/install/update/remove sequence has not been run. In the observed native TUI, `/hooks` listed the pre-existing user hook file (`~/.codex/hooks.json`) and no Byeori source. Do not treat the installed plugin or visible skills as proof that its hook loaded or that enforcement is active.

## Project guidance versus plugin removal

The CLI command `host remove` removes only Byeori-managed project instruction spans and host observations. It leaves planning, workflow, review and source records in place; it does not uninstall host plugins. Use the host's plugin-removal flow separately. Back up project records according to your project's normal policy before any manual cleanup. There is no general Byeori command that deletes the complete project planning history.

## Release source and install status

Planned source: <https://github.com/Ksanbal/byeori>. Repository visibility, exact release assets and remote installation have not been verified. The intended version/tag is `0.1.0-rc.1` / `v0.1.0-rc.1`; generated package metadata still requires regeneration before publication.
