# Ask, wait, and resume an interview

Use this protocol for every missing user decision in start/change, clarification of review feedback, and planning resumed after init. Topic guides choose what to ask; this protocol chooses how to ask and when to continue. Questions collect planning input, never Studio approval or implementation permission. “AskTool” is a user-facing shorthand, not a callable API.

## 1. Recover context and choose the next question

Read [continuity](continuity.md) and [commands](commands.md) first. Reuse confirmed answers; inspect relevant documents/code before asking. Follow the start skill's PRD → actors/scenarios → features → architecture guidance, loading other topic guides only as needed. Do not restart completed stages or turn all nine guides into a questionnaire.

Ask one focused question at a time by default. Batch at most three independent questions; ask dependent follow-ups only after the earlier answer arrives. Use the user's language, a short header (at most 12 characters), and concrete choices with brief tradeoffs. Do not invent a recommendation without evidence. Accept custom free text; do not force it into the closest option. For a genuinely open question without useful choices, use an exposed tool that supports free text without options, or ask in chat instead of inventing choices to satisfy a schema.

Before asking, preserve the pending question's stable ID, text and blocking flag in workflow.open_questions, current focus, and a next_action naming the question and that it is awaiting user input. Use workflow write with fresh workflow.version and preserve unrelated fields. Keep only necessary nonsecret context. If the active mode prohibits writes (for example Plan mode), retain this checkpoint in the conversation, say it is not durable yet, and persist it when writes are permitted; never change mode or permissions to force a checkpoint.

## 2. Call the actual host question tool

Inspect the current session's exposed tools, their schemas and mode restrictions. Call the matching tool when available and allowed; printing JSON or a question in prose is not a tool call. Do not install an MCP, change host configuration, hook trust or collaboration mode to obtain a question UI. A tool failure does not authorize those changes.

- **Claude Code:** call `AskUserQuestion` with `questions` containing `question`, `header`, `options` (`label`, `description`) and `multiSelect`. Use 2–4 meaningful options; keep `multiSelect: false` unless multiple choices can apply together. The native UI permits a custom answer. Do not add a duplicate Other choice. Its maximum is four questions, but Byeori batches at most three. If unavailable in a subagent, leave the question for the user-facing parent instead of answering for the user.
- **Codex:** use the exposed `request_user_input` only when its current tool description and active mode allow it. Some hosts expose it only in Plan mode; others enable it in Default mode. Do not assume either mode is always supported or switch modes automatically. Use `questions` with stable snake_case `id`, `header`, `question` and 2–3 mutually exclusive `options` (`label`, `description`). Follow the live schema's recommendation rule when a supported recommendation exists. The client supplies free-form Other; do not add Other or Claude's `multiSelect` field. If no defensible recommendation fits a required recommendation rule, ask neutrally in chat. Map returned answers by question ID.
- **Codex asynchronous input:** if `request_user_input_async` is actually exposed and permitted, it can be used when the synchronous tool is unavailable or for free-text-only questions. Its question objects use `title` and optional string-array `options`, not the synchronous schema. The immediate tool return is only delivery acknowledgment; the answer arrives as a later user message. Keep the decision pending and end the turn while waiting. A preselected choice is not a submitted answer. Do not assume this app-specific tool exists in Codex CLI.
- **Unavailable or rejected tool:** if absent, mode-restricted, unsupported, or errored, present the same question and numbered choices in chat, explicitly allow a custom answer, and end the turn awaiting the user's reply. For noninteractive execution, report that user input is needed and stop the dependent work. Do not repeatedly retry an unavailable tool or silently select a default.

These are synthetic call shapes, not real project questions or user answers. Replace their content with the current question and use only the live host's supported fields.

```json tool=AskUserQuestion
{"questions":[{"question":"Which channel belongs in the first version?","header":"Scope","options":[{"label":"Text only","description":"Keeps the first version small."},{"label":"Text and files","description":"Adds upload and retention requirements."}],"multiSelect":false}]}
```

```json tool=request_user_input
{"questions":[{"id":"version_channel","header":"Scope","question":"Given the confirmed small first-version scope, which channel should it include?","options":[{"label":"Text only (Recommended)","description":"Fits the confirmed small scope."},{"label":"Text and files","description":"Expands scope to upload and retention."}]}]}
```

```json tool=request_user_input_async
{"questions":[{"title":"What outcome should the first version achieve?"}]}
```

## 3. Wait and interpret the response

Do not draft decisions, move to a dependent interview stage, prepare review, apply, or implement based on a pending answer. A tool returning successfully, a timeout, empty/missing/whitespace-only answers, auto-resolution, a highlighted default, or elapsed time is not a user decision or approval. Keep unanswered questions open. If the tool returns without an answer, use the chat fallback once and end the turn; do not loop or infer assent.

For partial batches, record only the explicit answers and keep the remaining IDs pending. Reconcile free text and multiple selections with the question; if the response is ambiguous or contradicts a confirmed fact, clarify before changing that fact. A user correction supersedes the prior answer only for the affected decision. Do not re-ask resolved unrelated questions.

On explicit pause, stop, cancellation or a dismissed/cancelled question, preserve confirmed answers and the unresolved question, mark next_action as paused, and end the turn. Do not immediately reopen the same question through a fallback or erase drafts. On explicit skip/“I don't know,” leave the question unresolved; proceed only with independent, already-confirmed work if the user requests it. A blocking question continues to block dependent drafting and review readiness. Resume only on a later user request, re-read status/current workflow CAS, and continue from the unresolved question. Do not promise a background wakeup or poll for an answer.

## 4. Record and continue

After an explicit answer, summarize its necessary nonsecret meaning in workflow.facts with its question ID, remove only that answered entry from workflow.open_questions, preserve assumptions and unrelated fields, and update focus/next_action using fresh CAS. If a write conflicts, re-read and merge instead of overwriting another answer. If writes are prohibited, retain the answer in the conversation and disclose that persistence is pending. Never fabricate facts from sample payloads, defaults or silence.

Only then ask the next relevant question or draft the confirmed planning with change put and lint. Keep unresolved blocking questions visible in the affected document's open_questions as well as the workflow; do not prepare review until they are resolved. Interview answers, including “yes,” do not approve a frozen review. Human review remains an explicit Studio submission followed by durable status/results readback; implementation still requires the existing authorization and gate checks.

## Host contract evidence

Checked 2026-10-12: [Claude Code user-input documentation](https://code.claude.com/docs/en/agent-sdk/user-input) describes AskUserQuestion and free-text answers. [Codex tool schema](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs) and [handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs) define its question fields and runtime mode checks. The async shape above comes from the exposed Codex app tool contract, not a portable CLI API. The live session contract takes precedence over examples here. Static payload/packaging tests do not prove native UI rendering or model compliance; exercise those in an authenticated interactive host separately.
