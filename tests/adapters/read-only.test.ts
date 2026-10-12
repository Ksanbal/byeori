import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { handleHook } from '../../src/adapters/hook-entry';
import { bundledReferenceRoot, isReadOnlyTool } from '../../src/adapters/read-only';
import { parseHookInput } from '../../src/adapters/normalize';
import { withWriteLock } from '../../src/core/ownership';
import { readHost } from '../../src/core/state';
import { createChange, currentBinding, initializeWorkspace } from '../../src/core/workspace';
import type { ContinuityStatus, HostId } from '../../src/contracts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const event = (root: string, tool: string, tool_input: Record<string, unknown>) => JSON.stringify({ cwd: root, session_id: 'synthetic-read-regression', hook_event_name: 'PreToolUse', tool_name: tool, tool_input });
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori read policy '));
  try { await initializeWorkspace(root); await writeFile(path.join(root, 'notes.md'), 'Synthetic public project note'); await run(root); }
  finally { await rm(root, { force: true, recursive: true }); }
}
function denied(response: Awaited<ReturnType<typeof handleHook>>, code: string) {
  const result = JSON.parse(response.stdout).hookSpecificOutput;
  assert.equal(result.permissionDecision, 'deny'); assert.match(result.permissionDecisionReason, new RegExp(code));
}
const search = { search_query: [{ q: 'site:example.org public cancellation policy' }], response_length: 'short' };

test('exact research tool names and known read shapes, never arbitrary MCP or mixed actions', () => fixture(async root => {
  const allowed: [HostId, string, Record<string, unknown>][] = [
    ['codex', 'webrun', search],
    ['codex', 'webrun', { open: [{ ref_id: 'https://example.org/policy', lineno: 4 }] }],
    ['codex', 'webrun', { find: [{ ref_id: 'turn0search0', pattern: 'refund' }], click: [{ ref_id: 'turn0search0', id: 2 }] }],
    ['claude', 'WebSearch', { query: 'public refund policy', allowed_domains: ['example.org'] }],
    ['claude', 'WebFetch', { url: 'https://example.org/policy', prompt: 'Summarize the public policy' }],
  ];
  for (const [host, tool, args] of allowed) assert.equal(await isReadOnlyTool(root, host, parseHookInput(event(root, tool, args)), root), true, tool);
  for (const [tool, args] of [
    ['webrun', { ...search, execute: 'touch src/change.ts' }], ['webrun', { ...search, open: [{ ref_id: 'file:///private/secret' }] }],
    ['webrun', { open: [{ ref_id: 'https://user:password@example.org' }] }], ['webrun', { search_query: [{ q: 'public', method: 'POST' }] }],
    ['webrun', { search_query: [] }], ['webrun', { find: [{ ref_id: 'turn0search0' }] }], ['webrun', { click: [{ ref_id: 'turn0search0', id: '2' }] }],
    ['mcp__arbitrary__search', search], ['functions.exec', { code: 'anything' }], ['WebSearch', { query: 'not a Codex native name' }],
  ] as [string, Record<string, unknown>][]) assert.equal(await isReadOnlyTool(root, 'codex', parseHookInput(event(root, tool, args)), root), false, tool);
}));

test('parallel genuine read classifications do not require a writer lock or update activation records', () => fixture(async root => {
  const before = await readHost(root, 'codex'); const config = await readFile(path.join(root, 'planning/config.yaml'));
  await withWriteLock(root, 'synthetic existing draft writer', async () => {
    const results = await Promise.all([
      handleHook('codex', event(root, 'webrun', search)),
      handleHook('codex', event(root, 'Read', { file_path: path.join(root, 'notes.md') })),
      handleHook('codex', event(root, 'exec_command', { command: 'cat notes.md planning/config.yaml' })),
      handleHook('codex', event(root, 'exec_command', { command: 'cat -- notes.md' })),
      handleHook('codex', event(root, 'exec_command', { command: 'pwd' })),
      handleHook('codex', event(root, 'exec_command', { command: `cat "${bundledReferenceRoot()}/start.md"` })),
    ]);
    for (const result of results) assert.deepEqual(result, { exit: 0, stdout: '', stderr: '' });
  });
  assert.deepEqual(await readHost(root, 'codex'), before);
  assert.deepEqual(await readFile(path.join(root, 'planning/config.yaml')), config);
  await assert.rejects(readFile(path.join(root, 'planning/hosts/codex.yaml')), { code: 'ENOENT' });
}));

