import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from '../contracts';

export function installedCliPath(): string {
  const self = fileURLToPath(import.meta.url);
  return self.endsWith('.mjs') ? path.join(path.dirname(self), 'cli.mjs') : fileURLToPath(new URL('../cli/main.ts', import.meta.url));
}
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function hooksConfig(host: HostId) {
  const variable = host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT';
  const invoke = `node "\${${variable}}/runtime/hook.mjs" ${host}`;
  return { hooks: {
    PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: invoke + ' || { printf "%s\\n" "Byeori hook failed; operation blocked. Check Node 24 and doctor." >&2; exit 2; }', timeout: 15 }] }],
    SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: invoke + ' || { printf "%s\\n" "Byeori resume unavailable. Read AGENTS.md and planning/workflow.yaml; run doctor and status before editing."; exit 0; }', timeout: 15 }] }],
  } };
}
