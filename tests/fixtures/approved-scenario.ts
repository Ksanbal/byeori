import { readFileSync } from 'node:fs';
import type { ChangeMetadata, ReviewSubmission } from '../../src/contracts';
import { prepareReview, roundBinding, saveReviewDraft, submitReview } from '../../src/core/review';
import { createChange, currentBinding, putDraft } from '../../src/core/workspace';
import { deleteDraft, moveDraft } from '../../src/core/workspace';
import { apply } from '../../src/core/apply';

/** Test orchestration invokes real separate save+human submit; no runtime approval bypass. */
export async function approvedScenario(root: string, scope = false) {
  const binding = await currentBinding(root);
  const metadata: ChangeMetadata = { type: 'spec_change', title: 'Synthetic planning', request: 'Create docs', reason: 'Test real persistence', affected_object_ids: [], implementation_scope: scope ? { allowlist: [{ path: 'src', match: 'directory' }, { path: 'README.md', match: 'file' }], related_object_ids: ['PRD-DEMO-001'], validation_plan: ['Run unit tests'] } : { allowlist: [], related_object_ids: [], validation_plan: [] } };
  let change = await createChange(root, { ...binding, metadata });
  for (const [name, id, kind] of [['prd', 'PRD-DEMO-001', 'prd'], ['actor', 'ACT-WORKER-001', 'actor']] as const) change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: id, kind, path: 'planning/source/' + name + '.yaml', raw: readFileSync(new URL('planning/' + name + '.yaml', import.meta.url), 'utf8') })).change;
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version });
  const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: scope ? { allowed: true as const, scope_hash: round.manifest.scope_hash } : { allowed: false as const, scope_hash: null } };
  const draft = await saveReviewDraft(root, { ...body, expected_version: null }); const submission: ReviewSubmission = { ...body, schema_version: 1, submission_id: 'test-' + change.change_id, expected_feedback_version: draft.version, final_confirmation: true }; await submitReview(root, submission);
  return { binding, change, round, submission };
}
export async function approvedDeletionMove(root: string) {
  const original = await approvedScenario(root); await apply(root, roundBinding(original.round)); const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata: original.change.metadata });
  change = await deleteDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'ACT-WORKER-001' });
  change = await moveDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', path: 'planning/source/nested/moved.yaml' });
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } }; const draft = await saveReviewDraft(root, { ...body, expected_version: null }); const submission: ReviewSubmission = { ...body, schema_version: 1, submission_id: 'move-' + change.change_id, expected_feedback_version: draft.version, final_confirmation: true }; await submitReview(root, submission); return { binding, change, round, submission };
}
