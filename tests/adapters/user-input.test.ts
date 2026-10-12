import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HostId } from '../../src/contracts';
import { handleHook } from '../../src/adapters/hook-entry';
import { parseHookInput } from '../../src/adapters/normalize';
import { isUserInputTool } from '../../src/adapters/user-input';
import { withWriteLock } from '../../src/core/ownership';
import { readHost, status } from '../../src/core/state';
import { initializeWorkspace } from '../../src/core/workspace';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const protocol = await readFile(path.join(repository, 'skills-src/references/interview.md'), 'utf8');
const examples = Object.fromEntries([...protocol.matchAll(/```json tool=(\w+)\n([^`]+)```/g)].map(match => [match[1], JSON.parse(match[2])]));
const event = (root: string, tool: string, args: unknown) => JSON.stringify({ cwd: root, session_id: 'synthetic-question', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: args });
const hostFor = (tool: string): HostId => tool === 'AskUserQuestion' ? 'claude' : 'codex';
const accepted: [HostId, string, Record<string, unknown>][] = Object.entries(examples).map(([tool, args]) => [hostFor(tool), tool, args]);
accepted.push(['codex', 'request_user_input_async', { questions: [{ title: 'Synthetic goal?' }, { title: 'Synthetic constraint?' }, { title: 'Synthetic choice?', options: ['Small', 'Large'] }] }]);
accepted.push(['codex', 'request_user_input_async', { questions: Array.from({ length: 4 }, () => ({ title: 'Free text is supported' })) }]);
accepted.push(['claude', 'AskUserQuestion', { questions: [{ ...examples.AskUserQuestion.questions[0], multiSelect: true, options: [{ label: 'Preview', description: 'Synthetic layout', preview: '<div>Example</div>' }, { label: 'Plain', description: 'No preview' }] }] }]);
accepted.push(['codex', 'request_user_input_async', { questions: [{ title: 'Literal text: $(touch src/change.ts); cat .env', options: ['Literal > text'] }] }]);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori questions '));
  try { await initializeWorkspace(root); await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function bundled(host: HostId, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repository, `plugins/byeori-${host}/runtime/hook.mjs`), host]); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr))); child.stdin.end(raw);
  });
}
function denied(stdout: string, code = 'SCOPE_DENIED') {
  const result = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(result.permissionDecision, 'deny'); assert.match(result.permissionDecisionReason, new RegExp(code));
}

test('native question tools accept documented examples, async free text/choices and optional Claude preview', () => {
  assert.equal(Object.keys(examples).length, 3);
  for (const [host, tool, args] of accepted) assert.equal(isUserInputTool(host, parseHookInput(event('/tmp', tool, args))), true, tool);
});

const rejected: [HostId, string, Record<string, unknown>][] = [];
for (const [tool, args] of Object.entries(examples)) {
  const host = hostFor(tool);
  for (const name of ['AskTool', tool + '_execute', 'functions.' + tool, 'mcp__custom__' + tool, ' ' + tool, 'functions.exec']) rejected.push([host, name, args]);
  rejected.push([host === 'codex' ? 'claude' : 'codex', tool, args]);
  for (const extra of [{ command: 'touch src/change.ts' }, { file_path: '.env' }, { answers: { scope: 'approved' } }, { mode: 'plan' }, { tool_uses: [] }]) rejected.push([host, tool, { ...args, ...extra }]);
  for (const questions of [[], null, 'invalid', [null], [true], [{}]]) rejected.push([host, tool, { questions }]);
  for (const extra of [{ command: 'touch src/change.ts' }, { file_path: '.env' }, { answers: ['yes'] }]) rejected.push([host, tool, { questions: [{ ...args.questions[0], ...extra }] }]);
  const question = args.questions[0];
  for (const options of [null, [], ['wrong'], [{ label: 'Only', description: 'One' }]]) {
    if (tool === 'request_user_input_async' && Array.isArray(options) && options.every(item => typeof item === 'string') && options.length) continue;
    rejected.push([host, tool, { questions: [{ ...question, options }] }]);
  }
  if (tool !== 'request_user_input_async') {
    rejected.push([host, tool, { questions: [{ ...question, options: [{ ...question.options[0], command: 'touch src/change.ts' }, question.options[1]] }] }]);
    rejected.push([host, tool, { questions: [{ ...question, options: question.options.map((option: object) => ({ ...option, description: ' ' })) }] }]);
    rejected.push([host, tool, { questions: Array.from({ length: tool === 'AskUserQuestion' ? 5 : 4 }, () => question) }]);
  }
}
rejected.push(['codex', 'request_user_input', { questions: [examples.request_user_input.questions[0], examples.request_user_input.questions[0]] }]);
rejected.push(['codex', 'request_user_input_async', { questions: [{ title: ' ' }] }]);
rejected.push(['claude', 'AskUserQuestion', { questions: [{ ...examples.AskUserQuestion.questions[0], multiSelect: 'false' }] }]);

test('lookalikes, cross-host schemas, nested side effects, fabricated answers and invalid inputs stay gated', () => fixture(async root => {
  for (const [host, tool, args] of rejected) {
    const raw = event(root, tool, args);
    assert.equal(isUserInputTool(host, parseHookInput(raw)), false, raw);
    denied((await handleHook(host, raw)).stdout);
  }
  denied((await handleHook('codex', event(root, 'request_user_input_async', null))).stdout, 'VALIDATION_FAILED');
}));

test('question hooks defer to native permissions without locks, observations, answers or implementation authority', () => fixture(async root => {
  const before = await status(root); const hosts = { claude: await readHost(root, 'claude'), codex: await readHost(root, 'codex') };
  const config = await readFile(path.join(root, 'planning/config.yaml'));
  await withWriteLock(root, 'synthetic-writer', async () => {
    for (const [host, tool, args] of accepted) {
      const raw = event(root, tool, args);
      assert.deepEqual(await handleHook(host, raw), { exit: 0, stdout: '', stderr: '' });
      assert.equal(await bundled(host, raw), '');
    }
  });
  const after = await status(root);
  assert.deepEqual(after.workflow, before.workflow); assert.equal(after.implementation_authorization.state, 'none');
  assert.deepEqual(await readFile(path.join(root, 'planning/config.yaml')), config);
  for (const host of ['claude', 'codex'] as const) {
    assert.deepEqual(await readHost(root, host), hosts[host]);
    await assert.rejects(readFile(path.join(root, `planning/hosts/${host}.yaml`)), { code: 'ENOENT' });
  }
}));

test('both shipped hook bundles reject mixed question payloads and retain sensitive-read/write/shell protection', () => fixture(async root => {
  await writeFile(path.join(root, '.env'), 'SYNTHETIC_ONLY=yes');
  for (const host of ['claude', 'codex'] as const) {
    const tool = host === 'claude' ? 'AskUserQuestion' : 'request_user_input_async';
    denied(await bundled(host, event(root, tool, { ...examples[tool], command: 'touch src/change.ts' })));
    const controls: [string, Record<string, unknown>, string][] = host === 'claude' ? [
      ['Read', { file_path: path.join(root, '.env') }, 'PATH_DENIED'],
      ['Write', { file_path: path.join(root, 'new.ts'), content: 'synthetic' }, 'HOOK_NOT_ACTIVE'],
      ['Bash', { command: 'echo data > new.ts' }, 'SCOPE_DENIED'],
    ] : [
      ['exec_command', { command: 'cat .env' }, 'PATH_DENIED'],
      ['apply_patch', { command: '*** Begin Patch\n*** Add File: new.ts\n+synthetic\n*** End Patch' }, 'HOOK_NOT_ACTIVE'],
      ['exec_command', { command: 'echo data > new.ts' }, 'SCOPE_DENIED'],
    ];
    for (const [name, args, code] of controls) {
      const raw = event(root, name, args); denied((await handleHook(host, raw)).stdout, code); denied(await bundled(host, raw), code);
    }
  }
}));
