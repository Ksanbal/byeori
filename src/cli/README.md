# Byeori CLI

Development: `node --import tsx src/cli/main.ts <command> --root <workspace> --json`.
Release payload: `node <plugin-root>/runtime/cli.mjs ...` (B10 supplies the bundle).
All commands emit exactly one Result JSON object on stdout; Node/runtime diagnostics use stderr. Exit codes follow the shared diagnostic contract. Command words precede flags. Flags cannot repeat; unknown arguments fail.

Built-in `help` or `--help` returns the complete bounded command/flag reference in the same JSON envelope, without an initialized workspace.

Simple commands: `init [--name <name>]`, `doctor`, `status`, `search --query <text> [--scope <scope>] [--limit <1..25>] [--kinds <comma-separated-kinds>]`, `get --id <id> [--scope <scope>]`, `impact --id <id> [--scope <scope>] [--depth <1..5>] [--limit <1..100>]`, `history [--id <id>] [--change <id>] [--limit <1..100>] [--cursor <offset>]`, `lint [--scope <scope>] [--stage structural|review_ready|implementation_ready]`, `index rebuild [--scope <scope>]`, `studio --action start|status|stop`. Studio start additionally accepts a trusted built `--assets <directory>` and `--port <0..65535>`; default0 lets the OS allocate a loopback port.

Scopes: `approved` (default), `change:<id>`, `history`, `history:<id>`, `history:<id>:<round>`. History get needs `get --input '<JSON GetRequest with frozen revision>'`; impact accepts current approved/projected scopes. Structural and review_ready currently use the same full schema/reference/relationship validator; implementation_ready additionally checks blocking questions.

Complex commands use exactly one `--input '<JSON object>'`, maximum1MiB, with the matching shared request fields: `change create`, `change update`, `change put`, `change delete`, `change move`, `change cancel`, `review prepare`, `review results`, `review respond`, `workflow write`, `apply`, `recover`, `gate check`. Required fields are defined by src/contracts/api.ts. Unknown/missing top-level fields, duplicate JSON keys, invalid JSON/depth/numbers fail. Put uses a literal raw YAML string in JSON; no arbitrary input-file, SQL, shell or generic write helper exists. Obtain project_id/workspace_fingerprint and current version/hash from status/review results; supply them unchanged. CLI never manufactures approval, review submission or advisory selection.

Init delegates to the existing Core idempotent workspace/ignore initialization and preserves existing files. Native adapter instruction/hook managed blocks are supplied later by B09. Doctor probes real Node/FTS5/schema compatibility, write access and present root AGENTS.md/CLAUDE.md, and reports separate durable Claude/Codex configured/trusted/probed/active state. It never infers activation from CLI presence.

Studio forks the trusted worker over IPC and detaches after readiness. Status/stop prove durable native process and endpoint ownership; stop never signals a PID. Failed/timed-out readiness requires inspection before retry. Development defaults to repository dist; release uses adjacent worker.mjs and studio/ assets. B10 must include those files beside cli.mjs; consumers require no pnpm/build. No runtime secret is printed.
