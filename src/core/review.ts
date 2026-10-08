import Ajv2020 from 'ajv/dist/2020.js';
import { setTimeout as delay } from 'node:timers/promises';
import schema from '../../schemas/review-submission.schema.json';
import type { ActiveChange, AppliedRecord, CancellationRecord, ChangeMutation, ChangeRecord, ChangeState, CommentTarget, DocumentDelta, FeedbackResponse, JsonValue, PrepareReviewRequest, ReviewBinding, ReviewDraft, ReviewFeedback, ReviewManifest, ReviewResults, ReviewRound, ReviewSubmission, SaveReviewDraftRequest, SnapshotFile, SourceManifest, SubmissionReceipt, SubmittedReview } from '../contracts';
import { isObject, parseDocument, sourceManifest, validateSource, type ParsedDocument, type RawDocument } from './documents';
import { CoreError, reject } from './errors';
import { listFiles, readText, recordId, sourcePath } from './paths';
import { binding, exactRecord, hashValue, putRecord, readRecord, recordFiles, same, stringValue, versions } from './record-io';
import { semanticHash, VERSIONS } from './yaml';
import { probeOwnership, readOwnership, withWriteLock, type MutationHooks, type Writer } from './ownership';
import { assertEditable, changeRoot, checkBinding, currentBinding, loadChange, loadProjectedChange, loadRawSource, optionalText, readProjectConfig, validateMetadata, workspaceIdentity } from './workspace';

