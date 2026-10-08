import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stringify } from 'yaml';
import { build } from 'esbuild';
import { withWriteLock } from '../../src/core/ownership';
import { rawHash, semanticHash } from '../../src/core/yaml';
import type { HostId } from '../../src/contracts';
import { apply } from '../../src/core/apply';
import { roundBinding } from '../../src/core/review';
import { selectAdvisory, readHost } from '../../src/core/state';
import { currentBinding, initializeWorkspace, createChange } from '../../src/core/workspace';
import { approvedScenario } from '../fixtures/approved-scenario';
import { hooksConfig, installedCliPath } from '../../src/adapters/config';
import { refreshHosts } from '../../src/adapters/probe';
import { normalizeTool, parseHookInput } from '../../src/adapters/normalize';

const entry = fileURLToPath(new URL('../../src/adapters/hook-entry.ts', import.meta.url));
function invoke(host: HostId, raw: string, env: NodeJS.ProcessEnv = {}, timeout = 15_000): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, host], { env: { ...process.env, ...env }, timeout }); let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.on('error', reject); child.on('close', exit => resolve({ exit, stdout, stderr })); child.stdin.end(raw);
  });
}
const input = (root: string, tool: string, args: unknown, event = 'PreToolUse') => JSON.stringify({ cwd: root, session_id: 'synthetic-adapter-session', hook_event_name: event, tool_name: tool, tool_input: args, source: event === 'SessionStart' ? 'compact' : undefined });
async function temp(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'Byeori adapter 한글 ')); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
function blocked(response: { exit: number | null; stdout: string }, code?: string) { assert.equal(response.exit, 0); const output = JSON.parse(response.stdout); assert.equal(output.hookSpecificOutput.permissionDecision, 'deny'); if (code) assert.match(output.hookSpecificOutput.permissionDecisionReason, new RegExp(code)); }
function writeInput(root: string, host: HostId, file = 'src/new.ts') { return host === 'claude' ? input(root, 'Write', { file_path: path.join(root, file), content: 'synthetic' }) : input(root, 'apply_patch', { command: '*** Begin Patch\n*** Add File: ' + file + '\n+synthetic\n*** End Patch' }); }

test('real child host envelopes use real gate; replay cannot claim native activation or human review', async () => temp(async root => {
  for (const host of ['claude', 'codex'] as const) {
    blocked(await invoke(host, writeInput(root, host)), 'HOOK_NOT_ACTIVE');
    const capability = await readHost(root, host); assert.equal(capability.active, false); assert.equal(capability.trusted, null); assert.equal(capability.probed.state, 'blocked');
    assert.equal((await invoke(host, input(root, 'Read', { file_path: path.join(root, 'planning/config.yaml') }))).stdout, '');
    assert.equal((await invoke(host, input(root, 'Bash', { command: 'pwd' }))).stdout, '');
    blocked(await invoke(host, input(root, 'Bash', { command: 'echo data > src/new.ts' })), 'SCOPE_DENIED');
    blocked(await invoke(host, input(root, 'Bash', { command: 'touch -- src/new.ts', workdir: '/tmp' })), 'SCOPE_DENIED');
    blocked(await invoke(host, input(root, 'write_stdin', { chars: 'arbitrary' })), 'SCOPE_DENIED');
    blocked(await invoke(host, input(root, 'mcp__arbitrary__write', { path: 'src/new.ts' })), 'SCOPE_DENIED');
    await selectAdvisory(root, { host, reason: 'Explicit synthetic human choice, not native activation' });
    blocked(await invoke(host, writeInput(root, host)), 'REVIEW_REQUIRED');
  }
  const planning = await approvedScenario(root); await apply(root, roundBinding(planning.round));
  for (const host of ['claude', 'codex'] as const) blocked(await invoke(host, writeInput(root, host)), 'REVIEW_REQUIRED');
  const scoped = await approvedScenario(root, true); await apply(root, roundBinding(scoped.round));
  const { listFiles } = await import('../../src/core/paths'); const records = [...(await listFiles(root, 'planning/changes/' + scoped.change.change_id)).filter(file => /feedback/.test(file)), ...await listFiles(root, 'planning/reviews')]; assert.ok(records.some(file => file === 'planning/reviews/submissions/' + scoped.submission.submission_id + '.yaml')); const originals = await Promise.all(records.map(file => readFile(path.join(root, file), 'utf8')));
  for (const host of ['claude', 'codex'] as const) {
    const allowed = await invoke(host, writeInput(root, host)); assert.equal(allowed.exit, 0); assert.equal(allowed.stdout, ''); assert.match(allowed.stderr, /human-selected advisory/);
    blocked(await invoke(host, writeInput(root, host, 'outside.ts')), 'SCOPE_DENIED');
    blocked(await invoke(host, writeInput(root, host, 'planning/source/prd.yaml')), 'SCOPE_DENIED');
    blocked(await invoke(host, input(root, 'Bash', { command: "touch -- 'outside.ts'" })), 'SCOPE_DENIED');
    assert.equal((await invoke(host, input(root, 'Bash', { command: "touch -- 'src/한글 file.ts'" }))).stdout, '');
    await mkdir(path.join(root, 'src'), { recursive: true });
    assert.equal((await invoke(host, input(path.join(root, 'src'), 'Bash', { command: 'touch -- nested.ts' }))).stdout, '');
    blocked(await invoke(host, input(path.join(root, 'src'), 'Bash', { command: 'touch -- ../outside.ts' })), 'PATH_DENIED');
    const compact = await invoke(host, input(root, '', {}, 'SessionStart')); assert.equal(compact.exit, 0); const context = JSON.parse(compact.stdout).hookSpecificOutput; assert.equal(context.hookEventName, 'SessionStart'); assert.match(context.additionalContext, /apply applied/); assert.match(context.additionalContext, /review results\/history/); assert.ok(compact.stdout.length < 2500); assert.ok(!compact.stdout.includes('.delivery'));
  }
  assert.deepEqual(await Promise.all(records.map(file => readFile(path.join(root, file), 'utf8'))), originals);
  const source = path.join(root, 'planning/source/prd.yaml'); await writeFile(source, (await readFile(source, 'utf8')).replace('합성 상담 서비스', 'Unapproved source drift'));
  for (const host of ['claude', 'codex'] as const) blocked(await invoke(host, writeInput(root, host)), 'SOURCE_DRIFT');
}));

