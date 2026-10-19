# Product model

The nine structured planning kinds are PRD, actor, scenario, feature, architecture, IA, screen, entity and OpenAPI. Their purpose, stable IDs, relationships, questions, schema validation and offline references are unchanged. Screen plans describe the user's product; removing Byeori's review website does not remove that planning kind or external web research.

A mutable change holds draft documents and metadata. `review prepare` freezes a numbered manifest, before/after snapshots, document and implementation-scope items, workspace identity and hashes. Later semantic changes need a fresh round. The human-only terminal reviewer records per-item judgments/comments with CAS, then an explicit immutable final submission. Saved feedback and conversation text are not final approval.

Full approval requires all items approved, no blocking feedback and valid current snapshots/base/metadata. Planning approval permits a separate normally completed apply. Implementation additionally requires a nonempty exact reviewed allowlist, related planning, validation plan, resolved implementation-blocking questions, explicit allow-implementation consent and current actual host coverage for each write.

Pending/rejection, planning-only, stale scope or absent native protection never grants code permission. Existing receipts are read without rewriting their provenance or permission. Immutable submissions cannot be amended; a new human decision requires a new frozen review. Workflow retains facts, assumptions, unanswered questions and bounded correction progress across resume.
