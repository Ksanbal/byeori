# Architecture overview

Byeori packages a shared local runtime behind a CLI, a loopback Studio server and two host adapters. The shipped Claude and Codex payloads contain byte-identical CLI, hook and worker runtimes; their manifests, hook environment variables and skill names are host-specific.

## Runtime layers

- **Core** parses the supported YAML profile, validates documents and references, derives lifecycle state, owns durable workspace writes and applies gates. It uses a workspace binding and a shared writer lock for managed changes.
- **CLI** exposes bounded typed operations such as `init`, `doctor`, `status`, `search`, `get`, `impact`, `history`, `lint`, draft changes, review preparation/results, apply and recovery. It emits a structured result; it is not a generic file-write or approval interface.
- **Studio** is served from `127.0.0.1` and uses a local authenticated session for human review. It reads frozen content and sends bounded review operations. Browser feedback save, final submission and planning apply are separate actions.
- **Host adapters** translate documented Claude/Codex hook events into bounded Core requests and provide startup/resume/compact context. Product source controls what operations an adapter recognizes; unknown or unsupported operations do not become a general-purpose shell API.

## Persistence and review

The selected project contains `planning/source`, change drafts, immutable review rounds, submissions, responses, apply records and workflow. Content is YAML and remains available without the search cache. `.byeori/index.sqlite` is a rebuildable search projection. A workspace identity binds review and apply to the selected root/worktree; edits outside frozen implementation scope are not authorized by a planning approval.

Review rounds freeze the before/after documents, decisions, workspace binding and offered implementation scope. Only explicit human submission through Studio can finalize a judgment. Applying the approved planning snapshot is a separate operation. Hashes provide consistency checks, not cryptographic identity or tamper-proof protection against a same-user attacker.

## Search and records

Search uses exact identifiers/titles/aliases, SQLite FTS and bounded substring matching. It returns document records and provenance; rank scores are not confidence estimates. `impact` follows explicit planning relationships and does not establish code impact. History reads saved review/source snapshots, including prior content for deletions.

## Design and contract notes

Studio uses React, TypeScript, Vite, Tailwind 4 and shadcn/ui components. Its data diagrams are a visualization layer; controls, forms, comments and document text use ordinary accessible UI. See the existing [Studio design-system notes](design-system.md).

The longer [architecture contract](architecture.md) preserves implementation invariants and design details. Its task-stage statements describe the original contract; use [Verification](verification.md) for what has actually been exercised and what remains pending.
