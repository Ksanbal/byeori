import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { ReviewDraft, ReviewResults, ReviewSubmission, StudioState, SubmissionReceipt } from '../../src/contracts';
import { prepareReview, roundBinding } from '../../src/core/review';
import { approvedScenario } from '../fixtures/approved-scenario';
import { browserSession, http, serverCase } from './helpers';

test('real browser bootstrap only creates authenticated session; Core mixed save/conflict/submit/replay remain durable', async () => serverCase(async (root, _, handle) => {
  const url = handle.runtime.url!; const scenario = await approvedScenario(root);
  const round = await prepareReview(root, { ...scenario.binding, change_id: scenario.change.change_id, expected_version: scenario.change.version });
  const session = await browserSession(url); const state = (await session.get('/api/state')).result<StudioState>(); assert.equal(state.ok, true);
  if (state.ok) { assert.equal(state.data.review?.accepted_submission, null); assert.equal(state.data.review?.approval.documents_approved, false); }
  const body = { ...roundBinding(round), items: round.manifest.items.map((item, index) => ({ item_id: item.item_id, decision: index === 0 ? 'approve' as const : 'request_changes' as const, comments: index === 0 && item.type === 'document' ? [{ id: 'untrusted-comment', kind: 'note' as const, body: '<img src=x onerror="evil()">', blocking: false, target: { object_id: item.object_id, element_id: null, field: null, operation_id: null, pointer: null } }] : [] })), implementation_authorization: { allowed: false as const, scope_hash: null } };
  const savedReply = await session.post('/api/review/draft', { ...body, expected_version: null }); assert.equal(savedReply.status, 200); const saved = savedReply.result<ReviewDraft>(); assert.equal(saved.ok, true); if (!saved.ok) throw new Error('Save failed');
  const file = path.join(root, 'planning/changes', scenario.change.change_id, 'rounds', String(round.manifest.round), 'feedback-draft.yaml'); const raw = await readFile(file, 'utf8');
  const conflict = await session.post('/api/review/draft', { ...body, expected_version: null }); assert.equal(conflict.status, 409); assert.equal(await readFile(file, 'utf8'), raw);
  const interim = (await session.post('/api/review/results', roundBinding(round))).result<ReviewResults>(); assert.equal(interim.ok, true); if (interim.ok) { assert.equal(interim.data.accepted_submission, null); assert.equal(interim.data.approval.documents_approved, false); }
  const submission: ReviewSubmission = { ...body, schema_version: 1, submission_id: 'http-human-final', expected_feedback_version: saved.data.version, final_confirmation: true };
  const stale = await session.post('/api/review/submit', { ...submission, expected_feedback_version: '0'.repeat(64) }); assert.equal(stale.status, 409);
  const submitted = await session.post('/api/review/submit', submission); assert.equal(submitted.status, 200); assert.equal(submitted.headers['content-type'], 'application/json; charset=utf-8'); const receipt = submitted.result<SubmissionReceipt>(); assert.equal(receipt.ok, true); if (receipt.ok) assert.equal(receipt.data.replayed, false);
  const freshSession = await browserSession(url); const replay = (await freshSession.post('/api/review/submit', submission)).result<SubmissionReceipt>(); assert.equal(replay.ok, true); if (replay.ok) assert.equal(replay.data.replayed, true);
  const final = (await session.post('/api/review/results', roundBinding(round))).result<ReviewResults>(); assert.equal(final.ok, true); if (final.ok) { assert.equal(final.data.approval.documents_approved, false); assert.equal(final.data.accepted_submission?.submission.items[0].comments[0].body, body.items[0].comments[0].body); }
  assert.equal((await session.post('/api/review/draft', { ...body, expected_version: saved.data.version })).status, 409);
  assert.deepEqual(await readdir(path.join(root, 'planning/source')), []);
  const historical = await session.post('/api/history', { change_id: scenario.change.change_id }); assert.equal(historical.status, 200);
  const document = await session.post('/api/document', { object_id: 'ACT-WORKER-001', revision: { ...roundBinding(round), side: 'after' } }); assert.equal(document.status, 200); assert.ok(document.raw.includes('ACT-WORKER-001'));
  const advisory = await session.post('/api/advisory', { host: 'codex', reason: 'Explicit HTTP human choice' }); assert.equal(advisory.status, 200); assert.ok(advisory.raw.includes('advisory')); assert.ok(advisory.raw.includes('"active":false'));
  assert.equal((await http(url, '/api/approve', 'POST', session.headers, '{}')).status, 404);
}));
