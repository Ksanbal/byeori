# Product model

Byeori separates editable proposals, human decisions and applied records. The files are the product history; the search index is a disposable projection of those records.

## The nine document kinds

Eight native YAML kinds provide fields for their domain: `prd`, `actor`, `scenario`, `feature`, `ia`, `screen`, `entity` and `architecture`. The ninth kind is standard OpenAPI 3.1.1, stored as OpenAPI and shown through a read-only structured projection. OpenAPI feature links use `x-byeori-features`; the stored document remains the source. Validation does not fetch remote `$ref` values.

## Draft to review

An assistant can create or update an active change's draft through the CLI. It cannot write approved planning source directly. Validation checks syntax, schema, IDs, references and readiness; passing structural validation does not establish that a plan is complete or correct.

`review prepare` freezes a numbered round with before/after content, metadata, decisions to be made, workspace binding and any offered implementation scope. Later draft edits require another round. Studio displays the frozen review. Feedback autosave is versioned and preserves a conflict copy; it does not finalize a review.

Only a person who sees the decisions and confirms submission in the authenticated Studio can create the durable review submission. Chat text such as “approved” or “review complete” is not a product approval. Pending, mixed or request-changes feedback is not full approval.

## Planning and implementation permissions

Applying an approved review updates planning source from the frozen snapshot. It is distinct from permission to modify code. Planning-only is the default. If implementation permission is requested, its exact file or directory allowlist, related planning IDs and validation plan appear in the frozen review and require explicit approval. A changed path or expanded scope needs a new review. The host gate separately checks current applied state and scope; unsupported host tools are outside the bounded adapter behavior.

## Durable records and cache

Project records include source documents, mutable drafts, frozen rounds, feedback, human submissions, responses, apply transactions/results, workflow context and implementation records. They are ordinary project files and can be versioned/backed up by the project owner. The `.byeori/` SQLite search index is disposable and can be rebuilt. The write-ownership record under `planning/.runtime/` is not disposable while an operation is live or uncertain.

Workflow context stores structured facts/answers, assumptions, open questions, focus and next action for restart/compact continuity. It is not a transcript store. See [Architecture](architecture-overview.md), the preserved [architecture contract](architecture.md), and [Verification](verification.md) for boundaries and evidence.