test('planning draft paths only, patch moves/deletes/absolute paths, path escapes and malformed inputs', async () => temp(async root => {
  const binding = await currentBinding(root); const change = await createChange(root, { ...binding, metadata: { type: 'spec_change', title: 'Synthetic', request: 'Only draft', reason: 'Tests', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } } });
  for (const host of ['claude', 'codex'] as const) {
    assert.equal((await invoke(host, writeInput(root, host, 'planning/changes/' + change.change_id + '/draft/prd.yaml'))).stdout, '');
    blocked(await invoke(host, writeInput(root, host, 'planning/changes/other/draft/prd.yaml')), 'PATH_DENIED');
    blocked(await invoke(host, writeInput(root, host, 'planning/changes/' + change.change_id + '/reviews/1/feedback.yaml')), 'HOOK_NOT_ACTIVE');
    blocked(await invoke(host, '{"cwd":"x","cwd":"y"}'), 'VALIDATION_FAILED');
    blocked(await invoke(host, '{'), 'VALIDATION_FAILED');
    blocked(await invoke(host, input(root, 'Write', { file_path: '/tmp/outside', content: 'x' })), host === 'claude' ? 'PATH_DENIED' : 'SCOPE_DENIED');
  }
  const normalized = normalizeTool(root, 'codex', parseHookInput(input(root, 'apply_patch', { command: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** Delete File: README.md\n*** End Patch' })));
  assert.deepEqual(normalized.paths, ['src/old.ts', 'src/new.ts', 'README.md']);
  const absolute = normalizeTool(root, 'codex', parseHookInput(input(root, 'apply_patch', { command: '*** Begin Patch\n*** Add File: ' + path.join(root, 'src/absolute.ts') + '\n+x\n*** End Patch' }))); assert.deepEqual(absolute.paths, ['src/absolute.ts']);
  for (const command of ['*** Begin Patch\n*** Add File: src/a\n*** End Patch', '*** Begin Patch\n*** Update File: src/a\n*** Mystery File: other\n*** End Patch', '*** Begin Patch\n*** Add File: ../escape\n+x\n*** End Patch']) blocked(await invoke('codex', input(root, 'apply_patch', { command })), 'VALIDATION_FAILED|PATH_DENIED');
  blocked(await invoke('claude', input(os.tmpdir(), 'Write', { file_path: path.join(root, 'src/outside-cwd.ts'), content: 'x' })), 'WORKSPACE_MISMATCH');
  blocked(await invoke('codex', input(os.tmpdir(), 'apply_patch', { command: '*** Begin Patch\n*** Add File: ' + path.join(root, 'src/outside-cwd.ts') + '\n+x\n*** End Patch' })), 'WORKSPACE_MISMATCH');
  await symlink(os.tmpdir(), path.join(root, 'linked')); blocked(await invoke('claude', writeInput(root, 'claude', 'linked/a.ts')), 'PATH_DENIED');
  await writeFile(path.join(root, 'CASE.ts'), 'x'); blocked(await invoke('claude', writeInput(root, 'claude', 'case.ts')), 'PATH_DENIED');
}));

test('generated configurations fail closed on missing runtime; managed CLI is classified without guessed plugin env', async () => {
  for (const host of ['claude', 'codex'] as const) {
    const config = hooksConfig(host); assert.equal(config.hooks.PreToolUse[0].matcher, '.*'); assert.ok(!JSON.stringify(config).includes('/Users/')); assert.ok(JSON.stringify(config).includes('runtime/hook.mjs'));
    const run = async (event: 'PreToolUse' | 'SessionStart') => new Promise<number | null>((resolve, reject) => { const child = spawn('/bin/sh', ['-c', config.hooks[event][0].hooks[0].command], { env: { PATH: '/definitely-missing-node', PLUGIN_ROOT: '/absent', CLAUDE_PLUGIN_ROOT: '/absent' }, stdio: 'ignore' }); child.on('error', reject); child.on('close', resolve); });
    assert.equal(await run('PreToolUse'), 2); assert.equal(await run('SessionStart'), 0);
  }
  const root = '/tmp/fixture'; const event = parseHookInput(input(root, 'Bash', { command: `node "${installedCliPath()}" status --root "${root}" --json` })); assert.equal(normalizeTool(root, 'codex', event).operation, 'read');
  for (const command of ['cat file', 'node /arbitrary.js', 'touch -- src/x; cat -- foo', 'touch -- $(evil)', 'touch -- src/*', 'cat -- foo | touch -- src/a', 'touch -- "src/a""src/b"']) assert.equal(normalizeTool(root, 'codex', parseHookInput(input(root, 'Bash', { command }))).operation, 'unknown');
});

test('retained active capability cannot authorize CLI/Studio refresh after missing, disabled or replaced native observation', async () => temp(async root => {
  const capability = await readHost(root, 'codex'); const fake = { ...capability, configured: true, trusted: true, active: true, host_version: 'synthetic-not-native', probed: { state: 'passed', checked_at: new Date().toISOString(), evidence: ['Fabricated fixture must be invalidated'] } };
  await mkdir(path.join(root, 'planning/hosts')); await writeFile(path.join(root, 'planning/hosts/codex.yaml'), stringify(fake));
  const hosts = await refreshHosts(root); assert.equal(hosts[1].active, false); assert.equal(hosts[1].trusted, null); assert.equal(hosts[1].configured, false); assert.equal(hosts[1].probed.state, 'blocked');
  await selectAdvisory(root, { host: 'codex', reason: 'Keep explicit human choice through cache loss' }); await refreshHosts(root); assert.equal((await readHost(root, 'codex')).mode.type, 'advisory');
  const replay = await invoke('codex', writeInput(root, 'codex'), { PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root }); blocked(replay, 'REVIEW_REQUIRED'); assert.equal((await readHost(root, 'codex')).trusted, null);
}));


test('probe cache, definition/runtime replacement, expired observation and ended process invalidate retained trust', async () => temp(async root => {
  const plugin = await mkdtemp(path.join(os.tmpdir(), 'Synthetic hook payload 한글 '));
  try {
    await mkdir(path.join(plugin, 'hooks')); await mkdir(path.join(plugin, 'runtime'));
    const config = hooksConfig('codex'); const runtime = '// synthetic, never a native proof\n';
    await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify(config)); await writeFile(path.join(plugin, 'runtime/hook.mjs'), runtime);
    let owner!: import('../../src/contracts').WriteOwnership; await withWriteLock(root, 'capture actual fixture process identity', async writer => { owner = writer.owner; });
    const base = await readHost(root, 'codex'); const claimed = { ...base, configured: true, trusted: true, active: true, host_version: 'simulated-cache', probed: { state: 'passed', checked_at: new Date().toISOString(), evidence: ['Synthetic cache invalidation fixture only'] } };
    const observation = { ...await currentBinding(root), host: 'codex', owner, plugin_root: await (await import('node:fs/promises')).realpath(plugin), definition_hash: semanticHash(config), runtime_hash: rawHash(runtime), session_hash: semanticHash('synthetic-cache-session'), checked_at: new Date().toISOString() };
    const save = async (value = observation) => { await mkdir(path.join(root, 'planning/hosts'), { recursive: true }); await mkdir(path.join(root, 'planning/.runtime/adapters'), { recursive: true }); await writeFile(path.join(root, 'planning/hosts/codex.yaml'), stringify(claimed)); await writeFile(path.join(root, 'planning/.runtime/adapters/codex-probe.yaml'), stringify(value)); };
    await save(); const fresh = (await refreshHosts(root))[1]; assert.equal(fresh.active, false); assert.equal(fresh.trusted, true, 'last observed trust retained while ordinary active stays unverified');
    await save(); await writeFile(path.join(plugin, 'hooks/hooks.json'), '{}'); assert.equal((await refreshHosts(root))[1].trusted, null); await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify(config));
    await save(); await writeFile(path.join(plugin, 'runtime/hook.mjs'), runtime + '// changed'); assert.equal((await refreshHosts(root))[1].trusted, null); await writeFile(path.join(plugin, 'runtime/hook.mjs'), runtime);
    await save({ ...observation, checked_at: new Date(Date.now() - 301000).toISOString() }); assert.equal((await refreshHosts(root))[1].trusted, null);
    await save(); await rm(path.join(root, 'planning/.runtime/adapters/codex-probe.yaml')); assert.equal((await refreshHosts(root))[1].trusted, null);
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `import {withWriteLock} from ${JSON.stringify(fileURLToPath(new URL('../../src/core/ownership.ts', import.meta.url)))}; await withWriteLock(process.argv[1], 'synthetic child identity', async writer => process.stdout.write(JSON.stringify(writer.owner)));`, root]);
    let output = ''; child.stdout.on('data', chunk => output += chunk); await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('identity fixture exit ' + code))); });
    await save({ ...observation, owner: JSON.parse(output) }); assert.equal((await refreshHosts(root))[1].trusted, null, 'dead actual child identity never retained as trust');
  } finally { await rm(plugin, { recursive: true, force: true }); }
}));

