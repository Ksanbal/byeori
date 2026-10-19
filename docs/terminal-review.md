# Human terminal review

The assistant interviews, reads/drafts plans and discusses the review in the Claude Code/Codex conversation. It prepares a frozen round and reports its manifest and exact implementation scope. Native question tools and WebFetch/WebSearch remain question/research operations, never authorization transports.

The person runs `node <plugin>/runtime/review.mjs --root <project>` directly in their own terminal shell. The ordinary agent CLI has no submit/approve/advisory command. The separate review executable is outside the hook's literal installed-CLI allowlist; unknown shell wrappers remain denied. Do not ask the agent to type answers or launch a PTY to operate this reviewer.

## Transport guard

The entry requires supported Node24, real TTY stdin/stdout/stderr and an OS-observed complete process chain on macOS/Linux. Before a supported terminal executable it accepts only same-user interactive shell/login processes on the same TTY. Native Claude/Codex ancestors, unknown wrappers, piped input, missing identity and unsupported terminals fail closed. The terminal executable must have trusted system ownership. Supported entries are explicitly enumerated in src/terminal/trust.ts; standard macOS Terminal and system-owned iTerm and common system Linux terminals are covered. A terminal embedded in an agent app, detached tmux/screen, npm wrapper or user-installed terminal may be refused. Run directly from a supported shell; never weaken the guard or change host trust/permissions to make it pass.

TTY/process ancestry is a bounded local transport check, not cryptographic proof of a physical person's keystrokes or a defense against a malicious same-user OS/filesystem controller. The hook also denies model execution of this entry. Actual human-terminal acceptance and each native host's guarded writes must be verified separately.

## Human decisions and persistence

The reviewer displays the exact frozen manifest, metadata, scope, deletions and before/after documents. Untrusted text is stripped of terminal control sequences so embedded instructions cannot repaint trusted prompts. Judgments/comments are saved with current feedback CAS. Empty input does not approve an item. Old comments are preserved unless the person explicitly changes them. Any non-approve or blocking feedback clears implementation consent.

After item review the person must explicitly choose planning-only or allow-implementation when complete approval and nonempty scope permit that choice. The latter binds only the exact frozen scope hash. A final manifest-bound confirmation records the immutable receipt. Pending/rejection can be submitted but grants no whole approval or implementation permission. The output distinguishes planning and implementation outcomes; apply and verified code remain separate operations.

Ctrl-C/quit/EOF before final submission leaves no final approval. Saved judgments can be resumed only for the same current frozen round; they are displayed again and require explicit continuation/permission/final confirmation. Stale base/metadata/snapshots, feedback conflicts or lost ownership stop with diagnostics. Final receipts are never edited. New intent needs a new frozen review or, after approved planning is applied, an implementation_only change with an explicit reason, related approved IDs, paths and validation plan.

Legacy studio_human_submit receipts remain readable. New receipts use terminal_human_submit. Neither historical provenance nor a conversation summary upgrades permission. Existing human-selected advisory state is preserved; the terminal reviewer offers no command to turn it on.

Before updating, preserve the checkout and planning records together. This local refactor leaves existing receipts byte-identical. An older runtime may refuse a later terminal_human_submit receipt; never rewrite its provenance or discard later human judgments to make a downgrade work. Restore into a separate folder for comparison, or retain a reader compatible with the newer receipts. Code rollback alone is not a migration of later user state.
