# Installed CLI and executable request recipes

The host provides the actual absolute path of this loaded SKILL.md. Resolve `../../runtime/cli.mjs` from the directory containing that file; it is inside this installed plugin, not relative to process cwd. Select the user's actual project/worktree separately. If the skill path/runtime cannot be located, report the missing installation instead of guessing an environment variable, borrowing development node_modules, changing project package.json, downloading latest packages or executing another release.

Invoke Node with an argument array: `node <resolved-cli.mjs> <command words> --root <actual-project-root> --json <flags>`. Quote paths/JSON as literal arguments when using a shell; never interpolate user/comment text into shell code. `--help --json` returns the executable command/flag reference without an initialized project. One Result JSON object is stdout; runtime logs are stderr. Continue only on the real ok:true result, respecting diagnostics and exit codes (validation2, approval/scope3, stale/conflict4, recovery5, capability6). CLI inputs are bounded1MiB plus OS argv limits and the safe profile; no input-file, generic source-write or agent approve command exists.

The JSON recipes below describe actual argv and request objects, not a separate runtime API. A `$value` is replaced as a whole value from actual results/user-confirmed context; serialize input with JSON.stringify as one --input argument. They are example request variables, not generator template substitutions. Never pass the literal placeholders or manufacture binding/CAS. Mutations return the new change version. After restart, read history's type:change entry for current version. Help lists change update/delete/move/cancel and their fields when those operations are needed.

```json recipe=init
{"command":["init"],"args":[]}
```
```json recipe=doctor
{"command":["doctor"],"args":[]}
```
```json recipe=status
{"command":["status"],"args":[]}
```
```json recipe=change-state
{"command":["history"],"args":["--change","$change_id"]}
```
```json recipe=search-approved
{"command":["search"],"args":["--query","$query","--scope","approved","--limit","5"]}
```
```json recipe=get-approved
{"command":["get"],"args":["--id","$object_id","--scope","approved"]}
```
```json recipe=impact-approved
{"command":["impact"],"args":["--id","$object_id","--scope","approved","--depth","1","--limit","25"]}
```
```json recipe=workflow-write
{"command":["workflow","write"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","expected_version":"$workflow_version","workflow":"$workflow"}}
```
```json recipe=create-change
{"command":["change","create"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","metadata":{"type":"spec_change","title":"$title","request":"$request","reason":"$reason","affected_object_ids":"$affected_object_ids","implementation_scope":"$implementation_scope"}}}
```
```json recipe=put-draft
{"command":["change","put"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","change_id":"$change_id","expected_version":"$change_version","object_id":"$object_id","kind":"$kind","path":"$path","raw":"$raw"}}
```
```json recipe=lint-change
{"command":["lint"],"args":["--scope","$change_scope","--stage","review_ready"]}
```
```json recipe=prepare-review
{"command":["review","prepare"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","change_id":"$change_id","expected_version":"$change_version"}}
```
```json recipe=review-results
{"command":["review","results"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","change_id":"$change_id","round":"$round","manifest_hash":"$manifest_hash"}}
```
```json recipe=respond
{"command":["review","respond"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","change_id":"$change_id","round":"$round","manifest_hash":"$manifest_hash","submission_id":"$submission_id","response_id":"$response_id","expected_change_version":"$change_version","comments":"$response_comments"}}
```
```json recipe=apply
{"command":["apply"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","change_id":"$change_id","round":"$round","manifest_hash":"$manifest_hash"}}
```
```json recipe=gate
{"command":["gate","check"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","host":"$host","tool":"$tool","operation":"$operation","paths":"$paths"}}
```
```json recipe=recover-inspect
{"command":["recover"],"input":{"project_id":"$project_id","workspace_fingerprint":"$workspace_fingerprint","change_id":"$change_id","action":"inspect"}}
```
```json recipe=studio-start
{"command":["studio"],"args":["--action","start"]}
```

Use implementation_scope `{ "allowlist": [], "related_object_ids": [], "validation_plan": [] }` when no implementation permission is requested. To request permission, specify exact file or directory entries `{ "path": "...", "match": "file"|"directory" }`, related approved object IDs and a real validation plan; implementation_only additionally requires all three nonempty. Responses use `{ "comment_id": "...", "result": "proposed"|"addressed_in_draft"|"needs_clarification"|"not_applied", "changed_paths": ["planning/source/...yaml"], "rationale": "..." }` for actual comments in this frozen round. Empty changed_paths is appropriate for a question/clarification without a document edit.

Studio start in a packaged release uses adjacent built assets. Open only its token-free loopback URL; never expose credentials, click submission on the user's behalf or call a private review endpoint from an agent. Human save/submit/advisory are absent from CLI. The user submits through Studio and signals completion in conversation; then status/results readback decides the next step.

Approved queries return documents with provenance/revision; change:<id> searches a draft and history:<id>[:round] searches immutable snapshots. Historical get requires the hit's explicit revision through --input. Empty/ambiguous hits do not infer approval or implemented features. Query expansion is distinct from deterministic exact/alias/FTS ranking; scores are not probabilities. Impact is bounded explicit relationships and code_impact remains not_investigated until code is separately inspected.
