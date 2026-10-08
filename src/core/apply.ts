import { randomUUID } from 'node:crypto';
import type { AppliedRecord, ApplyTransaction, RecoverRequest, RecoveryResult, ReviewBinding, ReviewRound, SnapshotFile, SubmittedReview } from '../contracts';
import { parseDocument, sourceManifest, validateSource } from './documents';
import { reject } from './errors';
import { listFiles, readText, recordId } from './paths';
import { binding, exactRecord, putRecord, readRecord, same, stringValue, versions } from './record-io';
import { acceptedReceipt, approval, freshRound, readRound, roundBinding, roundDocuments, sourceHead, validateApplied } from './review';
import { probeOwnership, readOwnership, validateOwner, withRecoveryClaim, withWriteLock, type MutationHooks, type Writer } from './ownership';
import { changeRoot, checkBinding, loadRawSource, optionalText } from './workspace';
import { semanticHash, VERSIONS } from './yaml';

export interface ApplyDependencies extends MutationHooks { refreshCache?: () => Promise<void> }
export function journalPath(id: string): string { return changeRoot(id) + '/apply-transaction.yaml'; }
function plannedPaths(round: ReviewRound): Map<string, { before: SnapshotFile | null; after: SnapshotFile | null }> {
  const result = new Map<string, { before: SnapshotFile | null; after: SnapshotFile | null }>();
  for (const delta of round.manifest.deltas) for (const side of ['before', 'after'] as const) { const file = delta[side]; if (!file) continue; const entry = result.get(file.path) ?? { before: null, after: null }; entry[side] = file; result.set(file.path, entry); }
  return new Map([...result].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
async function fileState(root: string, file: string): Promise<SnapshotFile | null | 'invalid'> {
  const raw = await optionalText(root, file); if (raw === null) return null;
  try { const parsed = parseDocument({ path: file, raw }); return { path: file, id: parsed.id, kind: parsed.kind, content_hash: parsed.content_hash, raw_hash: parsed.raw_hash, snapshot_path: '' }; } catch { return 'invalid'; }
}
function matches(actual: SnapshotFile | null | 'invalid', expected: SnapshotFile | null): boolean { return actual === null ? expected === null : actual !== 'invalid' && expected !== null && actual.id === expected.id && actual.kind === expected.kind && actual.content_hash === expected.content_hash; }
export async function recoveryConflicts(root: string, round: ReviewRound): Promise<string[]> {
  const plan = plannedPaths(round); const conflicts = new Set<string>();
  for (const file of await listFiles(root, 'planning/source')) if (!plan.has(file)) conflicts.add(file);
  for (const [file, states] of plan) { const actual = await fileState(root, file); if (!matches(actual, states.before) && !matches(actual, states.after)) conflicts.add(file); }
  return [...conflicts].sort();
}
export async function readTransaction(root: string, id: string): Promise<{ transaction: ApplyTransaction; round: ReviewRound; receipt: SubmittedReview }> {
  const tx = await readRecord<ApplyTransaction>(root, journalPath(id));
  exactRecord(tx, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'transaction_id', 'submission_id', 'payload_hash', 'owner', 'base_applied_change_id', 'base_source_hash', 'target_source_hash', 'before_source', 'after_source', 'files', 'prepared_at', 'phase', 'completed_paths'], 'apply transaction');
  const transaction = tx as unknown as ApplyTransaction; binding(transaction); versions(transaction); recordId(transaction.transaction_id); validateOwner(transaction.owner); stringValue(transaction.prepared_at);
  if (transaction.change_id !== id || !['prepared', 'writing', 'verifying', 'completed'].includes(transaction.phase) || !Array.isArray(transaction.completed_paths)) reject('APPLY_RECOVERY_REQUIRED', 'Invalid transaction phase/identity.');
  const round = await readRound(root, id, transaction.round); const receipt = await acceptedReceipt(root, round); if (!receipt) reject('APPLY_RECOVERY_REQUIRED', 'Transaction has no durable accepted judgment.');
  const m = round.manifest;
  const expected: ApplyTransaction = { ...VERSIONS, ...roundBinding(round), transaction_id: transaction.transaction_id, submission_id: receipt.submission.submission_id, payload_hash: receipt.payload_hash, owner: transaction.owner, base_applied_change_id: m.base_applied_change_id, base_source_hash: m.base_source_hash, target_source_hash: m.target_source_hash, before_source: m.base_source, after_source: m.target_source, files: m.deltas, prepared_at: transaction.prepared_at, phase: transaction.phase, completed_paths: transaction.completed_paths };
  if (!same(transaction, expected) || !approval(round, receipt, await roundDocuments(root, round, 'after')).documents_approved || new Set(transaction.completed_paths).size !== transaction.completed_paths.length || transaction.completed_paths.some(file => !plannedPaths(round).has(file))) reject('APPLY_RECOVERY_REQUIRED', 'Transaction/frozen approval evidence is inconsistent.');
  return { transaction, round, receipt };
}
function appliedRecord(transaction: ApplyTransaction, round: ReviewRound, receipt: SubmittedReview): AppliedRecord {
  const m = round.manifest;
  return { ...VERSIONS, ...roundBinding(round), transaction_id: transaction.transaction_id, submission_id: receipt.submission.submission_id, payload_hash: receipt.payload_hash, base_applied_change_id: m.base_applied_change_id, base_source_hash: m.base_source_hash, result_source_hash: m.target_source_hash, snapshot_tree_hash: m.snapshot_tree_hash, metadata_hash: m.metadata_hash, scope_hash: m.scope_hash, applied_at: new Date().toISOString() };
}
async function finish(writer: Writer, transaction: ApplyTransaction, round: ReviewRound, receipt: SubmittedReview, deps: ApplyDependencies): Promise<AppliedRecord> {
  await writer.bindJournal(journalPath(transaction.change_id));
  const conflicts = await recoveryConflicts(writer.root, round); if (conflicts.length) reject('APPLY_RECOVERY_REQUIRED', 'Source has third-party conflicts: ' + conflicts.join(', '));
  let tx: ApplyTransaction = { ...transaction, phase: 'writing' }; await putRecord(writer, journalPath(tx.change_id), tx, false);
  for (const [file, expected] of plannedPaths(round)) {
    await writer.assert(); const actual = await fileState(writer.root, file);
    if (!matches(actual, expected.before) && !matches(actual, expected.after)) reject('APPLY_RECOVERY_REQUIRED', 'Source changed while applying.', file);
    if (!matches(actual, expected.after)) {
      if (expected.after === null) await writer.remove(file);
      else await writer.write(file, await readText(writer.root, expected.after.snapshot_path));
    }
    tx = { ...tx, completed_paths: [...new Set([...tx.completed_paths, file])] }; await putRecord(writer, journalPath(tx.change_id), tx, false);
  }
  tx = { ...tx, phase: 'verifying' }; await putRecord(writer, journalPath(tx.change_id), tx, false);
  await writer.assert();
  if (semanticHash(sourceManifest(tx.project_id, validateSource(await loadRawSource(writer.root)))) !== tx.target_source_hash) reject('APPLY_RECOVERY_REQUIRED', 'Final full source tree does not match the frozen target.');
  await deps.afterBoundary?.('apply:target-verified'); await writer.assert();
  const file = changeRoot(tx.change_id) + '/applied.yaml'; let applied: AppliedRecord;
  if (await optionalText(writer.root, file) !== null) { applied = await readRecord<AppliedRecord>(writer.root, file); validateApplied(applied, round, receipt); if (applied.transaction_id !== tx.transaction_id) reject('APPLY_RECOVERY_REQUIRED', 'Applied result belongs to another transaction.'); }
  else { applied = appliedRecord(tx, round, receipt); await putRecord(writer, file, applied); }
  await deps.afterBoundary?.('apply:applied-durable'); await writer.assert();
  tx = { ...tx, phase: 'completed' }; await putRecord(writer, journalPath(tx.change_id), tx, false); writer.retain(false);
  await deps.afterBoundary?.('apply:completed'); await writer.assert();
  await deps.refreshCache?.(); await deps.afterBoundary?.('cache:refresh'); await writer.assert();
  return applied;
}
function hooksFor(root: string, round: () => ReviewRound | null, deps: ApplyDependencies): MutationHooks {
  return { afterBoundary: deps.afterBoundary, async beforeMutation(file) {
    await deps.beforeMutation?.(file);
    if (file.startsWith('planning/source/')) {
      const frozen = round(); const expected = frozen && plannedPaths(frozen).get(file); if (!expected) reject('PATH_DENIED', 'Source mutation is outside frozen transaction.');
      const actual = await fileState(root, file); if (!matches(actual, expected.before) && !matches(actual, expected.after)) reject('APPLY_RECOVERY_REQUIRED', 'Source changed before atomic mutation.', file);
    }
  } };
}
export async function apply(root: string, input: ReviewBinding, deps: ApplyDependencies = {}): Promise<AppliedRecord> {
  binding(input); await checkBinding(root, input);
  if (await optionalText(root, changeRoot(input.change_id) + '/applied.yaml') !== null) {
    const head = await sourceHead(root); void head;
    const round = await readRound(root, input.change_id, input.round); if (!same(roundBinding(round), input)) reject('STALE_REVIEW', 'Applied retry binding differs.');
    const applied = await readRecord<AppliedRecord>(root, changeRoot(input.change_id) + '/applied.yaml'); validateApplied(applied, round, await acceptedReceipt(root, round));
    const tx = await readTransaction(root, input.change_id); if (tx.transaction.phase !== 'completed' || await readOwnership(root)) reject('APPLY_RECOVERY_REQUIRED', 'Applied result requires safe completion/recovery before retry.'); return applied;
  }
  let frozen: ReviewRound | null = null;
  return withWriteLock(root, 'apply', async writer => {
    frozen = await freshRound(root, input); const receipt = await acceptedReceipt(root, frozen); if (!receipt || !approval(frozen, receipt, await roundDocuments(root, frozen, 'after')).documents_approved) reject('REVIEW_REQUIRED', 'Apply requires complete durable human approval.');
    const m = frozen.manifest; const transaction: ApplyTransaction = { ...VERSIONS, ...roundBinding(frozen), transaction_id: randomUUID(), submission_id: receipt.submission.submission_id, payload_hash: receipt.payload_hash, owner: writer.owner, base_applied_change_id: m.base_applied_change_id, base_source_hash: m.base_source_hash, target_source_hash: m.target_source_hash, before_source: m.base_source, after_source: m.target_source, files: m.deltas, prepared_at: new Date().toISOString(), phase: 'prepared', completed_paths: [] };
    writer.retain(); await putRecord(writer, journalPath(input.change_id), transaction); await writer.bindJournal(journalPath(input.change_id));
    await deps.afterBoundary?.('apply:journal-ready'); await writer.assert(); return finish(writer, transaction, frozen, receipt, deps);
  }, hooksFor(root, () => frozen, deps));
}
export async function recover(root: string, input: RecoverRequest, deps: ApplyDependencies = {}): Promise<RecoveryResult> {
  await checkBinding(root, input); recordId(input.change_id);
  if (!['inspect', 'resume'].includes(input.action)) reject('VALIDATION_FAILED', 'Recovery action must be inspect or resume.');
  if (await optionalText(root, journalPath(input.change_id)) === null) { if (await readOwnership(root)) reject('APPLY_RECOVERY_REQUIRED', 'Ownership exists without a valid journal; explicit operator inspection is required.'); return { transaction: null, applied: null, conflicts: [] }; }
  const context = await readTransaction(root, input.change_id); const conflicts = await recoveryConflicts(root, context.round);
  const appliedPath = changeRoot(input.change_id) + '/applied.yaml'; const applied = await optionalText(root, appliedPath) === null ? null : await readRecord<AppliedRecord>(root, appliedPath); if (applied) validateApplied(applied, context.round, context.receipt);
  if (input.action === 'inspect') return { transaction: context.transaction, applied, conflicts };
  if (conflicts.length) reject('APPLY_RECOVERY_REQUIRED', 'User edits conflict with recovery: ' + conflicts.join(', '));
  const anchor = await readOwnership(root);
  if (!anchor) { if (context.transaction.phase === 'completed' && applied) { await sourceHead(root); return { transaction: context.transaction, applied, conflicts: [] }; } reject('APPLY_RECOVERY_REQUIRED', 'Missing ownership anchor; journal alone cannot authorize takeover.'); }
  if (anchor.anchor_nonce !== context.transaction.owner.anchor_nonce || await probeOwnership(context.transaction.owner) !== 'dead') reject('APPLY_RECOVERY_REQUIRED', 'Recorded transaction writer must be provably dead.');
  return withRecoveryClaim(root, anchor, async writer => {
    await checkBinding(root, input);
    const verified = await readTransaction(root, input.change_id);
    if (!same(verified.transaction, context.transaction)) reject('APPLY_RECOVERY_REQUIRED', 'Journal changed before exclusive recovery.');
    const head = await sourceHead(root, false);
    if (applied ? head.change_id !== input.change_id || head.hash !== context.transaction.target_source_hash : head.change_id !== context.transaction.base_applied_change_id || head.hash !== context.transaction.base_source_hash) reject('APPLY_RECOVERY_REQUIRED', 'Recovery chain predecessor changed.');
    const transaction = { ...context.transaction, owner: writer.owner }; await putRecord(writer, journalPath(input.change_id), transaction, false); await writer.bindJournal(journalPath(input.change_id));
    writer.retain(); const result = await finish(writer, transaction, context.round, context.receipt, deps);
    return { transaction: (await readTransaction(root, input.change_id)).transaction, applied: result, conflicts: [] };
  }, hooksFor(root, () => context.round, deps));
}
