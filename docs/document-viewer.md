# Read-only document viewer

The optional local viewer makes planning documents easier to read and navigate. It uses the genuine pinned [Cloudflare Kumo](https://kumo-ui.com/installation/) components with React and Kumo's precompiled standalone CSS. All browser code, styles and icons are bundled locally; opening the viewer does not fetch a CDN, font service, analytics service or Notion API.

## Start and stop

From an extracted plugin or consumer package, with supported Node `>=24.13.0 <25`:

```sh
node /path/to/byeori/runtime/viewer.mjs --root /path/to/project --port 4317
```

Open the loopback URL printed by the process in a modern browser. `--root` selects the existing project and `--port` selects the local listening port; use `--port 0` to allocate an available port. Stop the process with Ctrl-C. The viewer does not initialize projects or create a planning cache. No consumer dependency installation or build is required.

For contributors in this repository:

```sh
pnpm install --frozen-lockfile
pnpm viewer --root /path/to/project --port 4317
```

`pnpm viewer` builds the browser assets and runs the separate TypeScript viewer entry. `pnpm build:viewer` writes only generated `dist/viewer/` assets. `pnpm build:release` includes the standalone Node entry and byte-identical assets in both host payloads. These developer builds change generated build files, never the selected project's planning records.

## Read and navigate

- Choose current `planning/source` or a specific saved change set with the document-source selector. Draft sets are shown independently, never overlaid onto current source or represented as approved
- All nine document-kind tabs stay visible, including empty kinds with descriptions: PRD, actors, scenarios, feature specifications, IA, screens, entities, API and architecture
- Search by ID, title, path or document content; select a document to read its structured sections
- Invalid or incomplete saved draft puts remain visible with validation warnings and raw YAML; move/delete entries are shown as recorded operations, never executed
- Follow document relationship links to move between connected planning objects
- IA nodes use explicit `parent_id` hierarchy, with nested outline subitems and a left-to-right tree. Architecture components use only explicit source connections
- Select a card in the two-dimensional document map to open the document inspector; switch its tabs between readable content and raw YAML. The map is a browsing aid, not approval evidence
- Use Tab and Shift-Tab to move through controls, Enter or Space to activate focused buttons, and the native arrow-key behavior of the tabs
- Press Cmd-K or Ctrl-K to focus search. With the map focused, arrow keys pan, + and - zoom, and 0 fits the map. The map also has labeled controls and keyboard-focusable document nodes
- Selected source/change set, kind, document and element are reflected in the URL hash; use browser Back/Forward to revisit selections or bookmark the local URL while the same viewer is running
- Read empty, missing and invalid-document notices before relying on a view

The source selector keeps provenance, recorded lifecycle status and version visible. `review-recorded`, `applied-recorded` and `cancelled-recorded` describe records found on disk; they are not independent verification of approval or source integrity. Historical change sets retain their own persisted draft contents, without mixing in current source. A reference outside the selected set remains unresolved in that view.

The viewer does not display frozen review snapshots, verify final approval receipts, or establish an approved baseline. A source document is not inherently approved merely because it is visible or schema-valid. Use the protected terminal reviewer and CLI review results to inspect approved/frozen records and current authorization. A stale or invalid source binding must not be treated as a current approved baseline. The viewer never converts source content or navigation choices into judgments.

## Security and approval boundary

The server binds to the loopback interface only. It accepts a narrow read-only route set and rejects mutation methods, foreign origins and unsafe paths. It does not expose arbitrary project files or accept an arbitrary filesystem path from a document request. It reads known planning locations with containment and symlink checks, bounded input and no directory creation.

The viewer has no editing, review-feedback, submission, apply, workflow mutation, approval, advisory-mode or permission-change action. It cannot replace the protected human terminal reviewer. The person still runs `node /path/to/byeori/runtime/review.mjs --root /path/to/project` directly in a supported terminal for final judgments and confirmation. Existing host hooks, review guards, immutable receipts and implementation-scope checks remain in force.

Planning text is rendered as text and structured UI; document-provided markup or scripts are not executed. The local process can read project planning content. Loopback access is not authentication: other local processes and OS users able to connect to the port can read it. Stop the process when finished and do not expose or reverse-proxy its port to a public network. Filesystem hashes check consistency; they do not defend against a malicious same-user filesystem writer.

## Notion migration backlog

Notion import, export, synchronization and replacement of Notion-managed planning are not implemented. Future work requires a separately reviewed mapping of Notion pages, blocks, databases and relations to stable planning IDs; attachment and rich-text handling; explicit source-versus-approved provenance; a dry-run conflict report; and a user-approved migration/rollback plan. Browser readability and the 2D map do not imply that migration has occurred.

## Verification

`pnpm check` includes the viewer build, TSX/browser typechecking, server and catalog tests, release allowlist tests, and relocated packaged-runtime checks alongside the existing protected-review and Core suites. `pnpm pack:release` followed by `pnpm verify:release -- --archives` verifies consumer archives. React/Kumo DOM interaction tests cover source switching, hierarchy, raw YAML, incomplete drafts, search, navigation, refresh failure and stale requests. Map rendering is bounded to 1,000 nodes, 2,000 edges and 32 hierarchy levels; the outline is bounded to 200 root-first nodes. Visible notices disclose truncation, while full retained content remains inspectable in the document detail and raw YAML. Real-browser visual/interaction checks and positive native human-terminal/host acceptance are separate evidence; passing automated checks does not establish them.
