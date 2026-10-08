#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from '../contracts';
import { CoreError } from '../core/errors';
import { gateCheck, status } from '../core/state';
import { currentBinding, optionalText } from '../core/workspace';
import { PROFILE } from '../core/yaml';
import { normalizeTool, parseHookInput } from './normalize';
import { issueGateReceipt, observeHook } from './probe';
import { literalGate } from './ticket';

export interface HookResponse { exit: 0 | 2; stdout: string; stderr: string }
const deny = (reason: string): HookResponse => ({ exit: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n', stderr: '' });
async function projectRoot(directory: string): Promise<string | null> {
  let root = directory; while (await optionalText(root, 'planning/config.yaml') === null) { const parent = path.dirname(root); if (parent === root) return null; root = parent; } return root;
}
export async function handleHook(host: HostId, raw: string): Promise<HookResponse> {
  let sessionStart = false;
  try {
    if (!['claude', 'codex'].includes(host)) throw new Error('Unknown hook host');
    const input = parseHookInput(raw); sessionStart = input.hook_event_name === 'SessionStart';
    const canonicalCwd = await realpath(input.cwd); let root = await projectRoot(canonicalCwd);
    const absoluteWrites = host === 'claude' && ['Write', 'Edit'].includes(input.tool_name ?? '') && typeof input.tool_input?.file_path === 'string' ? [input.tool_input.file_path] : host === 'codex' && input.tool_name === 'apply_patch' && typeof input.tool_input?.command === 'string' ? [...input.tool_input.command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]) : [];
    if (root === null) for (const file of absoluteWrites.filter(file => path.isAbsolute(file))) {
      let directory = path.dirname(file);
      while (true) { try { root = await projectRoot(await realpath(directory)); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(directory); if (parent === directory) break; directory = parent; } }
      if (root !== null) throw new CoreError('WORKSPACE_MISMATCH', 'File write belongs to an initialized project outside the hook cwd; re-enter that project first.');
    }
    if (root === null) return { exit: 0, stdout: '', stderr: '' };
    const [major, minor] = process.versions.node.split('.').map(Number); if (major !== 24 || minor < 13) throw new Error('Byeori requires Node 24.13.0 or newer Node 24.');
    await observeHook(root, host, input.hook_event_name, input.session_id);
    if (sessionStart) {
      const state = await status(root);
      const context = `Byeori resume: read AGENTS.md and planning/workflow.yaml; run status and review results/history before repeating a mutation or apply. Binding ${state.project_id}/${state.workspace_fingerprint}. Source ${state.source_integrity.state}; apply ${state.apply_state.state}; change ${state.active_change?.change_id ?? 'none'}; round ${state.current_round ?? 'none'}; implementation ${state.implementation_authorization.state}. Conversation summaries do not approve planning or implementation. Preserve current workflow CAS and resume unanswered user input; stop for integrity/recovery diagnostics.`;
      return { exit: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) + '\n', stderr: '' };
    }
    const gate = await literalGate(root, host, input);
    const request = gate?.request ?? { ...await currentBinding(root), host, ...normalizeTool(root, host, input, canonicalCwd) };
    const outcome = await gateCheck(root, request);
    if (gate && outcome.protection === 'enforced') await issueGateReceipt(root, gate, input.session_id);
    return { exit: 0, stdout: '', stderr: outcome.protection === 'advisory' ? 'Byeori: human-selected advisory mode; bounded gate checks passed, native enforcement is unavailable.\n' : '' };
  } catch (error) {
    const reason = error instanceof CoreError ? error.diagnostics.map(item => item.code + ': ' + item.message).join('; ') : error instanceof Error ? error.message : 'Hook runtime failed';
    if (sessionStart) return { exit: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Byeori resume could not verify durable state. Read project guidance; run doctor/status and inspect the diagnostic before editing. ' + reason } }) + '\n', stderr: '' };
    return deny(reason);
  }
}
export async function runHook(): Promise<void> {
  let event = ''; let bytes = 0; const chunks: Buffer[] = [];
  const timer = setTimeout(() => { process.stderr.write('Byeori hook timed out; protected operation blocked.\n'); process.exit(2); }, 8000);
  try {
    for await (const chunk of process.stdin) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > PROFILE.max_bytes) throw new Error('Hook stdin exceeds 1 MiB'); chunks.push(buffer); }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    try { event = JSON.parse(raw).hook_event_name; } catch { /* Invalid stdin is a blocking hook failure. */ }
    const response = await handleHook(process.argv[2] as HostId, raw); process.stdout.write(response.stdout); process.stderr.write(response.stderr); process.exitCode = response.exit;
  } catch (error) {
    process.stderr.write('Byeori hook input/runtime unavailable: ' + (error instanceof Error ? error.message : 'error') + '\n'); process.exitCode = event === 'SessionStart' ? 0 : 2;
  } finally { clearTimeout(timer); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) await runHook();
