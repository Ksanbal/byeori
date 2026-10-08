import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { execute } from '../../src/cli/main';
import { currentBinding, initializeWorkspace, optionalText } from '../../src/core/workspace';
import { withWriteLock } from '../../src/core/ownership';
import { readHost } from '../../src/core/state';
import { rawHash, semanticHash } from '../../src/core/yaml';
import { consumeGateReceipt, issueGateReceipt } from '../../src/adapters/probe';
import { hooksConfig, installedCliPath } from '../../src/adapters/config';
import { literalGate, TICKET_COMMAND, hookTicket, receiptMatches } from '../../src/adapters/ticket';
import { normalizeTool, type HookInput } from '../../src/adapters/normalize';
const run = promisify(execFile);

async function temp(action: (root: string) => Promise<void>) { const input = await mkdtemp(path.join(os.tmpdir(), 'Byeori gate receipt 한글 ')); const root = await realpath(input); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('literal gate recognizer binds exact shared request and CLI argv; fresh actual crypto UUID generation is read-only', async () => temp(async root => {
  const generated = (await run(process.execPath, ['-e', "console.log(require('node:crypto').randomUUID())"])).stdout.trim(); assert.equal(hookTicket(generated), generated);
  const request = { ...await currentBinding(root), host: 'codex' as const, tool: 'apply_patch', operation: 'implementation_write' as const, paths: ['src/new.ts'] };
  const argv = ['gate', 'check', '--root', root, '--json', '--hook-ticket', generated, '--input', JSON.stringify(request)];
  const command = `node "${installedCliPath()}" gate check --root "${root}" --json --hook-ticket "${generated}" --input '${JSON.stringify(request)}'`;
  const event: HookInput = { cwd: root, session_id: 'synthetic-literal', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
  const gate = await literalGate(root, 'codex', event); assert.ok(gate); assert.deepEqual(JSON.parse(JSON.stringify(gate.request)), request); assert.equal(gate.argv_hash, semanticHash([await realpath(installedCliPath()), ...argv]));
  assert.equal(normalizeTool(root, 'codex', { ...event, tool_input: { command: TICKET_COMMAND } }).operation, 'read');
  assert.equal(normalizeTool(root, 'codex', { ...event, tool_input: { command: TICKET_COMMAND.replace('randomUUID()', 'randomUUID();process.exit()') } }).operation, 'unknown');
  for (const text of [command + '; pwd', command.replace('--json --hook-ticket', '--hook-ticket'), command.replace('node ', 'env node '), command.replace(generated, 'not-a-UUID'), command.replace(installedCliPath(), '/arbitrary/cli.mjs'), command.replace('implementation_write', 'unknown')]) assert.equal(await literalGate(root, 'codex', { ...event, tool_input: { command: text } }), null);
  assert.equal(await literalGate(root, 'claude', event), null); await issueGateReceipt(root, gate, event.session_id); assert.equal(await optionalText(root, 'planning/.runtime/adapters/gate-tickets/' + generated + '.yaml'), null, 'synthetic invocation cannot issue native receipt');
  const denied = await execute(argv); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.diagnostics[0].code, 'HOOK_NOT_ACTIVE');
  const bad = await execute(argv.map(value => value === generated ? 'invalid' : value)); assert.equal(bad.ok, false); if (!bad.ok) assert.equal(bad.diagnostics[0].code, 'VALIDATION_FAILED');
}));

test('missing, consumed, expired, mismatched request/session/CLI/runtime/cache/definition receipts never authorize an ordinary child', async () => temp(async root => {
  const plugin = await mkdtemp(path.join(os.tmpdir(), 'Synthetic receipt payload '));
  try {
    const pluginRoot = await realpath(plugin); await mkdir(path.join(plugin, 'hooks')); await mkdir(path.join(plugin, 'runtime')); const config = hooksConfig('codex'); const runtime = '// synthetic probe data only'; await writeFile(path.join(plugin, 'hooks/hooks.json'), JSON.stringify(config)); await writeFile(path.join(plugin, 'runtime/hook.mjs'), runtime);
    let owner!: import('../../src/contracts').WriteOwnership; await withWriteLock(root, 'synthetic fixture process identity', async writer => { owner = writer.owner; });
    const request = { ...await currentBinding(root), host: 'codex' as const, tool: 'apply_patch', operation: 'implementation_write' as const, paths: ['src/new.ts'] }; const ticket = randomUUID(); const argv = ['gate', 'check', '--root', root, '--json', '--hook-ticket', ticket, '--input', JSON.stringify(request)];
    const observation = { ...await currentBinding(root), host: 'codex', owner, plugin_root: pluginRoot, definition_hash: semanticHash(config), runtime_hash: rawHash(runtime), session_hash: semanticHash('synthetic-session'), checked_at: new Date().toISOString() };
    const capability = { ...await readHost(root, 'codex'), configured: true, trusted: true, active: true, host_version: 'synthetic-cache-only', probed: { state: 'passed', checked_at: new Date().toISOString(), evidence: ['Synthetic receipt invalidation only, not native proof'] } };
    const receipt = { ticket, request_hash: semanticHash(request), argv_hash: semanticHash([await realpath(process.argv[1]), ...argv]), command_hash: semanticHash('synthetic command'), session_hash: observation.session_hash, observation, cli_hash: rawHash(await readFile(process.argv[1], 'utf8')), issued_at: new Date().toISOString() };
    const file = 'planning/.runtime/adapters/gate-tickets/' + ticket + '.yaml';
    const save = async (value: unknown = receipt) => { await mkdir(path.join(root, 'planning/hosts'), { recursive: true }); await mkdir(path.join(root, 'planning/.runtime/adapters/gate-tickets'), { recursive: true }); await writeFile(path.join(root, 'planning/hosts/codex.yaml'), stringify(capability)); await writeFile(path.join(root, 'planning/.runtime/adapters/codex-probe.yaml'), stringify(observation)); await writeFile(path.join(root, file), stringify(value)); };
    assert.equal(await consumeGateReceipt(root, request, ticket, argv), false);
    for (const changed of [receipt, { ...receipt, issued_at: new Date(Date.now() - 2001).toISOString() }, { ...receipt, request_hash: semanticHash({ ...request, paths: ['other.ts'] }) }, { ...receipt, session_hash: semanticHash('other-session') }, { ...receipt, cli_hash: '0'.repeat(64) }, { ...receipt, observation: { ...observation, runtime_hash: '0'.repeat(64) } }]) {
      await save(changed); assert.equal(await consumeGateReceipt(root, request, ticket, argv), false); assert.equal(await optionalText(root, file), null); assert.equal(await consumeGateReceipt(root, request, ticket, argv), false);
    }
    await save(); await rm(path.join(root, 'planning/.runtime/adapters/codex-probe.yaml')); assert.equal(await consumeGateReceipt(root, request, ticket, argv), false);
    await save(); await writeFile(path.join(plugin, 'hooks/hooks.json'), '{}'); assert.equal(await consumeGateReceipt(root, request, ticket, argv), false);
  } finally { await rm(plugin, { recursive: true, force: true }); }
}));


test('receipt integrity predicate has a synthetic valid positive and discriminates exact request/argv/runtime/session/age', () => {
  const request = { project_id: 'synthetic-project', workspace_fingerprint: 'a'.repeat(64), host: 'codex' as const, tool: 'apply_patch', operation: 'implementation_write' as const, paths: ['src/one.ts'] }; const now = Date.now(); const ticket = randomUUID();
  const expected = { ticket, request, argv_hash: semanticHash(['synthetic-cli', 'gate', 'check']), cli_hash: semanticHash('synthetic-runtime'), session_hash: semanticHash('synthetic-event-session'), now };
  const receipt = { ticket, request_hash: semanticHash(request), argv_hash: expected.argv_hash, command_hash: semanticHash('literal command'), cli_hash: expected.cli_hash, session_hash: expected.session_hash, issued_at: new Date(now).toISOString() };
  assert.equal(receiptMatches(receipt, expected), true, 'hash/freshness predicate only; not native proof or active state');
  for (const changed of [{ ...receipt, ticket: randomUUID() }, { ...receipt, request_hash: semanticHash({ ...request, paths: ['src/two.ts'] }) }, { ...receipt, argv_hash: semanticHash('other-cli-args') }, { ...receipt, cli_hash: semanticHash('changed-runtime') }, { ...receipt, session_hash: semanticHash('other-event') }, { ...receipt, issued_at: new Date(now - 2001).toISOString() }, { ...receipt, issued_at: new Date(now + 1).toISOString() }, { ...receipt, issued_at: 'invalid' }, { ...receipt, command_hash: 'bad' }]) assert.equal(receiptMatches(changed, expected), false);
});