test('installed hook bundle with replayed plugin env and mere host ancestry remains synthetic; bounded malformed/timeout input fails closed', async () => temp(async root => {
  const plugin = await mkdtemp(path.join(os.tmpdir(), 'Replayed installed payload 한글 '));
  try {
    await mkdir(path.join(plugin, 'hooks')); await mkdir(path.join(plugin, 'runtime'));
    await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify(hooksConfig('codex')));
    await build({ entryPoints: [entry], outfile: path.join(plugin, 'runtime/hook.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
    const replay = spawn(process.execPath, [path.join(plugin, 'runtime/hook.mjs'), 'codex'], { env: { ...process.env, PLUGIN_ROOT: await (await import('node:fs/promises')).realpath(plugin) } }); let stdout = ''; replay.stdout.on('data', chunk => stdout += chunk); const exit = new Promise<number | null>((resolve, reject) => { replay.on('error', reject); replay.on('close', resolve); }); replay.stdin.end(writeInput(root, 'codex')); blocked({ exit: await exit, stdout }, 'HOOK_NOT_ACTIVE'); assert.equal((await readHost(root, 'codex')).trusted, null);
    const huge = await invoke('codex', 'x'.repeat(1048577)); assert.equal(huge.exit, 2); assert.match(huge.stderr, /exceeds 1 MiB/);
    const stalled = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'codex']); let stderr = ''; stalled.stderr.on('data', chunk => stderr += chunk); const stopped = new Promise<number | null>((resolve, reject) => { stalled.on('error', reject); stalled.on('close', resolve); }); stalled.stdin.write(writeInput(root, 'codex')); assert.equal(await stopped, 2); assert.match(stderr, /timed out/);
  } finally { await rm(plugin, { recursive: true, force: true }); }
}));