test('document reading excludes secrets, external files, symlinks, options and executable shell syntax', () => fixture(async root => {
  await writeFile(path.join(root, '.env'), 'SYNTHETIC_ONLY=yes'); await symlink(path.join(root, 'notes.md'), path.join(root, 'linked.md'));
  for (const command of [
    'cat .env', 'cat -- .env', 'cat linked.md', 'cat ../outside.md', 'cat /tmp/arbitrary.md',
    `cat "${bundledReferenceRoot()}/../package.json"`, 'cat /dev/stdin', 'cat .',
  ]) denied(await handleHook('codex', event(root, 'exec_command', { command })), 'PATH_DENIED');
  for (const command of [
    'cat notes.md; touch src/change.ts', 'cat notes.md > src/change.ts', 'cat $(whoami)',
    'cat --help', 'cat -', 'cat', 'rg --pre evil notes.md', 'node -e "process.exit()"', 'curl https://example.org',
  ]) denied(await handleHook('codex', event(root, 'exec_command', { command })), 'SCOPE_DENIED');
  denied(await handleHook('codex', event(root, 'exec_command', { command: 'cat notes.md', workdir: '/tmp' })), 'SCOPE_DENIED');
  denied(await handleHook('codex', event(root, 'Read', { file_path: '/tmp/arbitrary.md' })), 'PATH_DENIED');
  denied(await handleHook('codex', event(root, 'webrun', { ...search, write: {} })), 'SCOPE_DENIED');
}));

test('draft writes remain pre-review; implementation, approved source and shell side effects remain gated', () => fixture(async root => {
  const change = await createChange(root, { ...await currentBinding(root), metadata: { type: 'spec_change', title: 'Synthetic draft', request: 'Draft planning only', reason: 'Regression', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } } });
  const patch = (file: string) => ({ command: `*** Begin Patch\n*** Add File: ${file}\n+synthetic\n*** End Patch` });
  assert.equal((await handleHook('codex', event(root, 'apply_patch', patch(`planning/changes/${change.change_id}/draft/prd.yaml`)))).stdout, '');
  for (const file of ['src/new.ts', 'planning/source/prd.yaml', 'planning/reviews/submissions/fake.yaml']) denied(await handleHook('codex', event(root, 'apply_patch', patch(file))), 'HOOK_NOT_ACTIVE');
  denied(await handleHook('codex', event(root, 'exec_command', { command: 'touch -- src/new.ts' })), 'HOOK_NOT_ACTIVE');
  denied(await handleHook('codex', event(root, 'exec_command', { command: 'echo data > src/new.ts' })), 'SCOPE_DENIED');
  assert.equal((await readHost(root, 'codex')).mode.type, 'enforced');
}));

async function packagedHook(host: HostId, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repository, `plugins/byeori-${host}/runtime/hook.mjs`), host]); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr))); child.stdin.end(raw);
  });
}
test('both regenerated hook bundles read their own skill references and research without native-trust claims', () => fixture(async root => {
  for (const host of ['claude', 'codex'] as const) {
    const reference = path.join(repository, `plugins/byeori-${host}/skills/${host === 'claude' ? 'start' : 'byeori-start'}/references/commands.md`);
    assert.equal(await packagedHook(host, event(root, 'Bash', { command: `cat "${reference}"` })), '');
    assert.equal(await packagedHook(host, event(root, host === 'codex' ? 'webrun' : 'WebSearch', host === 'codex' ? search : { query: 'public policy' })), '');
    const other = path.join(repository, `plugins/byeori-${host === 'claude' ? 'codex' : 'claude'}/skills/${host === 'claude' ? 'byeori-start' : 'start'}/SKILL.md`);
    assert.match(await packagedHook(host, event(root, 'Bash', { command: `cat "${other}"` })), /PATH_DENIED/);
    assert.equal((await readHost(root, host)).active, false);
  }
}));

const execute = promisify(execFile);
test('documented full workflow merge saves before approval and rejects the incident string-array shape', () => fixture(async root => {
  const entry = path.join(repository, 'plugins/byeori-codex/runtime/cli.mjs');
  async function cli(words: string[], input?: unknown, code = 0) {
    let output;
    try { output = await execute(process.execPath, [entry, ...words, '--root', root, '--json', ...(input ? ['--input', JSON.stringify(input)] : [])]); }
    catch (error) { assert.equal((error as { code: number }).code, code); output = error as { stdout: string }; }
    const result = JSON.parse(output.stdout); assert.equal(result.ok, code === 0); return result;
  }
  const state = (await cli(['status'])).data as ContinuityStatus;
  const request = { project_id: state.project_id, workspace_fingerprint: state.workspace_fingerprint, expected_version: state.workflow.version, workflow: { ...state.workflow, facts: [{ id: 'scope', text: 'Synthetic user-confirmed scope' }] } };
  const invalid = await cli(['workflow', 'write'], { ...request, workflow: { ...request.workflow, facts: ['Synthetic wrong shape'] } }, 2);
  assert.equal(invalid.diagnostics[0].code, 'VALIDATION_FAILED'); assert.match(invalid.diagnostics[0].message, /facts/);
  assert.equal((await cli(['status'])).data.workflow.version, state.workflow.version);
  await cli(['workflow', 'write'], request);
  const after = (await cli(['status'])).data as ContinuityStatus;
  assert.deepEqual(after.workflow.facts, request.workflow.facts);
  assert.equal(after.implementation_authorization.state, 'none'); assert.equal(after.active_change, null);
  assert.equal((await readHost(root, 'codex')).mode.type, 'enforced');
  const commands = await readFile(path.join(repository, 'skills-src/references/commands.md'), 'utf8');
  assert.match(commands, /complete `status.data.workflow` object/); assert.match(commands, /not string arrays/);
}));
