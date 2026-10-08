import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { apply } from '../../src/core/apply';
import { CoreError } from '../../src/core/errors';
import { cancelChange, prepareReview, roundBinding, saveReviewDraft, submitReview } from '../../src/core/review';
import { createHumanReview, createReviewCore } from '../../src/core/services';
import { gateCheck, get, history, selectAdvisory, status } from '../../src/core/state';
import { createChange, currentBinding, deleteDraft, initializeWorkspace, putDraft } from '../../src/core/workspace';
import { parseYaml } from '../../src/core/yaml';
import { approvedScenario } from '../fixtures/approved-scenario';

async function temp(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori state-')); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function deny(action: () => Promise<unknown>, code: string) { await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === code); }

test('gate requires completed apply+fresh authorization+all frozen paths and actual hook or human advisory', async () => temp(async root => {
  const scenario = await approvedScenario(root, true); const gate = { ...scenario.binding, host: 'codex' as const, tool: 'edit', operation: 'implementation_write' as const, paths: ['src/new.ts'] };
  await deny(() => gateCheck(root, gate), 'HOOK_NOT_ACTIVE'); await selectAdvisory(root, { host: 'codex', reason: 'Native host unavailable; explicitly use advisory' }); await deny(() => gateCheck(root, gate), 'REVIEW_REQUIRED');
  await apply(root, roundBinding(scenario.round)); const allowed = await gateCheck(root, gate); assert.equal(allowed.protection, 'advisory'); assert.equal(allowed.authorization_manifest_hash, scenario.round.manifest_hash);
  for (const paths of [['src2/file.ts'], ['README.md/extra'], ['src/new.ts', 'other.ts'], ['planning/changes/fake.yaml'], ['.git/config'], []]) await deny(() => gateCheck(root, { ...gate, paths }), 'SCOPE_DENIED');
  assert.equal((await gateCheck(root, { ...gate, paths: ['README.md'] })).allowed, true); await deny(() => gateCheck(root, { ...gate, operation: 'unknown' }), 'SCOPE_DENIED');
  await symlink(os.tmpdir(), path.join(root, 'src')); await deny(() => gateCheck(root, gate), 'PATH_DENIED'); await rm(path.join(root, 'src'));
  const record = await status(root); assert.equal(record.source_integrity.state, 'valid'); assert.equal(record.implementation_authorization.state, 'authorized'); assert.equal(record.implementation_status, 'unverified');
  const file = path.join(root, 'planning/changes', scenario.change.change_id, 'change.yaml'); const value = parseYaml(await readFile(file, 'utf8')) as { metadata: { reason: string } }; value.metadata.reason = 'Unreviewed new reason'; await writeFile(file, stringify(value));
  await deny(() => gateCheck(root, gate), 'REVIEW_REQUIRED'); assert.equal((await status(root)).implementation_authorization.state, 'stale');
}));

test('a newer planning-only apply cannot inherit older implementation scope; source formatting alone remains semantic', async () => temp(async root => {
  const first = await approvedScenario(root, true); await selectAdvisory(root, { host: 'claude', reason: 'Explicit human advisory' }); await apply(root, roundBinding(first.round)); const binding = await currentBinding(root);
  const prdPath = path.join(root, 'planning/source/prd.yaml'); const original = await readFile(prdPath, 'utf8'); await writeFile(prdPath, '# formatting only\n' + original);
  const gate = { ...binding, host: 'claude' as const, tool: 'edit', operation: 'implementation_write' as const, paths: ['src/main.ts'] }; assert.equal((await gateCheck(root, gate)).allowed, true);
  let change = await createChange(root, { ...binding, metadata: { ...first.change.metadata, implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } } }); const value = parseYaml(original) as { title: string }; value.title = 'New planning';
  change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', raw: stringify(value) })).change;
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } }; const draft = await saveReviewDraft(root, { ...body, expected_version: null }); await submitReview(root, { ...body, schema_version: 1, submission_id: 'planning-only', expected_feedback_version: draft.version, final_confirmation: true }); await apply(root, roundBinding(round));
  await deny(() => gateCheck(root, gate), 'REVIEW_REQUIRED'); assert.equal((await status(root)).implementation_authorization.state, 'none');
  await writeFile(prdPath, 'invalid user text'); await deny(() => get(root, { object_id: 'PRD-DEMO-001' }), 'SOURCE_DRIFT'); assert.equal((await status(root)).source_integrity.state, 'drift');
}));

test('deleted historical object remains queryable; cancellation permits one new active change; Core excludes human submit', async () => temp(async root => {
  const first = await approvedScenario(root); await apply(root, roundBinding(first.round)); const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata: first.change.metadata });
  change = await deleteDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'ACT-WORKER-001' }); const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } }; const draft = await saveReviewDraft(root, { ...body, expected_version: null }); await submitReview(root, { ...body, schema_version: 1, submission_id: 'delete-history', expected_feedback_version: draft.version, final_confirmation: true }); await apply(root, roundBinding(round));
  const before = await get(root, { object_id: 'ACT-WORKER-001', revision: { change_id: change.change_id, round: round.manifest.round, manifest_hash: round.manifest_hash, side: 'before' } }); assert.equal(before.provenance, 'review_snapshot'); assert.ok(before.raw.includes('ACT-WORKER-001')); await deny(() => get(root, { object_id: 'ACT-WORKER-001' }), 'VALIDATION_FAILED');
  assert.ok((await history(root, { object_id: 'ACT-WORKER-001', limit: 100 })).entries.some(entry => entry.type === 'applied'));
  const next = await createChange(root, { ...binding, metadata: first.change.metadata }); await cancelChange(root, { ...binding, change_id: next.change_id, expected_version: next.version, reason: 'No longer needed' }); assert.equal((await status(root)).active_change, null); const last = await createChange(root, { ...binding, metadata: first.change.metadata }); assert.equal((await status(root)).active_change?.change_id, last.change_id);
  const core = createReviewCore(root); assert.equal(Object.hasOwn(core, 'submitReview'), false); assert.equal((await core.status()).ok, true); const human = createHumanReview(root); assert.equal(typeof human.submitReview, 'function');
}));

test('implementation-blocking questions prevent allowed permission despite approved item decisions', async () => temp(async root => {
  const scenario = await approvedScenario(root, true); const raw = await readFile(path.join(root, scenario.round.manifest.deltas.find(delta => delta.object_id === 'PRD-DEMO-001')!.after!.snapshot_path), 'utf8'); const content = parseYaml(raw) as { open_questions: unknown[] }; content.open_questions = [{ id: 'required-question', text: 'Resolve before implementation', blocking: true }];
  const changed = await putDraft(root, { ...scenario.binding, change_id: scenario.change.change_id, expected_version: scenario.change.version, object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', raw: stringify(content) }); const round = await prepareReview(root, { ...scenario.binding, change_id: scenario.change.change_id, expected_version: changed.change.version }); const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: true as const, scope_hash: round.manifest.scope_hash } }; const draft = await saveReviewDraft(root, { ...body, expected_version: null });
  await deny(() => submitReview(root, { ...body, schema_version: 1, submission_id: 'invalid-stage', expected_feedback_version: draft.version, final_confirmation: true }), 'REVIEW_REQUIRED');
}));
