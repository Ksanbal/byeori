---
name: "byeori-start"
description: Interview the user and draft or resume a project's planning documents before human review.
---

Resolve the installed CLI using [commands](references/commands.md), select the real project/worktree and follow [continuity](references/continuity.md). Read status and the existing workflow before interviewing again. Preserve confirmed facts, labeled assumptions, open questions, focus and next_action with workflow write and its current CAS version; do not invent user decisions or store secrets/full conversations.

Ask a few focused questions that change the next decision. Usually start with [PRD](references/interviews/prd.md), then [actors](references/interviews/actor.md) and [scenarios](references/interviews/scenario.md), [features](references/interviews/feature.md), and an [architecture](references/interviews/architecture.md) draft. Load [IA](references/interviews/ia.md), [screens](references/interviews/screen.md), [entities](references/interviews/entity.md) or [OpenAPI](references/interviews/openapi.md) only when needed. Adjust related documents together; this order is guidance, not a requirement to finish every document before continuing.

Use existing approved search→get→impact and read-only code evidence where relevant. Missing/ambiguous results stay unknown or require clarification; natural-language query expansion is the agent's reasoning, not evidence of engine semantic search. Write YAML through change put, never planning/source directly. Keep unanswered blocking questions visible. Reacquire change CAS from history's type:change record after a pause; inspect draft diagnostics and lint the complete change.

When review-ready, freeze with review prepare and start Studio. Explain the frozen changes and any implementation scope. Ask the user to submit their review there and tell you when finished; end this turn while waiting. Do not poll, auto-click approval, promise a future wakeup or treat conversational “review done” as approval. Resume by reading durable status/results.