const submissionValidator = new Ajv2020({ strict: false, allErrors: true, ownProperties: true }).compile<ReviewSubmission>(schema);
/** Bounded contention wait only; never expires, replaces or takes ownership from a writer. */
async function reviewLock<T>(root: string, operation: string, action: (writer: Writer) => Promise<T>, hooks: MutationHooks): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await withWriteLock(root, operation, action, hooks); }
    catch (error) {
      if (!(error instanceof CoreError) || error.diagnostics[0].code !== 'APPLY_RECOVERY_REQUIRED' || attempt >= 50) throw error;
      let owner;
      try { owner = await readOwnership(root); }
      catch (ownershipError) {
        if (!(ownershipError instanceof CoreError) || ownershipError.diagnostics[0].code !== 'APPLY_RECOVERY_REQUIRED') throw ownershipError;
        // Publication may be incomplete. Wait only; never remove or reclaim its anchor.
        await hooks.afterBoundary?.('review:ownership-pending'); await delay(20); continue;
      }
      // The observed contender may have completed/released before the read.
      if (owner && (!['human review submit', 'review autosave'].includes(owner.operation) || await probeOwnership(owner) !== 'alive')) throw error;
      await delay(20);
    }
  }
}
export function roundRoot(id: string, round: number): string { recordId(id); if (!Number.isSafeInteger(round) || round < 1) reject('VALIDATION_FAILED', 'Invalid round.'); return `${changeRoot(id)}/rounds/${round}`; }
export function roundBinding(round: ReviewRound): ReviewBinding {
  const m = round.manifest; return { project_id: m.project_id, workspace_fingerprint: m.workspace_fingerprint, change_id: m.change_id, round: m.round, manifest_hash: round.manifest_hash };
}
function feedbackBody(value: ReviewBinding & ReviewFeedback): ReviewBinding & ReviewFeedback { return { project_id: value.project_id, workspace_fingerprint: value.workspace_fingerprint, change_id: value.change_id, round: value.round, manifest_hash: value.manifest_hash, items: value.items, implementation_authorization: value.implementation_authorization }; }
export async function roundNumbers(root: string, id: string): Promise<number[]> {
  const files = await listFiles(root, changeRoot(id) + '/rounds'); const numbers = new Set<number>();
  for (const file of files) { const suffix = file.slice((changeRoot(id) + '/rounds/').length); const segment = suffix.split('/')[0]; if (!/^[1-9]\d*$/.test(segment) || !Number.isSafeInteger(Number(segment))) reject('VALIDATION_FAILED', 'Malformed round path.', file); if (suffix === segment + '/manifest.yaml') numbers.add(Number(segment)); }
  return [...numbers].sort((a, b) => a - b);
}
function snapshot(document: ParsedDocument, directory: string): SnapshotFile { return { path: document.path, id: document.id, kind: document.kind, content_hash: document.content_hash, snapshot_path: directory + '/' + document.path.slice('planning/source/'.length), raw_hash: document.raw_hash }; }
function deltas(before: ParsedDocument[], after: ParsedDocument[], directory: string): DocumentDelta[] {
  const result: DocumentDelta[] = [];
  for (const id of [...new Set([...before, ...after].map(document => document.id))].sort()) {
    const a = before.find(document => document.id === id); const b = after.find(document => document.id === id);
    if (!a) result.push({ operation: 'add', object_id: id, before: null, after: snapshot(b!, directory + '/after') });
    else if (!b) result.push({ operation: 'delete', object_id: id, before: snapshot(a, directory + '/before'), after: null });
    else result.push({ operation: a.path !== b.path ? 'move' : a.content_hash !== b.content_hash ? 'modify' : 'unchanged', object_id: id, before: snapshot(a, directory + '/before'), after: snapshot(b, directory + '/after') });
  }
  return result;
}
function items(m: Pick<ReviewManifest, 'deltas' | 'metadata'>): ReviewManifest['items'] {
  const result: ReviewManifest['items'] = m.deltas.filter(delta => delta.operation !== 'unchanged').map(delta => ({ item_id: 'document:' + delta.object_id, type: 'document', object_id: delta.object_id, required: true }));
  if (m.metadata.implementation_scope.allowlist.length) result.push({ item_id: 'scope:implementation', type: 'implementation_scope', required: true });
  return result;
}
function treeHash(files: DocumentDelta[]): string {
  const entries = files.flatMap(delta => [delta.before, delta.after]).filter((file): file is SnapshotFile => file !== null).map(file => ({ path: file.snapshot_path, raw_hash: file.raw_hash })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return semanticHash(entries);
}
export async function roundDocuments(root: string, round: ReviewRound, side: 'before' | 'after'): Promise<ParsedDocument[]> {
  const inputs: RawDocument[] = []; const directory = roundRoot(round.manifest.change_id, round.manifest.round) + '/' + side;
  for (const delta of round.manifest.deltas) {
    const file = delta[side]; if (!file) continue;
    sourcePath(file.path);
    if (file.snapshot_path !== directory + '/' + file.path.slice('planning/source/'.length)) reject('PATH_DENIED', 'Snapshot path is outside its frozen side.');
    const raw = await readText(root, file.snapshot_path); const parsed = parseDocument({ path: file.path, raw });
    if (parsed.id !== file.id || parsed.kind !== file.kind || parsed.content_hash !== file.content_hash || parsed.raw_hash !== file.raw_hash) reject('STALE_REVIEW', 'Frozen snapshot is corrupt.', file.snapshot_path);
    inputs.push({ path: file.path, raw });
  }
  if (!(await listFiles(root, directory)).every(file => round.manifest.deltas.some(delta => delta[side]?.snapshot_path === file))) reject('STALE_REVIEW', 'Unexpected frozen snapshot file.');
  return validateSource(inputs);
}
export async function readRound(root: string, id: string, number: number): Promise<ReviewRound> {
  const round = await readRecord<ReviewRound>(root, roundRoot(id, number) + '/manifest.yaml');
  exactRecord(round, ['manifest', 'manifest_hash', 'prepared_at'], 'review round');
  exactRecord(round.manifest, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'workspace_fingerprint', 'change_id', 'round', 'workspace_identity', 'metadata', 'metadata_hash', 'scope_hash', 'base_applied_change_id', 'base_source', 'base_source_hash', 'target_source', 'target_source_hash', 'deltas', 'items', 'snapshot_tree_hash'], 'review manifest');
  const m = round.manifest as unknown as ReviewManifest; versions(m); binding(roundBinding(round)); stringValue(round.prepared_at);
  if (m.change_id !== id || m.round !== number || !Array.isArray(m.deltas) || !Array.isArray(m.items)) reject('VALIDATION_FAILED', 'Round identity/arrays mismatch.');
  if (m.base_applied_change_id !== null) recordId(m.base_applied_change_id);
  validateMetadata(m.metadata);
  if (semanticHash(m.workspace_identity) !== m.workspace_fingerprint) reject('WORKSPACE_MISMATCH', 'Frozen workspace identity hash mismatch.');
  const config = await readProjectConfig(root); if (m.project_id !== config.project_id) reject('WORKSPACE_MISMATCH', 'Round project mismatch.');
  const before = await roundDocuments(root, round, 'before'); const after = await roundDocuments(root, round, 'after');
  const expected = { ...m, metadata_hash: semanticHash(m.metadata), scope_hash: semanticHash(m.metadata.implementation_scope), base_source: sourceManifest(m.project_id, before), target_source: sourceManifest(m.project_id, after), deltas: deltas(before, after, roundRoot(id, number)) };
  expected.base_source_hash = semanticHash(expected.base_source); expected.target_source_hash = semanticHash(expected.target_source); expected.items = items(expected); expected.snapshot_tree_hash = treeHash(expected.deltas);
  if (!same(m, expected) || round.manifest_hash !== semanticHash(m) || !expected.items.length) reject('STALE_REVIEW', 'Frozen manifest/hash/deltas are inconsistent.');
  return round as unknown as ReviewRound;
}
function validateSubmission(value: unknown): asserts value is ReviewSubmission {
  if (!submissionValidator(value)) reject('VALIDATION_FAILED', 'Invalid submitted review: ' + JSON.stringify(submissionValidator.errors));
  binding(value); if (!Number.isSafeInteger(value.round)) reject('VALIDATION_FAILED', 'Unsafe round.');
}
export async function readReceipt(root: string, id: string): Promise<SubmittedReview | null> {
  const raw = await optionalText(root, 'planning/reviews/submissions/' + recordId(id) + '.yaml'); if (raw === null) return null;
  const value = await readRecord<SubmittedReview>(root, 'planning/reviews/submissions/' + id + '.yaml');
  exactRecord(value, ['submission', 'payload_hash', 'submitted_at', 'provenance'], 'submission receipt'); validateSubmission(value.submission); stringValue(value.submitted_at);
  if (value.submission.submission_id !== id || value.provenance !== 'studio_human_submit' || value.payload_hash !== semanticHash(value.submission) || value.submission.expected_feedback_version !== semanticHash(feedbackBody(value.submission))) reject('VALIDATION_FAILED', 'Invalid durable receipt provenance/payload/saved revision.');
  return value as unknown as SubmittedReview;
}
export async function acceptedReceipt(root: string, round: ReviewRound): Promise<SubmittedReview | null> {
  const receipts: SubmittedReview[] = [];
  for (const file of await listFiles(root, 'planning/reviews/submissions')) {
    if (!file.endsWith('.yaml')) reject('VALIDATION_FAILED', 'Unexpected submission record file.');
    const receipt = (await readReceipt(root, file.slice(file.lastIndexOf('/') + 1, -5)))!;
    if (receipt.submission.change_id === round.manifest.change_id && receipt.submission.round === round.manifest.round) { validateFeedback(receipt.submission, round, await roundDocuments(root, round, 'before'), await roundDocuments(root, round, 'after')); receipts.push(receipt); }
  }
  if (receipts.length > 1) reject('CONFLICT', 'Multiple final judgments exist for one round.');
  return receipts[0] ?? null;
}
function pointerTarget(value: JsonValue, pointer: string, stable: boolean): JsonValue {
  if (!pointer.startsWith('/')) reject('VALIDATION_FAILED', 'Comment pointer must be escaped JSON Pointer.');
  let current = value;
  for (const token of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(token)) reject('VALIDATION_FAILED', 'Invalid comment pointer escape.');
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) { if (!stable || !/^(?:0|[1-9]\d*)$/.test(key) || !Object.hasOwn(current, key)) reject('VALIDATION_FAILED', 'Array comment targets require stable identity.'); current = current[Number(key)]; }
    else if (isObject(current) && Object.hasOwn(current, key)) current = current[key];
    else reject('VALIDATION_FAILED', 'Comment pointer target is missing.');
  }
  return current;
}
function validateTarget(target: CommentTarget, itemId: string, round: ReviewRound, documents: ParsedDocument[]): void {
  if (itemId === 'scope:implementation') { if (target.object_id !== 'scope:implementation' || [target.element_id, target.field, target.operation_id, target.pointer].some(value => value !== null)) reject('VALIDATION_FAILED', 'Invalid implementation-scope comment target.'); return; }
  if (itemId !== 'document:' + target.object_id) reject('VALIDATION_FAILED', 'Comment targets a different review item.');
  const document = documents.find(document => document.id === target.object_id); if (!document || !round.manifest.items.some(item => item.type === 'document' && item.object_id === document.id)) reject('VALIDATION_FAILED', 'Comment object is outside this round.');
  let selected: JsonValue = document.content as unknown as JsonValue;
  let stablePointer: string | null = null;
  if (target.element_id !== null) {
    const matches = Object.entries(document.content).flatMap(([key, value]) => Array.isArray(value) ? value.flatMap((value, index) => isObject(value) && value.id === target.element_id ? [{ value, pointer: '/' + key.replaceAll('~', '~0').replaceAll('/', '~1') + '/' + index }] : []) : []);
    if (matches.length !== 1) reject('VALIDATION_FAILED', 'Stable element target missing/ambiguous.'); selected = matches[0].value as JsonValue; stablePointer = matches[0].pointer;
  }
  if (target.operation_id !== null) {
    if (document.projection.kind !== 'openapi' || target.element_id !== null) reject('VALIDATION_FAILED', 'Operation target requires OpenAPI.');
    const operation = document.projection.operations.find(operation => operation.operation_id === target.operation_id); if (!operation) reject('VALIDATION_FAILED', 'Missing operationId target.'); selected = operation.content; stablePointer = operation.pointer;
  }
  if (target.field !== null && (!isObject(selected) || !Object.hasOwn(selected, target.field))) reject('VALIDATION_FAILED', 'Missing comment field.');
  if (target.pointer !== null) {
    if (stablePointer && target.pointer !== stablePointer && !target.pointer.startsWith(stablePointer + '/')) reject('VALIDATION_FAILED', 'Pointer does not belong to its stable target.');
    pointerTarget(document.content as unknown as JsonValue, target.pointer, stablePointer !== null);
  }
}
export function validateFeedback(feedback: ReviewBinding & ReviewFeedback, round: ReviewRound, before: ParsedDocument[], after: ParsedDocument[]): void {
  const sample: ReviewSubmission = { ...feedbackBody(feedback), schema_version: 1, submission_id: 'validation', expected_feedback_version: '0'.repeat(64), final_confirmation: true };
  validateSubmission(sample);
  if (!same(roundBinding(round), { project_id: feedback.project_id, workspace_fingerprint: feedback.workspace_fingerprint, change_id: feedback.change_id, round: feedback.round, manifest_hash: feedback.manifest_hash })) reject('STALE_REVIEW', 'Feedback binding differs from frozen review.');
  const expected = round.manifest.items.map(item => item.item_id).sort(); const actual = feedback.items.map(item => item.item_id).sort(); if (!same(expected, actual)) reject('VALIDATION_FAILED', 'Every review item must be covered exactly once.');
  const ids = new Set<string>();
  for (const item of feedback.items) for (const comment of item.comments) {
    if (ids.has(comment.id)) reject('VALIDATION_FAILED', 'Duplicate comment ID.'); ids.add(comment.id);
    const candidates = after.find(document => document.id === comment.target.object_id) ? after : before;
    validateTarget(comment.target, item.item_id, round, candidates);
  }
  if (feedback.implementation_authorization.allowed && (!round.manifest.metadata.implementation_scope.allowlist.length || feedback.implementation_authorization.scope_hash !== round.manifest.scope_hash)) reject('SCOPE_DENIED', 'Implementation authorization must match nonempty frozen scope.');
}
export function approval(round: ReviewRound, receipt: SubmittedReview | null, after: ParsedDocument[]): ReviewResults['approval'] {
  const blockers: CoreError['diagnostics'] = [];
  try {
    if (!receipt || receipt.submission.items.some(item => item.decision !== 'approve' || item.comments.some(comment => comment.blocking))) reject('REVIEW_REQUIRED', 'Complete final approval without blocking feedback is required.');
    validateSource(after.map(document => ({ path: document.path, raw: document.raw })), 'review_ready');
  } catch (error) { if (error instanceof CoreError) blockers.push(...error.diagnostics); else throw error; }
  const documentsApproved = !blockers.length;
  let implementationAllowed = documentsApproved && receipt!.submission.implementation_authorization.allowed;
  if (implementationAllowed) {
    try { validateSource(after.map(document => ({ path: document.path, raw: document.raw })), 'implementation_ready'); }
    catch (error) { if (error instanceof CoreError) { blockers.push(...error.diagnostics); implementationAllowed = false; } else throw error; }
  }
  return { documents_approved: documentsApproved, implementation_allowed: implementationAllowed, blockers };
}
export interface SourceHead { manifest: SourceManifest; hash: string; change_id: string | null; round: ReviewRound | null; applied: AppliedRecord | null }
export async function sourceHead(root: string, compareLive = true): Promise<SourceHead> {
  const config = await readProjectConfig(root); let manifest = config.genesis_manifest; let hash = config.genesis_hash; let id: string | null = null; let latest: ReviewRound | null = null; let applied: AppliedRecord | null = null;
  const remaining = new Map<string, AppliedRecord>();
  for (const file of await recordFiles(root, 'applied.yaml')) {
    const record = await readRecord<AppliedRecord>(root, file); recordId(record.change_id);
    if (file !== changeRoot(record.change_id) + '/applied.yaml' || remaining.has(record.change_id)) reject('SOURCE_DRIFT', 'Applied ID/path is inconsistent.');
    remaining.set(record.change_id, record);
  }
  while (remaining.size) {
    const successors = [...remaining.values()].filter(record => record.base_applied_change_id === id);
    if (successors.length !== 1) reject('SOURCE_DRIFT', 'Applied history is disconnected, cyclic or branched.');
    const record = successors[0]; const round = await readRound(root, record.change_id, record.round); const receipt = await acceptedReceipt(root, round);
    validateApplied(record, round, receipt);
    if (record.base_source_hash !== hash || !same(round.manifest.base_source, manifest)) reject('SOURCE_DRIFT', 'Applied base does not match predecessor.');
    manifest = round.manifest.target_source; hash = round.manifest.target_source_hash; id = record.change_id; latest = round; applied = record; remaining.delete(id);
  }
  if (compareLive) {
    let actual: string;
    try { actual = semanticHash(sourceManifest(config.project_id, validateSource(await loadRawSource(root)))); }
    catch (error) { if (error instanceof CoreError) reject('SOURCE_DRIFT', 'Live source is invalid: ' + error.message); throw error; }
    if (actual !== hash) reject('SOURCE_DRIFT', 'Live source differs from durable applied history.');
  }
  return { manifest, hash, change_id: id, round: latest, applied };
}
export function validateApplied(record: AppliedRecord, round: ReviewRound, receipt: SubmittedReview | null): void {
  exactRecord(record, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'transaction_id', 'submission_id', 'payload_hash', 'base_applied_change_id', 'base_source_hash', 'result_source_hash', 'snapshot_tree_hash', 'metadata_hash', 'scope_hash', 'applied_at'], 'applied');
  versions(record); recordId(record.transaction_id); stringValue(record.applied_at);
  const m = round.manifest;
  const expected = { ...VERSIONS, ...roundBinding(round), transaction_id: record.transaction_id, submission_id: receipt?.submission.submission_id, payload_hash: receipt?.payload_hash, base_applied_change_id: m.base_applied_change_id, base_source_hash: m.base_source_hash, result_source_hash: m.target_source_hash, snapshot_tree_hash: m.snapshot_tree_hash, metadata_hash: m.metadata_hash, scope_hash: m.scope_hash, applied_at: record.applied_at };
  if (!receipt || !same(record, expected) || receipt.submission.items.some(item => item.decision !== 'approve' || item.comments.some(comment => comment.blocking))) reject('SOURCE_DRIFT', 'Applied result lacks a consistent accepted approval.');
}
export async function freshRound(root: string, input: ReviewBinding, compareBase = true): Promise<ReviewRound> {
  binding(input); await checkBinding(root, input); await assertEditable(root, input.change_id);
  const rounds = await roundNumbers(root, input.change_id); if (rounds.at(-1) !== input.round) reject('STALE_REVIEW', 'Only the latest frozen round is current.');
  const round = await readRound(root, input.change_id, input.round); if (round.manifest_hash !== input.manifest_hash) reject('STALE_REVIEW', 'Manifest hash changed.');
  const current = await loadChange(root, input.change_id);
  if (semanticHash(current.change.metadata) !== round.manifest.metadata_hash || semanticHash(sourceManifest(input.project_id, await loadProjectedChange(root, input.change_id))) !== round.manifest.target_source_hash) reject('STALE_REVIEW', 'Draft metadata/documents changed since review.');
  if (compareBase) { const head = await sourceHead(root); if (head.hash !== round.manifest.base_source_hash || head.change_id !== round.manifest.base_applied_change_id) reject('STALE_BASE', 'Source predecessor differs from frozen base.'); }
  return round;
}
export async function prepareReview(root: string, input: PrepareReviewRequest, hooks: MutationHooks = {}): Promise<ReviewRound> {
  return withWriteLock(root, 'prepare review', async writer => {
    await checkBinding(root, input); await assertEditable(root, input.change_id); const current = await loadChange(root, input.change_id); hashValue(input.expected_version);
    if (input.expected_version !== current.change.version) reject('CONFLICT', 'Change changed before preparing review.');
    const head = await sourceHead(root); const before = validateSource(await loadRawSource(root)); const after = await loadProjectedChange(root, input.change_id);
    if (current.change.metadata.type === 'implementation_only' && !same(sourceManifest(input.project_id, after), head.manifest)) reject('VALIDATION_FAILED', 'Implementation-only change cannot alter documents.');
    for (const id of current.change.metadata.implementation_scope.related_object_ids) if (!after.some(document => document.id === id) || (current.change.metadata.type === 'implementation_only' && !before.some(document => document.id === id))) reject('VALIDATION_FAILED', 'Implementation scope references missing/unapproved planning.');
    const allFiles = await listFiles(root, changeRoot(input.change_id) + '/rounds'); const maximum = Math.max(0, ...allFiles.map(file => Number(file.slice((changeRoot(input.change_id) + '/rounds/').length).split('/')[0])));
    const number = maximum + 1; const directory = roundRoot(input.change_id, number);
    const files = deltas(before, after, directory);
    const manifest: ReviewManifest = { ...VERSIONS, ...await currentBinding(root), change_id: input.change_id, round: number, workspace_identity: await workspaceIdentity(root), metadata: current.change.metadata, metadata_hash: semanticHash(current.change.metadata), scope_hash: semanticHash(current.change.metadata.implementation_scope), base_applied_change_id: head.change_id, base_source: head.manifest, base_source_hash: head.hash, target_source: sourceManifest(input.project_id, after), target_source_hash: semanticHash(sourceManifest(input.project_id, after)), deltas: files, items: [], snapshot_tree_hash: treeHash(files) };
    manifest.items = items(manifest); if (!manifest.items.length) reject('VALIDATION_FAILED', 'A review requires a document delta or implementation scope.');
    for (const [side, documents] of [['before', before], ['after', after]] as const) for (const document of documents) await writer.write(snapshot(document, directory + '/' + side).snapshot_path, document.raw, true);
    const round: ReviewRound = { manifest, manifest_hash: semanticHash(manifest), prepared_at: new Date().toISOString() };
    await putRecord(writer, directory + '/manifest.yaml', round); return round;
  }, hooks);
}
export async function saveReviewDraft(root: string, input: SaveReviewDraftRequest, hooks: MutationHooks = {}): Promise<ReviewDraft> {
  return reviewLock(root, 'review autosave', async writer => {
    const round = await freshRound(root, input); if (await acceptedReceipt(root, round)) reject('CONFLICT', 'Finalized review cannot be autosaved.');
    validateFeedback(input, round, await roundDocuments(root, round, 'before'), await roundDocuments(root, round, 'after'));
    const previous = await readFeedbackDraft(root, round); if ((previous?.version ?? null) !== input.expected_version) reject('CONFLICT', 'Saved feedback changed; preserve unsaved input.');
    const body = feedbackBody(input); const saved: ReviewDraft = { ...body, schema_version: 1, version: semanticHash(body), saved_at: new Date().toISOString() };
    await putRecord(writer, roundRoot(input.change_id, input.round) + '/feedback-draft.yaml', saved, false); return saved;
  }, hooks);
}
export async function readFeedbackDraft(root: string, round: ReviewRound): Promise<ReviewDraft | null> {
  const file = roundRoot(round.manifest.change_id, round.manifest.round) + '/feedback-draft.yaml'; if (await optionalText(root, file) === null) return null;
  const draft = await readRecord<ReviewDraft>(root, file); exactRecord(draft, ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'items', 'implementation_authorization', 'schema_version', 'version', 'saved_at'], 'feedback draft');
  if (draft.schema_version !== 1 || draft.version !== semanticHash(feedbackBody(draft as unknown as ReviewDraft))) reject('VALIDATION_FAILED', 'Saved feedback hash is inconsistent.');
  validateFeedback(draft as unknown as ReviewDraft, round, await roundDocuments(root, round, 'before'), await roundDocuments(root, round, 'after')); return draft as unknown as ReviewDraft;
}
export async function submitReview(root: string, input: ReviewSubmission, hooks: MutationHooks = {}): Promise<SubmissionReceipt> {
  validateSubmission(input);
  const replay = async (): Promise<SubmissionReceipt | null> => { const receipt = await readReceipt(root, input.submission_id); if (!receipt) return null; if (receipt.payload_hash !== semanticHash(input)) reject('CONFLICT', 'Submission ID already has another payload.'); return { submission_id: input.submission_id, payload_hash: receipt.payload_hash, submitted_at: receipt.submitted_at, replayed: true }; };
  const existing = await replay(); if (existing) return existing;
  return reviewLock(root, 'human review submit', async writer => {
    const existing = await replay(); if (existing) return existing;
    const round = await readRound(root, input.change_id, input.round); if (await acceptedReceipt(root, round)) reject('CONFLICT', 'Round already has its final judgment.');
    await freshRound(root, input); validateFeedback(input, round, await roundDocuments(root, round, 'before'), await roundDocuments(root, round, 'after'));
    const saved = await readFeedbackDraft(root, round);
    if (!saved || saved.version !== input.expected_feedback_version || !same(feedbackBody(saved), feedbackBody(input))) reject('CONFLICT', 'Submit requires exactly the current durably saved feedback.');
    if (input.implementation_authorization.allowed && !approval(round, { submission: input, payload_hash: semanticHash(input), submitted_at: '', provenance: 'studio_human_submit' }, await roundDocuments(root, round, 'after')).implementation_allowed) reject('REVIEW_REQUIRED', 'Implementation permission requires complete approval and stage readiness.');
    const receipt: SubmittedReview = { submission: input, payload_hash: semanticHash(input), submitted_at: new Date().toISOString(), provenance: 'studio_human_submit' };
    await putRecord(writer, 'planning/reviews/submissions/' + input.submission_id + '.yaml', receipt);
    return { submission_id: input.submission_id, payload_hash: receipt.payload_hash, submitted_at: receipt.submitted_at, replayed: false };
  }, hooks);
}
export async function responses(root: string, round: ReviewRound): Promise<FeedbackResponse[]> {
  const result: FeedbackResponse[] = []; const receipt = await acceptedReceipt(root, round);
  for (const file of await listFiles(root, changeRoot(round.manifest.change_id) + '/responses')) {
    const value = await readRecord<FeedbackResponse>(root, file); exactRecord(value, ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'response_id', 'submission_id', 'version', 'created_at', 'comments'], 'feedback response'); binding(value as unknown as FeedbackResponse); recordId(value.response_id as string); stringValue(value.created_at);
    if (file !== changeRoot(round.manifest.change_id) + '/responses/' + value.response_id + '.yaml' || !Array.isArray(value.comments)) reject('VALIDATION_FAILED', 'Invalid response path/comments.');
    const response = value as unknown as FeedbackResponse; const { version: ignoredVersion, created_at: ignoredTime, ...body } = response; void ignoredVersion; void ignoredTime;
    if (response.version !== semanticHash(body)) reject('VALIDATION_FAILED', 'Response payload hash mismatch.');
    if (value.round === round.manifest.round) { if (!receipt || response.submission_id !== receipt.submission.submission_id || !same(roundBinding(round), { project_id: response.project_id, workspace_fingerprint: response.workspace_fingerprint, change_id: response.change_id, round: response.round, manifest_hash: response.manifest_hash })) reject('VALIDATION_FAILED', 'Response submission mismatch.'); validateResponseComments(response.comments, receipt, round); result.push(response); }
  }
  const ids = result.flatMap(response => response.comments.map(comment => comment.comment_id)); if (new Set(ids).size !== ids.length) reject('CONFLICT', 'A comment was processed by multiple response records.');
  return result;
}
function validateResponseComments(comments: FeedbackResponse['comments'], receipt: SubmittedReview, round: ReviewRound): void {
  if (!comments.length) reject('VALIDATION_FAILED', 'Response needs comments.'); const ids = new Set<string>();
  for (const comment of comments) {
    exactRecord(comment, ['comment_id', 'result', 'changed_paths', 'rationale'], 'response comment'); recordId(comment.comment_id); stringValue(comment.rationale);
    if (ids.has(comment.comment_id) || !receipt.submission.items.some(item => item.comments.some(value => value.id === comment.comment_id)) || !['proposed', 'addressed_in_draft', 'needs_clarification', 'not_applied'].includes(comment.result) || !Array.isArray(comment.changed_paths)) reject('VALIDATION_FAILED', 'Invalid response comment.'); ids.add(comment.comment_id);
    for (const file of comment.changed_paths) { sourcePath(file); if (!round.manifest.deltas.some(delta => delta.before?.path === file || delta.after?.path === file)) reject('PATH_DENIED', 'Response path is outside review.'); }
  }
}
export async function respond(root: string, input: import('../contracts').RespondRequest): Promise<FeedbackResponse> {
  return withWriteLock(root, 'feedback response', async writer => {
    binding(input); recordId(input.response_id); const round = await readRound(root, input.change_id, input.round); const receipt = await acceptedReceipt(root, round);
    if (!receipt || receipt.submission.submission_id !== input.submission_id) reject('VALIDATION_FAILED', 'Missing accepted submission.');
    validateResponseComments(input.comments, receipt, round);
    const body = { ...roundBinding(round), response_id: input.response_id, submission_id: input.submission_id, comments: input.comments }; const version = semanticHash(body);
    const previous = (await responses(root, round)).find(response => response.response_id === input.response_id); if (previous) { if (previous.version !== version) reject('CONFLICT', 'Response ID payload differs.'); return previous; }
    await checkBinding(root, input); await assertEditable(root, input.change_id); const current = await loadChange(root, input.change_id); if (input.expected_change_version !== current.change.version) reject('CONFLICT', 'Change version changed before responding.');
    if ((await responses(root, round)).some(response => response.comments.some(comment => input.comments.some(value => value.comment_id === comment.comment_id)))) reject('CONFLICT', 'Comment already processed.');
    const response: FeedbackResponse = { ...body, version, created_at: new Date().toISOString() }; await putRecord(writer, changeRoot(input.change_id) + '/responses/' + input.response_id + '.yaml', response); return response;
  });
}
export async function reviewResults(root: string, input: ReviewBinding): Promise<ReviewResults> {
  return withWriteLock(root, 'review results', async () => {
    const round = await readRound(root, input.change_id, input.round); if (!same(roundBinding(round), input)) reject('STALE_REVIEW', 'Review binding mismatch.');
    const receipt = await acceptedReceipt(root, round); const processed = await responses(root, round); const result = approval(round, receipt, await roundDocuments(root, round, 'after'));
    try {
      if (await optionalText(root, changeRoot(input.change_id) + '/applied.yaml') === null) await freshRound(root, input);
      else {
        const head = await sourceHead(root); if (head.change_id !== input.change_id) reject('STALE_REVIEW', 'This is historical approval.'); await checkBinding(root, input);
        const mutable = await readRecord<{ metadata: unknown }>(root, changeRoot(input.change_id) + '/change.yaml');
        if (!isObject(mutable) || semanticHash(mutable.metadata) !== round.manifest.metadata_hash) reject('STALE_REVIEW', 'Applied metadata changed since human review.');
      }
    }
    catch (error) { if (error instanceof CoreError) { result.blockers.push(...error.diagnostics); result.documents_approved = false; result.implementation_allowed = false; } else throw error; }
    return { round, draft: await readFeedbackDraft(root, round), accepted_submission: receipt, responses: processed, processed_comment_ids: processed.flatMap(response => response.comments.map(comment => comment.comment_id)), approval: result };
  });
}
export async function changeState(root: string, id: string): Promise<{ state: ChangeState; change: ChangeRecord; round: ReviewRound | null }> {
  const cancelled = await optionalText(root, changeRoot(id) + '/cancelled.yaml'); const applied = await optionalText(root, changeRoot(id) + '/applied.yaml'); const current = await loadChange(root, id, false);
  if (cancelled && applied) reject('CONFLICT', 'Change has both cancellation and applied record.');
  if (cancelled) { const record = await readRecord<CancellationRecord>(root, changeRoot(id) + '/cancelled.yaml'); exactRecord(record, ['project_id', 'workspace_fingerprint', 'change_id', 'cancelled_at', 'reason'], 'cancellation'); if (record.change_id !== id || record.project_id !== current.change.project_id || record.workspace_fingerprint !== current.change.workspace_fingerprint) reject('VALIDATION_FAILED', 'Cancellation binding mismatch.'); stringValue(record.reason); stringValue(record.cancelled_at); return { state: 'cancelled', change: current.change, round: null }; }
  if (applied) { await sourceHead(root, false); return { state: 'applied', change: current.change, round: null }; }
  const numbers = await roundNumbers(root, id); if (!numbers.length) return { state: 'draft', change: current.change, round: null };
  const round = await readRound(root, id, numbers.at(-1)!); const receipt = await acceptedReceipt(root, round); if (!receipt) return { state: 'in_review', change: current.change, round };
  let state: ChangeState = approval(round, receipt, await roundDocuments(root, round, 'after')).documents_approved ? 'approved' : 'needs_revision';
  try { await freshRound(root, roundBinding(round)); } catch (error) { if (error instanceof CoreError) state = 'needs_revision'; else throw error; }
  return { state, change: current.change, round };
}
export async function activeChanges(root: string): Promise<ActiveChange[]> {
  const result: ActiveChange[] = [];
  for (const file of await recordFiles(root, 'change.yaml')) { const id = file.slice('planning/changes/'.length).split('/')[0]; const state = await changeState(root, id); if (state.state !== 'applied' && state.state !== 'cancelled') result.push({ change_id: id, state: state.state, metadata: state.change.metadata }); }
  if (result.length > 1) reject('CONFLICT', 'Multiple active changes exist.'); return result;
}
export async function cancelChange(root: string, input: ChangeMutation & { reason: string }): Promise<void> {
  return withWriteLock(root, 'cancel change', async writer => {
    await checkBinding(root, input); await assertEditable(root, input.change_id); const current = await loadChange(root, input.change_id, false); if (current.change.version !== input.expected_version) reject('CONFLICT', 'Change changed before cancellation.'); stringValue(input.reason);
    await putRecord(writer, changeRoot(input.change_id) + '/cancelled.yaml', { project_id: current.change.project_id, workspace_fingerprint: current.change.workspace_fingerprint, change_id: input.change_id, reason: input.reason, cancelled_at: new Date().toISOString() });
  });
}
