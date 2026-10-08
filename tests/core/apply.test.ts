import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import type { ChangeMetadata, ReviewSubmission } from '../../src/contracts';
import { apply, recover } from '../../src/core/apply';
import { CoreError } from '../../src/core/errors';
import { prepareReview, roundBinding, saveReviewDraft, sourceHead, submitReview } from '../../src/core/review';
import { createChange, currentBinding, deleteDraft, initializeWorkspace, moveDraft, putDraft, updateChange } from '../../src/core/workspace';
import { parseYaml } from '../../src/core/yaml';

const metadata: ChangeMetadata = { type: 'spec_change', title: 'Planning', request: 'Create docs', reason: 'Establish requirements', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } };
async function temp(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori apply-')); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function deny(action: () => Promise<unknown>, code: string) { await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === code); }
async function approved(root: string, meta = metadata, seed = true) {
  const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata: meta });
  if (seed) for (const [name, id, kind] of [['prd', 'PRD-DEMO-001', 'prd'], ['actor', 'ACT-WORKER-001', 'actor']] as const) change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: id, kind, path: 'planning/source/' + name + '.yaml', raw: readFileSync(new URL('../fixtures/planning/' + name + '.yaml', import.meta.url), 'utf8') })).change;
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version });
  const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: meta.implementation_scope.allowlist.length ? { allowed: true as const, scope_hash: round.manifest.scope_hash } : { allowed: false as const, scope_hash: null } };
  const draft = await saveReviewDraft(root, { ...body, expected_version: null }); const submission: ReviewSubmission = { ...body, schema_version: 1, submission_id: 'submission-' + change.change_id, expected_feedback_version: draft.version, final_confirmation: true }; await submitReview(root, submission); return { binding, change, round, submission };
}

test('apply uses frozen after and durable chain; replay after apply; implementation-only no-op names predecessor', async () => temp(async root => {
  const first = await approved(root); const applied = await apply(root, roundBinding(first.round)); assert.equal((await sourceHead(root)).change_id, first.change.change_id);
  assert.equal((await apply(root, roundBinding(first.round))).transaction_id, applied.transaction_id); assert.equal((await submitReview(root, first.submission)).replayed, true);
  await deny(() => updateChange(root, { ...first.binding, change_id: first.change.change_id, expected_version: first.change.version, metadata }), 'CONFLICT');
  const scope = { allowlist: [{ path: 'src', match: 'directory' as const }], related_object_ids: ['PRD-DEMO-001'], validation_plan: ['Run unit tests'] };
  const second = await approved(root, { ...metadata, type: 'implementation_only', reason: 'Implement approved product', implementation_scope: scope }, false);
  assert.equal(second.round.manifest.base_source_hash, second.round.manifest.target_source_hash); assert.equal(second.round.manifest.base_applied_change_id, first.change.change_id);
  const next = await apply(root, roundBinding(second.round)); assert.equal(next.base_applied_change_id, first.change.change_id); assert.equal((await sourceHead(root)).change_id, second.change.change_id);
  assert.equal((await submitReview(root, first.submission)).replayed, true);
  const child = fork(fileURLToPath(new URL('../fixtures/receipt-child.ts', import.meta.url)), [root, Buffer.from(JSON.stringify(first.submission)).toString('base64url')], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); const exited = once(child, 'exit');
  try { const [receipt] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Restarted receipt reader exited before replay'); })]); assert.equal(receipt.replayed, true); assert.equal(receipt.payload_hash, (await submitReview(root, first.submission)).payload_hash); assert.equal((await exited)[0], 0); }
  finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  await writeFile(path.join(root, 'planning/source/unplanned.yaml'), readFileSync(new URL('../fixtures/planning/entity.yaml', import.meta.url), 'utf8'));
  await deny(() => sourceHead(root), 'SOURCE_DRIFT');
}));

test('delete/move entire after validation preserves frozen before and old chain', async () => temp(async root => {
  const first = await approved(root); await apply(root, roundBinding(first.round)); const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata });
  change = await deleteDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'ACT-WORKER-001' });
  change = await moveDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', path: 'planning/source/nested/moved.yaml' });
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version });
  const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } };
  const draft = await saveReviewDraft(root, { ...body, expected_version: null }); await submitReview(root, { ...body, schema_version: 1, submission_id: 'delete-move', expected_feedback_version: draft.version, final_confirmation: true });
  await apply(root, roundBinding(round)); assert.equal((await sourceHead(root)).manifest.entries.length, 1);
  assert.ok((await readFile(path.join(root, first.round.manifest.deltas.find(delta => delta.object_id === 'ACT-WORKER-001')!.after!.snapshot_path), 'utf8')).includes('ACT-WORKER-001'));
  assert.ok((await readFile(path.join(root, 'planning/source/nested/moved.yaml'), 'utf8')).includes('PRD-DEMO-001'));
}));

test('metadata/policy/snapshot/source drift rejects apply; direct metadata is only invalidation input', async () => temp(async root => {
  const current = await approved(root); const recordPath = path.join(root, 'planning/changes', current.change.change_id, 'change.yaml');
  const original = await readFile(recordPath, 'utf8'); const mutable = parseYaml(original) as Record<string, unknown>; mutable.metadata = { ...metadata, reason: 'Unreviewed mutation' }; await writeFile(recordPath, stringify(mutable));
  await deny(() => apply(root, roundBinding(current.round)), 'STALE_REVIEW'); await writeFile(recordPath, original);
  const manifestPath = path.join(root, 'planning/changes', current.change.change_id, 'rounds/1/manifest.yaml'); const manifestOriginal = await readFile(manifestPath, 'utf8'); const badPolicy = parseYaml(manifestOriginal) as { manifest: { policy_version: string } }; badPolicy.manifest.policy_version = 'future'; await writeFile(manifestPath, stringify(badPolicy));
  await deny(() => apply(root, roundBinding(current.round)), 'POLICY_MISMATCH'); await writeFile(manifestPath, manifestOriginal);
  await writeFile(path.join(root, 'planning/source/prd.yaml'), readFileSync(new URL('../fixtures/planning/prd.yaml', import.meta.url), 'utf8'));
  await deny(() => apply(root, roundBinding(current.round)), 'SOURCE_DRIFT');
}));

test('applied receipt precedes cache tail; a failed cache refresh does not duplicate apply', async () => temp(async root => {
  const current = await approved(root); await assert.rejects(() => apply(root, roundBinding(current.round), { async refreshCache() { throw new Error('cache unavailable'); } }));
  const head = await sourceHead(root); assert.equal(head.change_id, current.change.change_id); const retry = await apply(root, roundBinding(current.round)); assert.equal(retry.transaction_id, head.applied!.transaction_id);
  assert.equal((await recover(root, { ...current.binding, change_id: current.change.change_id, action: 'inspect' })).transaction!.phase, 'completed');
}));
