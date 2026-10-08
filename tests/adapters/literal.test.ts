import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ChangeRecord, ContinuityStatus, HostId, Result, ReviewResults, ReviewRound } from '../../src/contracts';
import { roundBinding } from '../../src/core/review';
import { createHumanReview } from '../../src/core/services';
import { currentBinding } from '../../src/core/workspace';
import { semanticHash } from '../../src/core/yaml';
import { installedCliPath, shellQuote } from '../../src/adapters/config';
import { literalWords, normalizeTool, type HookInput } from '../../src/adapters/normalize';
import { literalGate } from '../../src/adapters/ticket';

const run = promisify(execFile); const repository = fileURLToPath(new URL('../../', import.meta.url));
const data = '한글 Unicode 🙂 "double" apostrophe\' backslash\\ newline\n $(touch injected) `touch injected` ; & | < > ( ) * ? [ ] { } ~ # !';
function event(root: string, command: string, tool = 'Bash'): HookInput { return { cwd: root, session_id: 'synthetic-literal-not-native', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }; }
function shell(cli: string, argv: string[]): string { return ['node', cli, ...argv].map(shellQuote).join(' '); }
function negatives(command: string, cli: string): string[] {
  return [command + '; pwd', command + ' && pwd', command + ' || pwd', command + ' | cat', command + ' > output', command + '\npwd', 'env ' + command, 'X=1 ' + command, 'sh -c ' + shellQuote(command), command.replace(shellQuote(cli), '/arbitrary/cli.mjs'), command.replace(shellQuote(cli), '"$(pwd)/cli.mjs"'), command.replace(shellQuote(cli), '"`pwd`/cli.mjs"'), command.replace(shellQuote(cli), '"$HOME/cli.mjs"'), command.replace(shellQuote(cli), '"cli\\.mjs"'), command.replace(shellQuote(cli), 'cli*.mjs'), command.replace(shellQuote(cli), '{cli,other}.mjs'), command.replace(shellQuote(cli), '~/.mjs'), command + ' # comment', command + ' &', command + ' < input', command + ' $(pwd)', command + ' `pwd`', command + ' "a""b"', command + ' unquoted\\ escape', command + " 'unclosed"];
}

test('bounded literals preserve real shell argv for quoted data and reject executable syntax', async () => {
  const values = ['', data, 'first\nsecond', 'a\tb', "''", '\\', 'spaces  stay'];
  for (const value of values) {
    const command = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', value].map(shellQuote).join(' ');
    const words = literalWords(command); assert.deepEqual(words, [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', value]);
    const observed = await run('/bin/sh', ['-c', command]); assert.deepEqual(JSON.parse(observed.stdout), [value]);
  }
  const double = [shellQuote(process.execPath), '-e', shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))'), '"semicolon; (safe) &|<>*?[]{}~"'].join(' ');
  assert.deepEqual(literalWords(double), [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'semicolon; (safe) &|<>*?[]{}~']);
  assert.deepEqual(JSON.parse((await run('/bin/sh', ['-c', double])).stdout), ['semicolon; (safe) &|<>*?[]{}~']);
  assert.deepEqual(literalWords('node "safe path" status --root "/tmp/project" --json'), ['node', 'safe path', 'status', '--root', '/tmp/project', '--json']);
  const command = shell(installedCliPath(), ['change', 'put', '--input', JSON.stringify({ raw: data })]);
  assert.equal(normalizeTool('/tmp/project', 'codex', event('/tmp/project', command)).operation, 'read');
  for (const candidate of negatives(command, installedCliPath())) assert.equal(normalizeTool('/tmp/project', 'codex', event('/tmp/project', candidate)).operation, 'unknown', candidate);
  assert.equal(literalWords("node 'nul\0data'"), null);
  assert.equal(normalizeTool('/tmp/project', 'codex', { ...event('/tmp/project', command), tool_input: { command, workdir: '/tmp/other' } }).operation, 'unknown');
  assert.equal(normalizeTool('/tmp/project', 'codex', event('/tmp/project', `node -e 'process.exit()'`)).operation, 'unknown');
});

async function hook(host: HostId, root: string, command: string, extra: Record<string, unknown> = {}) {
  const runtime = path.join(repository, 'plugins/byeori-' + host + '/runtime/hook.mjs');
  const child = spawn(process.execPath, [runtime, host], { cwd: root }); let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const ended = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); const input = event(root, command, host === 'claude' ? 'Bash' : 'exec_command'); input.tool_input = { ...input.tool_input, ...extra }; child.stdin.end(JSON.stringify(input));
  return { exit: await ended, stdout, stderr };
}

