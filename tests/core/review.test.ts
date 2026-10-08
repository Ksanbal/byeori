import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import type { ChangeMetadata, ReviewComment, ReviewRound, ReviewSubmission } from '../../src/contracts';
import { CoreError } from '../../src/core/errors';
import { currentBinding, createChange, deleteDraft, initializeWorkspace, putDraft, updateChange } from '../../src/core/workspace';
import { apply } from '../../src/core/apply';
import { parseDocument } from '../../src/core/documents';
import { activeChanges, prepareReview, respond, reviewResults, roundBinding, saveReviewDraft, submitReview } from '../../src/core/review';
import { parseYaml, semanticHash } from '../../src/core/yaml';

const metadata: ChangeMetadata = { type: 'spec_change', title: 'Planning', request: 'Create initial docs', reason: 'Document product', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } };
async function temp(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori review-')); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function deny(action: () => Promise<unknown>, code: string) { await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === code); }
async function setup(root: string) {
  const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata });
  for (const [name, id, kind] of [['prd', 'PRD-DEMO-001', 'prd'], ['actor', 'ACT-WORKER-001', 'actor']] as const) change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: id, kind, path: 'planning/source/' + name + '.yaml', raw: readFileSync(new URL('../fixtures/planning/' + name + '.yaml', import.meta.url), 'utf8') })).change;
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); return { binding, change, round };
}
function feedback(round: ReviewRound, decision: 'approve' | 'pending' | 'request_changes' = 'approve') { return { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision, comments: [] as ReviewComment[] })), implementation_authorization: { allowed: false as const, scope_hash: null } }; }
async function final(root: string, round: ReviewRound, submissionId: string, body = feedback(round)): Promise<ReviewSubmission> { const draft = await saveReviewDraft(root, { ...body, expected_version: null }); const submission: ReviewSubmission = { ...body, schema_version: 1, submission_id: submissionId, expected_feedback_version: draft.version, final_confirmation: true }; await submitReview(root, submission); return submission; }

test('mixed final judgment stays needs_revision; autosave does not approve; next round/replay persists', async () => temp(async root => {
  const { round, change, binding } = await setup(root); const body = feedback(round); body.items[1].decision = 'pending';
  const draft = await saveReviewDraft(root, { ...body, expected_version: null });
  assert.equal((await reviewResults(root, roundBinding(round))).approval.documents_approved, false);
  const submission: ReviewSubmission = { ...body, schema_version: 1, submission_id: 'mixed-1', expected_feedback_version: draft.version, final_confirmation: true }; await submitReview(root, submission);
  assert.equal((await activeChanges(root))[0].state, 'needs_revision');
  await deny(() => saveReviewDraft(root, { ...body, expected_version: draft.version }), 'CONFLICT');
  await deny(() => submitReview(root, { ...submission, submission_id: 'mixed-2' }), 'CONFLICT');
  const next = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); assert.equal(next.manifest.round, 2);
  assert.equal((await reviewResults(root, roundBinding(next))).accepted_submission, null);
  assert.equal((await submitReview(root, submission)).replayed, true);
  await deny(() => submitReview(root, { ...submission, items: feedback(round).items }), 'CONFLICT');
}));

test('two saved tabs conflict; submit requires exact latest saved version/body; distinct final IDs race', async () => temp(async root => {
  const { round } = await setup(root); const body = feedback(round); const first = await saveReviewDraft(root, { ...body, expected_version: null });
  const other = feedback(round, 'pending'); const second = await saveReviewDraft(root, { ...other, expected_version: first.version });
  await deny(() => saveReviewDraft(root, { ...body, expected_version: first.version }), 'CONFLICT');
  const stale: ReviewSubmission = { ...body, schema_version: 1, submission_id: 'stale', expected_feedback_version: first.version, final_confirmation: true }; await deny(() => submitReview(root, stale), 'CONFLICT');
  await deny(() => submitReview(root, { ...stale, expected_feedback_version: second.version }), 'CONFLICT');
  const saved = await saveReviewDraft(root, { ...body, expected_version: second.version });
  const input = { ...stale, expected_feedback_version: saved.version };
  const outcomes = await Promise.allSettled([submitReview(root, { ...input, submission_id: 'race-1' }), submitReview(root, { ...input, submission_id: 'race-2' })]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(value => value.status === 'rejected') as PromiseRejectedResult; assert.ok(rejected.reason instanceof CoreError); assert.equal(rejected.reason.diagnostics[0].code, 'CONFLICT', rejected.reason.message);
  assert.equal((await reviewResults(root, roundBinding(round))).approval.documents_approved, true);
}));

test('metadata, scope, policy, source and frozen snapshot mutation fail closed', async () => temp(async root => {
  const { binding, round, change } = await setup(root); await final(root, round, 'approved');
  const modified = await updateChange(root, { ...binding, change_id: change.change_id, expected_version: change.version, metadata: { ...metadata, reason: 'Changed reason' } }); assert.notEqual(modified.version, change.version);
  assert.equal((await reviewResults(root, roundBinding(round))).approval.documents_approved, false);
  const next = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: modified.version });
  await writeFile(path.join(root, next.manifest.deltas[0].after!.snapshot_path), 'corrupt');
  await assert.rejects(() => reviewResults(root, roundBinding(next)), CoreError);
}));

