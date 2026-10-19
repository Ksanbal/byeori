import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { ReviewFeedback, ReviewResults, ReviewSubmission } from '../contracts';
import { CoreError, reject } from '../core/errors';
import { validateSource } from '../core/documents';
import { readText } from '../core/paths';
import { reviewResults, roundBinding, roundDocuments, saveReviewDraft, submitReview } from '../core/review';
import { status } from '../core/state';

export interface ReviewTerminal {
  write(text: string): void;
  question(prompt: string): Promise<string>;
  verifyHuman(): Promise<void>;
}
export function terminalText(text: string): string {
  return [...stripVTControlCharacters(text)].filter(character => {
    const point = character.codePointAt(0)!;
    return (point === 9 || point === 10 || point >= 32 && !(point >= 127 && point <= 159)) && !/\p{Cf}/u.test(character);
  }).join('');
}
export async function reviewInTerminal(root: string, io: ReviewTerminal): Promise<ReviewResults> {
  await io.verifyHuman();
  const state = await status(root);
  if (!state.active_change || !state.current_round || !state.manifest_hash) reject('REVIEW_REQUIRED', 'Prepare a frozen review before asking the human to review it.');
  const binding = {...state, change_id: state.active_change.change_id, round: state.current_round, manifest_hash: state.manifest_hash};
  const input = {project_id: binding.project_id, workspace_fingerprint: binding.workspace_fingerprint, change_id: binding.change_id, round: binding.round, manifest_hash: binding.manifest_hash};
  const loaded = await reviewResults(root, input);
  if (loaded.accepted_submission) reject('CONFLICT', 'This round already has a final judgment. Read results; prepare a new review only if a new human decision is needed.');
  if (loaded.approval.blockers.some(item => item.code !== 'REVIEW_REQUIRED')) reject('STALE_REVIEW', 'Resolve review integrity diagnostics before recording judgments.');
  const round = loaded.round; const manifest = round.manifest;
  const out = (text: string) => io.write(terminalText(text) + '\n');
  out(`BYEORI HUMAN REVIEW · round ${manifest.round}\nProject ${manifest.project_id}\nWorkspace ${JSON.stringify(manifest.workspace_identity.canonical_root)}\nFingerprint ${manifest.workspace_fingerprint}\nChange ${manifest.change_id}\nManifest ${round.manifest_hash}\nScope ${manifest.scope_hash}`);
  out(JSON.stringify(manifest.metadata, null, 2));
  for (const delta of manifest.deltas) {
    out(`\n${delta.operation.toUpperCase()} ${delta.object_id}`);
    for (const side of ['before', 'after'] as const) {
      const file = delta[side];
      if (file) {
        out(`--- FROZEN DOCUMENT ${side}: ${file.path}`);
        out(terminalText(await readText(root, file.snapshot_path)).split('\n').map(line => '| ' + line).join('\n'));
        out('--- END FROZEN DOCUMENT');
      }
    }
  }
  const feedback: ReviewFeedback = structuredClone(loaded.draft ? {items: loaded.draft.items, implementation_authorization: loaded.draft.implementation_authorization} : {items: manifest.items.map(item => ({item_id: item.item_id, decision: 'pending', comments: []})), implementation_authorization: {allowed: false, scope_hash: null}});
  let version = loaded.draft?.version ?? null;
  const save = async () => {
    await io.verifyHuman();
    const saved = await saveReviewDraft(root, {...input, ...feedback, expected_version: version});
    version = saved.version;
  };
  const choose = async (prompt: string, choices: string[]) => {
    while (true) {
      const answer = (await io.question(prompt)).trim();
      if (answer === 'quit') reject('REVIEW_REQUIRED', 'Review paused without final submission; saved judgments may be resumed.');
      if (choices.includes(answer)) return answer;
      out(`Type exactly one of: ${choices.join(', ')}. No default approval. Type quit to pause.`);
    }
  };
  for (const item of feedback.items) {
    out(`\nITEM ${item.item_id}; saved judgment=${item.decision}`);
    if (item.comments.length) out(`Saved comments\n${JSON.stringify(item.comments, null, 2)}`);
    const choice = await choose('Judgment [approve/request_changes/pending/keep/quit]: ', ['approve', 'request_changes', 'pending', 'keep']);
    if (choice !== 'keep') { item.decision = choice as typeof item.decision; if (choice !== 'approve') feedback.implementation_authorization = {allowed: false, scope_hash: null}; }
    const comment = await io.question('Whole-item comment (blank keeps; /clear removes saved comments; Ctrl-C pauses): ');
    if (comment.trim() === '/clear') item.comments = [];
    else if (comment.trim()) {
      if (Buffer.byteLength(comment) > 16_384) reject('VALIDATION_FAILED', 'Review comment exceeds 16 KiB.');
      item.comments.push({id: randomUUID(), kind: item.decision === 'request_changes' ? 'change_request' : 'note', body: comment, blocking: item.decision === 'request_changes', target: {object_id: item.item_id.startsWith('document:') ? item.item_id.slice(9) : item.item_id, element_id: null, field: null, operation_id: null, pointer: null}});
      if (item.comments.some(value => value.blocking)) feedback.implementation_authorization = {allowed: false, scope_hash: null};
    }
    await save();
  }
  let implementationReady = true;
  try { validateSource((await roundDocuments(root, round, 'after')).map(document => ({path: document.path, raw: document.raw})), 'implementation_ready'); }
  catch (error) {
    if (!(error instanceof CoreError)) throw error;
    implementationReady = false; out(`Implementation readiness: ${error.diagnostics.map(item => item.code + ': ' + item.message).join('; ')}`);
  }
  const canImplement = implementationReady && manifest.metadata.implementation_scope.allowlist.length > 0 && feedback.items.every(item => item.decision === 'approve' && !item.comments.some(comment => comment.blocking));
  out(`\nEXACT IMPLEMENTATION SCOPE\n${JSON.stringify(manifest.metadata.implementation_scope, null, 2)}`);
  if (canImplement) {
    const permission = await choose('Permission [planning-only/allow-implementation/quit]: ', ['planning-only', 'allow-implementation']);
    feedback.implementation_authorization = permission === 'allow-implementation' ? {allowed: true, scope_hash: manifest.scope_hash} : {allowed: false, scope_hash: null};
  } else { feedback.implementation_authorization = {allowed: false, scope_hash: null}; out('Implementation cannot be permitted: scope/complete approval/blocking feedback requirements are not met.'); }
  await save();
  out(`\nFINAL JUDGMENTS\n${JSON.stringify(feedback, null, 2)}\nImplementation permission: ${feedback.implementation_authorization.allowed ? 'YES, EXACT FROZEN SCOPE ONLY' : 'NO'}`);
  const confirmation = `SUBMIT ${round.manifest_hash.slice(0, 12)}`;
  const answer = await io.question(`Type ${confirmation} to record this exact final judgment, or anything else to pause: `);
  if (answer !== confirmation) reject('REVIEW_REQUIRED', 'Review saved but not submitted. No final approval was recorded.');
  await io.verifyHuman();
  const submission: ReviewSubmission = {...roundBinding(round), ...feedback, schema_version: 1, submission_id: randomUUID(), expected_feedback_version: version!, final_confirmation: true};
  await submitReview(root, submission);
  const result = await reviewResults(root, input);
  out(`RECORDED: planning=${result.approval.documents_approved}; implementation=${result.approval.implementation_allowed}. Apply and actual code work remain separate.`);
  return result;
}