test('both shipped hooks and real shell CLI execute documented draft/review/apply recipes with inert complex data', async () => {
  const reference = await readFile(path.join(repository, 'skills-src/references/commands.md'), 'utf8');
  const recipes = new Map([...reference.matchAll(/```json recipe=([\w-]+)\n([^`]+)```/g)].map(match => [match[1], JSON.parse(match[2]) as { command: string[] }]));
  for (const host of ['codex', 'claude'] as const) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "Byeori literal 한글 '$;(x) ")));
    assert.ok(!root.startsWith(repository), 'fixture outside Git checkout');
    const cli = path.join(repository, 'plugins/byeori-' + host + '/runtime/cli.mjs'); const executed: string[] = [];
    const invoke = async <T>(name: string, input?: unknown, expected = 0): Promise<T> => {
      const recipe = recipes.get(name); assert.ok(recipe, name); const argv = [...recipe.command, '--root', root, '--json', ...(input ? ['--input', JSON.stringify(input)] : [])];
      const command = shell(cli, argv); const checked = await hook(host, root, command); assert.equal(checked.exit, 0); assert.equal(checked.stdout, '', checked.stdout);
      let stdout: string; let exit = 0;
      try { stdout = (await run('/bin/sh', ['-c', command], { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout; } catch (error) { const failure = error as { code: number; stdout: string }; stdout = failure.stdout; exit = failure.code; }
      assert.equal(exit, expected, stdout); const result = JSON.parse(stdout) as Result<T>; assert.equal(result.ok, expected === 0, stdout); executed.push(name); return result.ok ? result.data : undefined as T;
    };
    try {
      await invoke('init'); const state = await invoke<ContinuityStatus>('status'); const binding = await currentBinding(root);
      assert.deepEqual({ project_id: state.project_id, workspace_fingerprint: state.workspace_fingerprint }, binding);
      await invoke('workflow-write', { ...binding, expected_version: state.workflow.version, workflow: { ...state.workflow, facts: [{ id: 'FACT-LITERAL', text: data }], next_action: data } });
      assert.equal((await invoke<ContinuityStatus>('status')).workflow.facts[0].text, data);
      let change = await invoke<ChangeRecord>('create-change', { ...binding, metadata: { type: 'spec_change', title: data, request: data, reason: data, affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } } });
      for (const [kind, id] of [['prd', 'PRD-DEMO-001'], ['actor', 'ACT-WORKER-001']] as const) {
        const original = await readFile(path.join(repository, 'tests/fixtures/planning/' + kind + '.yaml'), 'utf8'); const raw = original + '\n# ' + data.replaceAll('\n', '\n# ') + '\n';
        const put = await invoke<{ change: ChangeRecord; draft: { raw: string } }>('put-draft', { ...binding, change_id: change.change_id, expected_version: change.version, object_id: id, kind, path: 'planning/source/' + kind + '.yaml', raw });
        assert.equal(put.draft.raw, raw); change = put.change;
      }
      const round = await invoke<ReviewRound>('prepare-review', { ...binding, change_id: change.change_id, expected_version: change.version }); const request = roundBinding(round);
      assert.equal((await invoke<ReviewResults>('review-results', request)).accepted_submission, null); await invoke('apply', request, 3);
      // Synthetic human service fixture only; never agent/native approval or a product shortcut.
      const human = createHumanReview(root); const body = { ...request, items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } };
      const saved = await human.saveReviewDraft({ ...body, expected_version: null }); assert.ok(saved.ok); if (!saved.ok) throw new Error('Fixture save failed');
      assert.ok((await human.submitReview({ ...body, schema_version: 1, submission_id: 'synthetic-literal-' + host, expected_feedback_version: saved.data.version, final_confirmation: true })).ok);
      await invoke('review-results', request); await invoke('apply', request); assert.equal((await invoke<ContinuityStatus>('status')).apply_state.state, 'applied');
      const original = await readFile(path.join(repository, 'tests/fixtures/planning/prd.yaml'), 'utf8'); assert.equal(await readFile(path.join(root, 'planning/source/prd.yaml'), 'utf8'), original + '\n# ' + data.replaceAll('\n', '\n# ') + '\n');
      const candidate = shell(cli, ['status', '--root', root, '--json']);
      for (const command of negatives(candidate, cli)) { const denied = await hook(host, root, command); assert.equal(denied.exit, 0); assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /SCOPE_DENIED/); }
      const gateRequest = { ...binding, host, tool: 'file-write', operation: 'implementation_write', paths: ["src/한글 apostrophe' $;().ts"] }; const ticket = randomUUID();
      const gateArgv = ['gate', 'check', '--root', root, '--json', '--hook-ticket', ticket, '--input', JSON.stringify(gateRequest)]; const gateCommand = shell(installedCliPath(), gateArgv);
      for (const override of ['cwd', 'workdir']) assert.equal(await literalGate(root, host, { ...event(root, gateCommand), tool_input: { command: gateCommand, [override]: '/tmp/other' } }), null);
      const gate = await literalGate(root, host, event(root, gateCommand)); assert.ok(gate); assert.deepEqual(JSON.parse(JSON.stringify(gate.request)), gateRequest); assert.equal(gate.argv_hash, semanticHash([await realpath(installedCliPath()), ...gateArgv]));
      for (const command of [gateCommand + '; pwd', gateCommand.replace('--json', '--json other'), gateCommand.replace(ticket, 'invalid'), ...negatives(gateCommand, installedCliPath())]) assert.equal(await literalGate(root, host, event(root, command)), null);
      for (const override of ['cwd', 'workdir']) { const denied = await hook(host, root, shell(cli, gateArgv), { [override]: '/tmp/other' }); assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /SCOPE_DENIED/); }
      const uuid = await hook(host, root, `node -e "console.log(require('node:crypto').randomUUID())"`); assert.equal(uuid.stdout, '');
      const alteredUuid = await hook(host, root, `node -e "console.log(require('node:crypto').randomUUID();process.exit())"`); assert.match(JSON.parse(alteredUuid.stdout).hookSpecificOutput.permissionDecisionReason, /SCOPE_DENIED/);
      const unavailable = await hook(host, root, shell(cli, gateArgv)); assert.match(JSON.parse(unavailable.stdout).hookSpecificOutput.permissionDecisionReason, /HOOK_NOT_ACTIVE/);
      assert.equal((await invoke<ContinuityStatus>('status')).apply_state.state, 'applied');
      console.log(JSON.stringify({ host, executed_recipes: [...new Set(executed)], negative_shell_forms: negatives(candidate, cli).length, exact_raw_preserved: true, native_activation_claim: false }));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
