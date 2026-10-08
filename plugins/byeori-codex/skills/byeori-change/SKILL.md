---
name: "byeori-change"
description: Investigate a requested planning or implementation change against approved documents and propose a scoped reviewable change.
---

Resolve the installed CLI via [commands](references/commands.md), then follow [continuity](references/continuity.md). Convert the user's request into bounded search queries in approved scope, get candidate documents and provenance, and inspect explicit owned/inverse impact plus relevant code read-only. Expand queries when useful, but do not equate BM25 with confidence or resolve an ambiguous request by choosing a nearby feature. Load only the relevant interview guide from the start skill's shared references.

Decide whether planning changes are needed. A spec_change states the request/reason and affected IDs and puts all necessary related YAML edits into the active draft. If approved planning already covers the requested implementation, an implementation_only change still needs a reason, related approved object IDs, exact file/directory allowlist and validation plan. Do not alter source to justify code already written. Review implementation scope explicitly even when documents do not change.

Use current binding and change version from actual results/history; CAS conflict means re-read, not force overwrite. Use change put/delete/move/update only for the proposed draft. Record assumptions/questions and next_action through versioned workflow write, validate the complete projection, and freeze for human review. Retain invalid draft text and expose diagnostics instead of claiming approval.

After genuine accepted complete approval, apply only that frozen after. Re-read status and gate check immediately before each protected code write; for enforced preflight generate a fresh UUID with the separate read-only crypto.randomUUID command in commands.md, then pass that actual literal as --hook-ticket on the documented gate invocation with the actual host, tool, operation and concrete paths. Documents approved, implementation permission, active protection and implementation completed are separate claims. A denied/unavailable gate blocks protected writing; advisory requires the user's explicit authenticated choice. Scope expansion or changed planning needs a new human review. Report code-impact coverage honestly; relationship traversal alone does not investigate code.