test('stable comment targets and response dedupe never resolve human approval', async () => temp(async root => {
  const { binding, round, change } = await setup(root); const body = feedback(round, 'request_changes'); const item = body.items.find(item => item.item_id === 'document:PRD-DEMO-001')!;
  item.comments.push({ id: 'comment-1', kind: 'change_request', body: 'Revise purpose', blocking: true, target: { object_id: 'PRD-DEMO-001', element_id: null, field: 'purpose', operation_id: null, pointer: '/purpose' } });
  const input = await final(root, round, 'feedback-1', body);
  const response = { ...roundBinding(round), submission_id: input.submission_id, response_id: 'response-1', expected_change_version: change.version, comments: [{ comment_id: 'comment-1', result: 'addressed_in_draft' as const, changed_paths: ['planning/source/prd.yaml'], rationale: 'Proposed revision' }] };
  await respond(root, response); await respond(root, { ...response, expected_change_version: '0'.repeat(64) });
  await deny(() => respond(root, { ...response, response_id: 'response-2' }), 'CONFLICT');
  const result = await reviewResults(root, roundBinding(round)); assert.deepEqual(result.processed_comment_ids, ['comment-1']); assert.equal(result.approval.documents_approved, false);
  const next = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); const invalid = feedback(next); invalid.items.find(item => item.item_id === item.item_id)!.comments.push({ ...item.comments[0], target: { ...item.comments[0].target, pointer: '/goals/0/text' } });
  await deny(() => saveReviewDraft(root, { ...invalid, expected_version: null }), 'VALIDATION_FAILED');
}));

test('receipt persistence lost response replays before changed metadata freshness', async () => temp(async root => {
  const { binding, change, round } = await setup(root); const draft = await saveReviewDraft(root, { ...feedback(round), expected_version: null }); const input: ReviewSubmission = { ...feedback(round), schema_version: 1, submission_id: 'lost-response', expected_feedback_version: draft.version, final_confirmation: true };
  await assert.rejects(() => submitReview(root, input, { async afterBoundary(boundary) { if (boundary === 'write:planning/reviews/submissions/lost-response.yaml') throw new Error('lost response'); } }));
  await updateChange(root, { ...binding, change_id: change.change_id, expected_version: change.version, metadata: { ...metadata, reason: 'New metadata' } });
  assert.equal((await submitReview(root, input)).payload_hash, semanticHash(input)); assert.equal((await submitReview(root, input)).replayed, true);
  assert.equal((await activeChanges(root))[0].state, 'needs_revision');
  assert.ok(stringify(input).includes('final_confirmation: true'));
}));

test('all nine runtime review snapshots preserve stable native/API comments and reject invalid projected deletion', async () => temp(async root => {
  const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata }); const fixtures = new URL('../fixtures/planning/', import.meta.url);
  for (const name of readdirSync(fixtures).filter(name => name.endsWith('.yaml'))) { const raw = readFileSync(new URL(name, fixtures), 'utf8'); const document = parseDocument({ path: 'planning/source/' + name, raw }); change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: document.id, kind: document.kind, path: document.path, raw })).change; }
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); assert.equal(round.manifest.items.length, 9); const body = feedback(round);
  const scenario = parseYaml(readFileSync(new URL('scenario.yaml', fixtures), 'utf8')) as { steps: { id: string }[] };
  const native = body.items.find(item => item.item_id === 'document:SCN-MSG-001')!; native.comments.push({ id: 'stable-step', kind: 'note', body: 'Step reviewed', blocking: false, target: { object_id: 'SCN-MSG-001', element_id: scenario.steps[0].id, field: 'action', operation_id: null, pointer: '/steps/0/action' } });
  const api = body.items.find(item => item.item_id === 'document:API-MSG-001')!; api.comments.push({ id: 'stable-operation', kind: 'note', body: 'Request body reviewed', blocking: false, target: { object_id: 'API-MSG-001', element_id: null, field: 'requestBody', operation_id: 'sendMessage', pointer: '/paths/~1messages/post/requestBody/content/application~1json/schema/properties/body' } });
  const invalid = structuredClone(body); invalid.items.find(item => item.item_id === native.item_id)!.comments[0].target.element_id = null; await deny(() => saveReviewDraft(root, { ...invalid, expected_version: null }), 'VALIDATION_FAILED');
  const invalidIdentity = structuredClone(body); invalidIdentity.items.find(item => item.item_id === native.item_id)!.comments[0].target.pointer = '/steps/1/action'; await deny(() => saveReviewDraft(root, { ...invalidIdentity, expected_version: null }), 'VALIDATION_FAILED');
  await final(root, round, 'nine-kinds', body); await apply(root, roundBinding(round)); const next = await createChange(root, { ...binding, metadata }); const deleted = await deleteDraft(root, { ...binding, change_id: next.change_id, expected_version: next.version, object_id: 'ACT-WORKER-001' }); await deny(() => prepareReview(root, { ...binding, change_id: next.change_id, expected_version: deleted.version }), 'VALIDATION_FAILED');
}));
