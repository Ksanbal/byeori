import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { initializeWorkspace, currentBinding, createChange, putDraft, readDraft, readChange, updateChange, readProjectedChange, deleteDraft, moveDraft, readWorkflow, writeWorkflow, workspaceIdentity } from '../../src/core/workspace';
import { CoreError } from '../../src/core/errors';
import { decodeRouteSegment, relativePath, safePath } from '../../src/core/paths';
import { parseDocument } from '../../src/core/documents';
import type { ChangeMetadata } from '../../src/contracts';
import { readFileSync, readdirSync } from 'node:fs';

const run = promisify(execFile);
const metadata: ChangeMetadata = { type: 'spec_change', title: 'Initial planning', request: 'Create planning', reason: 'Describe the product', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } };
async function temp(action: (root: string) => Promise<void>): Promise<void> { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori 한글 space-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function denied(action: () => Promise<unknown>, code: string): Promise<void> { await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === code); }
const fixtures = new URL('../fixtures/planning/', import.meta.url);

test('non-Node init is idempotent and preserves instructions/ignore/content', async () => temp(async root => {
  await writeFile(path.join(root, '.gitignore'), 'custom-rule\n'); await writeFile(path.join(root, 'AGENTS.md'), 'User instructions\n');
  const config = await initializeWorkspace(root); const again = await initializeWorkspace(root, 'Different optional name');
  assert.equal(JSON.stringify(again), JSON.stringify(config));
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('custom-rule\n')); assert.equal(ignore.split('# byeori:begin').length, 2); assert.ok(ignore.includes('/planning/.runtime/'));
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'User instructions\n');
  assert.equal(config.genesis_manifest.entries.length, 0);
}));

test('lossless malformed draft persists across restart/cache removal, with version conflicts', async () => temp(async root => {
  await initializeWorkspace(root); const binding = await currentBinding(root); const change = await createChange(root, { ...binding, metadata });
  const raw = '\uFEFF# keep exact BOM and CRLF\r\ntitle: [unfinished\r\n';
  const result = await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-ONE', kind: 'prd', path: 'planning/source/prd.yaml', raw });
  assert.equal(result.draft?.raw, raw); assert.equal(result.draft?.valid, false); assert.ok(result.diagnostics.length);
  await rm(path.join(root, '.byeori'), { recursive: true, force: true });
  assert.equal(await readDraft(root, change.change_id, 'PRD-ONE'), raw);
  assert.equal((await readChange(root, change.change_id)).version, result.change.version);
  await denied(() => putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-ONE', kind: 'prd', path: 'planning/source/prd.yaml', raw: 'different' }), 'CONFLICT');
  await denied(() => readProjectedChange(root, change.change_id), 'VALIDATION_FAILED');
  assert.equal(await readDraft(root, change.change_id, 'PRD-ONE'), raw);
  const changed = await updateChange(root, { ...binding, change_id: change.change_id, expected_version: result.change.version, metadata: { ...metadata, reason: 'New reason' } });
  assert.notEqual(changed.version, result.change.version);
  await denied(() => createChange(root, { ...binding, metadata }), 'CONFLICT');
}));

test('all nine drafts project a complete validated source without writing current source', async () => temp(async root => {
  await initializeWorkspace(root); const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata });
  for (const name of readdirSync(fixtures).filter(name => name.endsWith('.yaml'))) {
    const raw = readFileSync(new URL(name, fixtures), 'utf8'); const document = parseDocument({ path: 'planning/source/' + name, raw });
    change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: document.id, kind: document.kind, path: document.path, raw })).change;
  }
  assert.equal((await readProjectedChange(root, change.change_id)).length, 9);
  const moved = await moveDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', path: 'planning/source/renamed-prd.yaml' });
  assert.ok((await readProjectedChange(root, change.change_id)).some(document => document.path.endsWith('/renamed-prd.yaml')));
  const deleted = await deleteDraft(root, { ...binding, change_id: change.change_id, expected_version: moved.version, object_id: 'PRD-DEMO-001' });
  assert.equal((await readProjectedChange(root, deleted.change_id)).length, 8);
  await denied(() => moveDraft(root, { ...binding, change_id: deleted.change_id, expected_version: deleted.version, object_id: 'NO-OBJECT', path: 'planning/source/no.yaml' }), 'VALIDATION_FAILED');
}));

test('safe paths reject traversal, encodings, source collisions and symlink ancestors', async () => temp(async root => {
  for (const value of ['../escape', '/etc/passwd', 'a//b', 'a/./b', 'a/../b', 'C:/file', 'a\\b', 'a%2fb', 'a\0b']) assert.throws(() => relativePath(value), CoreError);
  for (const value of ['%2e%2e', '%252e%252e', 'x%2fy', '%ZZ']) assert.throws(() => decodeRouteSegment(value), CoreError);
  assert.equal(decodeRouteSegment('valid-id'), 'valid-id');
  await initializeWorkspace(root); const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata });
  const prdRaw = readFileSync(new URL('prd.yaml', fixtures), 'utf8');
  change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', raw: prdRaw })).change;
  await denied(() => putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-TWO', kind: 'prd', path: 'planning/source/PRD.yaml', raw: 'incomplete' }), 'CONFLICT');
  await symlink(os.tmpdir(), path.join(root, 'planning/source/linked'));
  await denied(() => safePath(root, 'planning/source/linked/outside.yaml'), 'PATH_DENIED');
  await denied(() => putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-TWO', kind: 'prd', path: 'planning/source/linked/outside.yaml', raw: prdRaw }), 'PATH_DENIED');
  await rm(path.join(root, 'planning/source/linked'));
  await writeFile(path.join(root, 'planning/source/Case.yaml'), 'original');
  await denied(() => safePath(root, 'planning/source/case.yaml'), 'PATH_DENIED');
}));

test('workflow preserves answers/assumptions/questions and rejects concurrent saves', async () => temp(async root => {
  await initializeWorkspace(root); const binding = await currentBinding(root); const current = await readWorkflow(root);
  const saved = await writeWorkflow(root, { ...binding, expected_version: current.version, workflow: { ...current, facts: [{ id: 'answer-1', text: 'Known answer' }], assumptions: [{ id: 'assumption-1', text: 'Needs confirmation' }], open_questions: [{ id: 'question-1', text: 'Next question', blocking: true }], next_action: 'Ask next question' } });
  assert.equal(JSON.stringify(await readWorkflow(root)), JSON.stringify(saved));
  await denied(() => writeWorkflow(root, { ...binding, expected_version: current.version, workflow: current }), 'CONFLICT');
  await denied(() => writeWorkflow(root, { ...binding, expected_version: saved.version, workflow: { ...saved, correction_attempts: [{ change_id: 'change-1', ordinary: 3, escalation: 0 }] } }), 'VALIDATION_FAILED');
}));

test('Git branch/workspace binding is observed, and foreign/root bindings deny writes', async () => temp(async root => {
  await run('git', ['init', '-b', 'main', root]); await initializeWorkspace(root);
  const identity = await workspaceIdentity(root); assert.equal(identity.git?.branch_ref, 'refs/heads/main');
  const binding = await currentBinding(root); const change = await createChange(root, { ...binding, metadata });
  await denied(() => updateChange(root, { ...binding, project_id: 'different-project', change_id: change.change_id, expected_version: change.version, metadata }), 'WORKSPACE_MISMATCH');
  await run('git', ['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/other']);
  assert.notEqual((await currentBinding(root)).workspace_fingerprint, binding.workspace_fingerprint);
  await denied(() => readChange(root, change.change_id), 'WORKSPACE_MISMATCH');
}));
