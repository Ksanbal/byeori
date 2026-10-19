# Architecture overview

Byeori has a shared local Core, an agent CLI, a human terminal reviewer, and Claude/Codex hooks. Both plugins carry identical cli.mjs, review.mjs and hook.mjs runtimes plus offline schemas. There is no listener, worker daemon, HTTP API or browser UI.

- Agent CLI: typed draft/workflow operations with binding/CAS, freeze, search, history, results, apply and gates. It cannot submit human approval.
- Human terminal: displays immutable before/after documents, purpose, deletions and exact implementation scope. Direct TTY and process-chain checks precede every feedback write. Explicit final submission is separate from saved judgments.
- Core: validates documents, scope, identity, fresh review, semantic hashes, final receipts, source chain and journaled apply/recovery. Terminal and agent transports share these services.
- Hooks: classify only bounded supported native operations, re-observe actual native enforcement for protected writes, and check every source/destination. A human receipt alone does not establish host activation.

The person can discuss plans and answer interviews in either host conversation. The final reviewer is deliberately separate from an agent-invoked command so the agent cannot manufacture its own authorization. [Terminal review](terminal-review.md) defines this boundary; [detailed invariants](architecture.md) cover persistence, source integrity, ownership, scope and recovery.

Legacy receipt provenance is retained only for compatibility with existing immutable records. It does not restore a removed transport or promote a false permission. Planning/cache paths, journals and workflow survive the transport change.
