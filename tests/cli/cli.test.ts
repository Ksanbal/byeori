import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import type { ChangeRecord, ContinuityStatus, DoctorResult, Result, ReviewResults, ReviewRound, StudioRuntime } from '../../src/contracts';
import { createHumanReview } from '../../src/core/services';
import { roundBinding } from '../../src/core/review';
import { parseYaml } from '../../src/core/yaml';
import { stopOwnedStudio } from '../../src/server';
import { execute } from '../../src/cli/main';
const run = promisify(execFile); const entry = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
async function cli<T>(root: string, command: string, flags: string[] = [], expected = 0) {
  let stdout: string; let stderr: string; let exit = 0;
  try { const response = await run(process.execPath, ['--import', 'tsx', entry, ...command.split(' '), '--root', root, '--json', ...flags], { maxBuffer: 4 * 1024 * 1024 }); stdout = response.stdout; stderr = response.stderr; }
  catch (error) { const response = error as { code: number; stdout: string; stderr: string }; exit = response.code; stdout = response.stdout; stderr = response.stderr; }
  assert.equal(exit, expected, command + ': ' + stdout + stderr); const lines = stdout.trim().split('\n'); assert.equal(lines.length, 1, 'single JSON stdout'); const value = JSON.parse(lines[0]) as Result<T>; assert.equal(value.ok, expected === 0, command + stdout); return { value, stdout, stderr, data: value.ok ? value.data : null };
}
function input(value: unknown): string[] { return ['--input', JSON.stringify(value)]; }
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori CLI 한글 ')); await cli(root, 'init'); return root; }
async function binding(root: string) { const state = (await cli<ContinuityStatus>(root, 'status')).data!; return { project_id: state.project_id, workspace_fingerprint: state.workspace_fingerprint }; }
const metadata = { type: 'spec_change', title: 'Synthetic CLI', request: 'Test only', reason: 'Synthetic persisted service', affected_object_ids: [], implementation_scope: { allowlist: [{ path: 'README.md', match: 'file' }], related_object_ids: ['PRD-DEMO-001'], validation_plan: ['Run synthetic tests'] } };
const prdRaw = () => readFile(new URL('../fixtures/planning/prd.yaml', import.meta.url), 'utf8');
async function prepared(root: string, blocking = false) {
  const bind = await binding(root); let change = (await cli<ChangeRecord>(root, 'change create', input({ ...bind, metadata }))).data!;
  const raw = blocking ? (await prdRaw()).replace('open_questions: []', 'open_questions:\n- id: QUESTION-001\n  text: Unresolved\n  blocking: true') : await prdRaw();
  change = (await cli<{ change: ChangeRecord }>(root, 'change put', input({ ...bind, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', raw }))).data!.change;
  const round = (await cli<ReviewRound>(root, 'review prepare', input({ ...bind, change_id: change.change_id, expected_version: change.version }))).data!;
  return { bind, change, round };
}
test('real child init preserves non-Git Korean-space workspace, doctor truth and negative CLI boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), '한글 nonGit '));
  try {
    await writeFile(path.join(root, 'AGENTS.md'), 'original AGENTS'); await writeFile(path.join(root, 'CLAUDE.md'), 'original CLAUDE'); await writeFile(path.join(root, '.gitignore'), 'original-ignore\n'); await mkdir(path.join(root, '.plan')); await writeFile(path.join(root, '.plan/keep'), 'old');
    const first = await cli(root, 'init'); const second = await cli(root, 'init'); assert.deepEqual(first.data, second.data);
    assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'original AGENTS'); assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), 'original CLAUDE'); assert.equal(await readFile(path.join(root, '.plan/keep'), 'utf8'), 'old'); assert.equal((await readFile(path.join(root, '.gitignore'), 'utf8')).split('# byeori:begin').length, 2);
    const report = (await cli<DoctorResult>(root, 'doctor')).data!; assert.equal(report.node.compatible, true); assert.equal(report.sqlite.fts5_probed, true); assert.equal(report.sqlite.extension_loading, false); assert.equal(report.schemas.compatible, true); assert.equal(report.writable, true); assert.deepEqual(report.instruction_paths, ['AGENTS.md', 'CLAUDE.md']); assert.equal(report.hosts.every(host => !host.active && !host.configured && host.trusted === null && host.probed.state === 'not_run'), true);
    const configPath = path.join(root, 'planning/config.yaml'); const configRaw = await readFile(configPath, 'utf8'); const config = parseYaml(configRaw) as Record<string, unknown>;
    await writeFile(configPath, stringify({ ...config, schema_version: 2 })); assert.equal((await cli<DoctorResult>(root, 'doctor')).data!.schemas.compatible, false);
    await writeFile(configPath, stringify({ ...config, genesis_hash: '0'.repeat(64) })); await cli(root, 'doctor', [], 4); await writeFile(configPath, configRaw);
    await chmod(path.join(root, 'planning/.runtime'), 0o555); try { const readonly = (await cli<DoctorResult>(root, 'doctor')).data!; assert.equal(readonly.writable, false); assert.equal(readonly.status, null); } finally { await chmod(path.join(root, 'planning/.runtime'), 0o700); }
    for (const command of ['approve', 'review submit', 'advisory', 'sql', 'shell', 'write', 'status extra']) await cli(root, command, [], 2);
    await cli(root, 'status', ['--unexpected', 'x'], 2); await cli(root, 'status', ['--json'], 2); await cli(root, 'search', ['--query'], 2); await cli(root, 'get', ['--id', 'x', '--input', '{}'], 2);
    await cli(root, 'change create', ['--input', '{"project_id":"a","project_id":"b"}'], 2); await cli(root, 'change create', ['--input', 'project_id: a'], 2); await cli(root, 'change create', ['--input', '{}'], 2);
    const limit = await execute(['change create', '--input', 'x'.repeat(1024 * 1024 + 1)]); assert.equal(limit.ok, false);
    await cli(root, 'search', ['--query', 'missing', '--limit', '26'], 2); await cli(root, 'lint', ['--stage', 'invented'], 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real child change CRUD, supplied CAS, lint, review/apply, search/history/get, workflow and gate/recovery', async () => {
  const root = await fixture();
  try {
    const bind = await binding(root); let change = (await cli<ChangeRecord>(root, 'change create', input({ ...bind, metadata }))).data!;
    await cli(root, 'change update', input({ ...bind, change_id: change.change_id, expected_version: '0'.repeat(64), metadata }), 4);
    change = (await cli<ChangeRecord>(root, 'change update', input({ ...bind, change_id: change.change_id, expected_version: change.version, metadata: { ...metadata, reason: 'Updated test reason' } }))).data!;
    const put = { ...bind, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', raw: await prdRaw() };
    await cli(root, 'change put', input({ ...put, path: '../outside.yaml' }), 2);
    change = (await cli<{ change: ChangeRecord }>(root, 'change put', input(put))).data!.change;
    const mutate = () => ({ ...bind, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001' });
    change = (await cli<ChangeRecord>(root, 'change move', input({ ...mutate(), path: 'planning/source/nested/prd.yaml' }))).data!;
    assert.equal((await cli<{ path: string }>(root, 'get', ['--id', 'PRD-DEMO-001', '--scope', 'change:' + change.change_id])).data!.path, 'planning/source/nested/prd.yaml');
    change = (await cli<ChangeRecord>(root, 'change delete', input(mutate()))).data!;
    change = (await cli<{ change: ChangeRecord }>(root, 'change put', input({ ...put, expected_version: change.version }))).data!.change;
    await cli(root, 'lint', ['--scope', 'change:' + change.change_id]); await cli(root, 'index rebuild', ['--scope', 'change:' + change.change_id]);
    const round = (await cli<ReviewRound>(root, 'review prepare', input({ ...bind, change_id: change.change_id, expected_version: change.version }))).data!; const frozen = roundBinding(round);
    await cli(root, 'apply', input(frozen), 3); await cli<ReviewResults>(root, 'review results', input(frozen));
    const human = createHumanReview(root); const feedback = { ...frozen, items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: true as const, scope_hash: round.manifest.scope_hash } }; const saved = await human.saveReviewDraft({ ...feedback, expected_version: null }); assert.ok(saved.ok); if (!saved.ok) return;
    const submitted = await human.submitReview({ ...feedback, schema_version: 1, submission_id: 'synthetic-cli-approval', expected_feedback_version: saved.data.version, final_confirmation: true }); assert.ok(submitted.ok);
    await cli(root, 'apply', input(frozen)); await cli(root, 'status'); await cli(root, 'lint');
    const found = await cli<{ hits: { id: string; revision: unknown }[] }>(root, 'search', ['--query', '기획']); assert.equal(found.data!.hits[0].id, 'PRD-DEMO-001'); assert.match(found.stderr, /SQLite/); await cli(root, 'impact', ['--id', 'PRD-DEMO-001']);
    await cli(root, 'get', ['--id', 'PRD-DEMO-001']); await cli(root, 'history', ['--id', 'PRD-DEMO-001']); await cli(root, 'lint', ['--scope', 'history:' + change.change_id + ':1']);
    const past = (await cli<{ hits: { revision: unknown }[] }>(root, 'search', ['--query', 'PRD-DEMO-001', '--scope', 'history:' + change.change_id])).data!; await cli(root, 'get', input({ object_id: 'PRD-DEMO-001', revision: past.hits[0].revision }));
    await rm(path.join(root, '.byeori'), { recursive: true }); await cli(root, 'index rebuild'); await cli(root, 'search', ['--query', '기획']);
    const state = (await cli<ContinuityStatus>(root, 'status')).data!;
    await cli(root, 'workflow write', input({ ...bind, expected_version: state.workflow.version, workflow: { ...state.workflow, next_action: 'Continue from durable workflow' } })); assert.equal((await cli<ContinuityStatus>(root, 'status')).data!.workflow.next_action, 'Continue from durable workflow');
    const gate = { ...bind, host: 'codex', tool: 'write', operation: 'implementation_write', paths: ['README.md'] }; await cli(root, 'gate check', input(gate), 6); assert.ok((await human.selectAdvisory({ host: 'codex', reason: 'Synthetic acceptance test' })).ok); await cli(root, 'gate check', input(gate)); await cli(root, 'gate check', input({ ...gate, paths: ['outside.ts'] }), 3);
    await cli(root, 'recover', input({ ...bind, change_id: change.change_id, action: 'inspect' }));
    const another = (await cli<ChangeRecord>(root, 'change create', input({ ...bind, metadata }))).data!; await cli(root, 'change cancel', input({ ...bind, change_id: another.change_id, expected_version: another.version, reason: 'Synthetic cancellation' }));
    const source = path.join(root, 'planning/source/prd.yaml'); await writeFile(source, (await prdRaw()).replace('합성 상담 서비스', 'Unapproved drift')); await cli(root, 'search', ['--query', '기획'], 4); await cli(root, 'lint', [], 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('stage readiness and real child review respond preserve human decisions', async () => {
  const root = await fixture();
  try {
    const { bind, change, round } = await prepared(root, true); const scope = 'change:' + change.change_id;
    await cli(root, 'lint', ['--scope', scope, '--stage', 'structural']); await cli(root, 'lint', ['--scope', scope, '--stage', 'review_ready']); await cli(root, 'lint', ['--scope', scope, '--stage', 'implementation_ready'], 3);
    const human = createHumanReview(root); const frozen = roundBinding(round); const feedback = { ...frozen, items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'request_changes' as const, comments: item.type === 'document' ? [{ id: 'COMMENT-001', blocking: true, kind: 'change_request' as const, body: 'Resolve synthetic question', target: { object_id: 'PRD-DEMO-001', element_id: null, field: null, operation_id: null, pointer: null } }] : [] })), implementation_authorization: { allowed: false as const, scope_hash: null } }; const saved = await human.saveReviewDraft({ ...feedback, expected_version: null }); assert.ok(saved.ok); if (!saved.ok) return;
    assert.ok((await human.submitReview({ ...feedback, schema_version: 1, submission_id: 'synthetic-cli-revise', expected_feedback_version: saved.data.version, final_confirmation: true })).ok);
    await cli(root, 'review respond', input({ ...frozen, submission_id: 'synthetic-cli-revise', response_id: 'response-cli', expected_change_version: change.version, comments: [{ comment_id: 'COMMENT-001', result: 'needs_clarification', rationale: 'Synthetic follow-up retained', changed_paths: [] }] }));
    const result = (await cli<ReviewResults>(root, 'review results', input(frozen))).data!; assert.equal(result.accepted_submission!.submission.items[0].decision, 'request_changes'); await cli(root, 'apply', input(frozen), 3);
    assert.equal(bind.project_id, round.manifest.project_id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real detached CLI Studio child readiness/idempotence, credential isolation, stale/unrelated identity and owned stop', async () => {
  const root = await fixture(); const assets = await mkdtemp(path.join(os.tmpdir(), 'byeori CLI assets ')); let original: string | null = null;
  try {
    await writeFile(path.join(assets, 'index.html'), '<!doctype html><html><body>CLI synthetic assets</body></html>');
    const started = await cli<StudioRuntime>(root, 'studio', ['--action', 'start', '--assets', assets]); assert.equal(started.data!.state, 'running'); const record = path.join(root, 'planning/.runtime/studio.yaml'); original = await readFile(record, 'utf8'); const runtime = parseYaml(original) as unknown as { management_secret: string; owner: { process: { start_identity: string } } }; assert.ok(!started.stdout.includes(runtime.management_secret)); assert.equal(new URL(started.data!.url!).hostname, '127.0.0.1');
    assert.deepEqual((await cli(root, 'studio', ['--action', 'start', '--assets', assets])).data, started.data); assert.deepEqual((await cli(root, 'studio', ['--action', 'status'])).data, started.data);
    await rm(path.join(root, '.byeori'), { recursive: true, force: true }); assert.equal((await cli<StudioRuntime>(root, 'studio', ['--action', 'status'])).data!.state, 'running');
    runtime.owner.process.start_identity = 'unrelated-start'; await writeFile(record, stringify(runtime)); await cli(root, 'studio', ['--action', 'status'], 5); await cli(root, 'studio', ['--action', 'stop'], 5); assert.match(await readFile(record, 'utf8'), /unrelated-start/); await writeFile(record, original);
    await cli(root, 'studio', ['--action', 'stop']); assert.equal((await cli<StudioRuntime>(root, 'studio', ['--action', 'status'])).data!.state, 'stopped');
    await new Promise(resolve => setTimeout(resolve, 150)); await writeFile(record, original, { mode: 0o600 }); assert.equal((await cli<StudioRuntime>(root, 'studio', ['--action', 'status'])).data!.state, 'stopped'); await cli(root, 'studio', ['--action', 'start', '--assets', assets], 4); await cli(root, 'studio', ['--action', 'stop']); original = null;
    await cli(root, 'studio', ['--action', 'start', '--assets', path.join(assets, 'missing')], 1); await cli(root, 'studio', ['--action', 'status', '--assets', assets], 2);
  } finally { if (original) { await writeFile(path.join(root, 'planning/.runtime/studio.yaml'), original, { mode: 0o600 }); await stopOwnedStudio(root); } await rm(root, { recursive: true, force: true }); await rm(assets, { recursive: true, force: true }); }
});
