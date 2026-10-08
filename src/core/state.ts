import type { ContinuityStatus, DocumentView, GateRequest, GateResult, GetRequest, HistoryEntry, HistoryRequest, HistoryResult, HostCapability, HostId, ImplementationRecord, ReviewRound, StudioState } from '../contracts';
import { readTransaction } from './apply';
import { isObject, type ParsedDocument, validateSource } from './documents';
import { CoreError, reject } from './errors';
import { readOwnership, withWriteLock } from './ownership';
import { listFiles, readText, relativePath, safePath } from './paths';
import { binding, exactRecord, putRecord, readRecord, recordFiles, same, stringValue } from './record-io';
import { acceptedReceipt, activeChanges, approval, changeState, readRound, responses, roundBinding, roundDocuments, roundNumbers, sourceHead, type SourceHead } from './review';
import { changeRoot, checkBinding, currentBinding, loadChange, loadRawSource, optionalText, readProjectConfig, readWorkflow, workspaceIdentity } from './workspace';
import { parseYaml, semanticHash } from './yaml';

async function completedHead(root: string): Promise<SourceHead> {
  const head = await sourceHead(root);
  if (head.applied) { const { transaction } = await readTransaction(root, head.applied.change_id); if (transaction.phase !== 'completed' || transaction.transaction_id !== head.applied.transaction_id) reject('APPLY_RECOVERY_REQUIRED', 'Apply is not normally completed.'); }
  return head;
}
function defaultHost(host: HostId): HostCapability { return { host, host_version: null, configured: false, trusted: null, active: false, probed: { state: 'not_run', checked_at: null, evidence: [] }, coverage: { protected_tools: [], uncovered_tools: [], limitations: ['Native hook observation has not been recorded.'] }, mode: { type: 'enforced' } }; }
export async function readHost(root: string, host: HostId): Promise<HostCapability> {
  if (!['claude', 'codex'].includes(host)) reject('VALIDATION_FAILED', 'Unknown host.'); const file = 'planning/hosts/' + host + '.yaml'; if (await optionalText(root, file) === null) return defaultHost(host);
  const value = await readRecord<HostCapability>(root, file); exactRecord(value, ['host', 'host_version', 'configured', 'trusted', 'active', 'probed', 'coverage', 'mode'], 'host capability');
  if (value.host !== host || (value.host_version !== null && typeof value.host_version !== 'string') || typeof value.configured !== 'boolean' || (value.trusted !== null && typeof value.trusted !== 'boolean') || typeof value.active !== 'boolean') reject('VALIDATION_FAILED', 'Invalid host observations.');
  exactRecord(value.probed, ['state', 'checked_at', 'evidence'], 'host probe'); exactRecord(value.coverage, ['protected_tools', 'uncovered_tools', 'limitations'], 'host coverage');
  const capability = value as unknown as HostCapability;
  for (const list of [capability.probed.evidence, capability.coverage.protected_tools, capability.coverage.uncovered_tools, capability.coverage.limitations]) if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) reject('VALIDATION_FAILED', 'Invalid capability evidence/coverage.');
  if (!['not_run', 'passed', 'failed', 'blocked'].includes(capability.probed.state) || (capability.probed.checked_at !== null && typeof capability.probed.checked_at !== 'string')) reject('VALIDATION_FAILED', 'Invalid host probe state.');
  if (capability.mode.type === 'enforced') exactRecord(capability.mode, ['type'], 'enforced mode');
  else { exactRecord(capability.mode, ['type', 'selected_by', 'selected_at', 'reason'], 'advisory mode'); if (capability.mode.type !== 'advisory' || capability.mode.selected_by !== 'human') reject('VALIDATION_FAILED', 'Advisory requires explicit human selection.'); stringValue(capability.mode.reason); stringValue(capability.mode.selected_at); }
  if (capability.active && (!capability.configured || capability.trusted !== true || !capability.host_version || capability.probed.state !== 'passed' || !capability.probed.checked_at || !capability.probed.evidence.length)) reject('HOOK_NOT_ACTIVE', 'Active hook claim lacks current native observations.');
  return capability;
}
/** Only expose through the human transport; no agent CLI selection. */
export async function selectAdvisory(root: string, input: { host: HostId; reason: string }): Promise<HostCapability> {
  stringValue(input.reason);
  return withWriteLock(root, 'human advisory selection', async writer => { const host = await readHost(root, input.host); const capability: HostCapability = { ...host, mode: { type: 'advisory', selected_by: 'human', selected_at: new Date().toISOString(), reason: input.reason } }; await putRecord(writer, 'planning/hosts/' + input.host + '.yaml', capability, false); return capability; });
}
async function headAuthorization(root: string, head: SourceHead): Promise<ContinuityStatus['implementation_authorization']> {
  const empty: ContinuityStatus['implementation_authorization'] = { state: 'none', change_id: null, manifest_hash: null, scope_hash: null, scope: null };
  if (!head.round) return empty;
  const round = head.round; const result = approval(round, await acceptedReceipt(root, round), await roundDocuments(root, round, 'after'));
  if (!result.implementation_allowed) return empty;
  let state: 'authorized' | 'stale' = 'authorized';
  try {
    await checkBinding(root, round.manifest);
    const mutable = parseYaml(await readText(root, changeRoot(round.manifest.change_id) + '/change.yaml'));
    if (!isObject(mutable) || semanticHash(mutable.metadata) !== round.manifest.metadata_hash) reject('STALE_REVIEW', 'Applied metadata changed since human review.');
  } catch (error) { if (error instanceof CoreError) state = 'stale'; else throw error; }
  return { state, change_id: round.manifest.change_id, manifest_hash: round.manifest_hash, scope_hash: round.manifest.scope_hash, scope: round.manifest.metadata.implementation_scope };
}
async function implementationRecords(root: string, round: ReviewRound): Promise<ImplementationRecord[]> {
  const records: ImplementationRecord[] = [];
  for (const file of await listFiles(root, changeRoot(round.manifest.change_id) + '/implementation')) {
    const record = await readRecord<ImplementationRecord>(root, file); exactRecord(record, ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'implementation_id', 'recorded_at', 'scope_hash', 'status', 'evidence', 'git_commit'], 'implementation evidence');
    binding(record as unknown as ImplementationRecord); stringValue(record.implementation_id); stringValue(record.recorded_at);
    if (record.round !== round.manifest.round) { await readRound(root, round.manifest.change_id, record.round as number); continue; }
    if (file !== changeRoot(round.manifest.change_id) + '/implementation/' + record.implementation_id + '.yaml' || record.scope_hash !== round.manifest.scope_hash || !same(roundBinding(round), { project_id: record.project_id, workspace_fingerprint: record.workspace_fingerprint, change_id: record.change_id, round: record.round, manifest_hash: record.manifest_hash }) || !['unverified', 'verified', 'failed'].includes(record.status as string) || !Array.isArray(record.evidence) || (record.git_commit !== null && typeof record.git_commit !== 'string')) reject('VALIDATION_FAILED', 'Invalid implementation evidence binding.');
    for (const evidence of record.evidence) { exactRecord(evidence, ['description', 'command', 'exit_code', 'artifact_path'], 'implementation evidence item'); stringValue(evidence.description); if ((evidence.command !== null && typeof evidence.command !== 'string') || (evidence.exit_code !== null && !Number.isSafeInteger(evidence.exit_code)) || (evidence.artifact_path !== null && typeof evidence.artifact_path !== 'string')) reject('VALIDATION_FAILED', 'Invalid evidence types.'); if (typeof evidence.artifact_path === 'string') relativePath(evidence.artifact_path); }
    if (record.status === 'verified' && (!record.evidence.length || record.evidence.some(evidence => !isObject(evidence) || evidence.exit_code !== 0))) reject('VALIDATION_FAILED', 'Verified implementation requires successful command evidence.');
    records.push(record as unknown as ImplementationRecord);
  }
  return records.sort((a, b) => a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : a.implementation_id.localeCompare(b.implementation_id));
}
export async function status(root: string): Promise<ContinuityStatus> {
  const binding = await currentBinding(root); const workflow = await readWorkflow(root); const owner = await readOwnership(root);
  if (owner) {
    const transactions = await recordFiles(root, 'apply-transaction.yaml'); if (!transactions.length) reject('APPLY_RECOVERY_REQUIRED', 'Workspace has live/uncertain ownership; retry or inspect it.');
    const contexts = await Promise.all(transactions.map(file => readTransaction(root, file.slice('planning/changes/'.length).split('/')[0])));
    const matching = contexts.filter(context => context.transaction.owner.anchor_nonce === owner.anchor_nonce); if (matching.length !== 1) reject('APPLY_RECOVERY_REQUIRED', 'Ownership does not have exactly one matching transaction.'); const transaction = matching[0];
    return { ...binding, workflow, source_integrity: { state: 'recovery_required', expected_hash: transaction.transaction.target_source_hash, actual_hash: null }, active_change: null, current_round: transaction.transaction.round, manifest_hash: transaction.transaction.manifest_hash, pending_submissions: [], processed_comment_ids: [], apply_state: { state: 'recovery_required', change_id: transaction.transaction.change_id, transaction_id: transaction.transaction.transaction_id }, implementation_authorization: { state: 'none', change_id: null, manifest_hash: null, scope_hash: null, scope: null }, implementation_status: 'unverified' };
  }
  return withWriteLock(root, 'status', async () => {
    let head: SourceHead | null = null; let integrity: ContinuityStatus['source_integrity'];
    try { head = await completedHead(root); integrity = { state: 'valid', manifest_hash: head.hash, applied_change_id: head.change_id }; }
    catch (error) { if (!(error instanceof CoreError)) throw error; integrity = { state: error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED' ? 'recovery_required' : 'drift', expected_hash: null, actual_hash: null }; }
    const active = await activeChanges(root); const state = active[0] && await changeState(root, active[0].change_id); const round = state && state.round;
    const accepted = round && await acceptedReceipt(root, round); const processed = round ? await responses(root, round) : [];
    const records = head?.round ? await implementationRecords(root, head.round) : [];
    return { ...binding, workflow, source_integrity: integrity, active_change: active[0] ?? null, current_round: round?.manifest.round ?? null, manifest_hash: round?.manifest_hash ?? null, pending_submissions: accepted && accepted.submission.items.some(item => item.comments.length || item.decision !== 'approve') ? [accepted.submission.submission_id] : [], processed_comment_ids: processed.flatMap(response => response.comments.map(comment => comment.comment_id)), apply_state: head?.applied ? { state: 'applied', change_id: head.applied.change_id, result_source_hash: head.applied.result_source_hash } : { state: 'idle' }, implementation_authorization: head ? await headAuthorization(root, head) : { state: 'none', change_id: null, manifest_hash: null, scope_hash: null, scope: null }, implementation_status: records.at(-1)?.status ?? 'unverified' };
  });
}
export async function readApprovedSource(root: string): Promise<ParsedDocument[]> {
  return withWriteLock(root, 'approved source read', async () => { await completedHead(root); return validateSource(await loadRawSource(root)); });
}
export async function gateCheck(root: string, input: GateRequest): Promise<GateResult> {
  return withWriteLock(root, 'gate check', async () => {
    await checkBinding(root, input); const host = await readHost(root, input.host); const protection = host.mode.type === 'advisory' ? 'advisory' : host.active ? 'enforced' : 'unavailable';
    if (!Array.isArray(input.paths) || !['read', 'planning_draft_write', 'implementation_write', 'unknown'].includes(input.operation) || typeof input.tool !== 'string') reject('VALIDATION_FAILED', 'Invalid gate input.');
    for (const file of input.paths) await safePath(root, relativePath(file));
    if (input.operation === 'read') return { allowed: true, protection, checked_paths: input.paths, authorization_manifest_hash: null };
    if (input.operation === 'unknown') reject('SCOPE_DENIED', 'Unknown operation is outside known protected coverage.');
    if (input.operation === 'planning_draft_write') { const active = (await activeChanges(root))[0]; if (!active || !input.paths.length || input.paths.some(file => file !== changeRoot(active.change_id) + '/change.yaml' && !file.startsWith(changeRoot(active.change_id) + '/draft/'))) reject('PATH_DENIED', 'Planning writes must target the active mutable draft, never source/reviews.'); return { allowed: true, protection, checked_paths: input.paths, authorization_manifest_hash: null }; }
    if (protection === 'unavailable' || (protection === 'enforced' && (!host.coverage.protected_tools.includes(input.tool) || host.coverage.uncovered_tools.includes(input.tool)))) reject('HOOK_NOT_ACTIVE', 'No actual active hook coverage for this protected operation.');
    const head = await completedHead(root); const authorization = await headAuthorization(root, head);
    if (authorization.state !== 'authorized' || !authorization.scope) reject('REVIEW_REQUIRED', 'Current normally applied planning lacks fresh implementation authorization.');
    if (!input.paths.length) reject('SCOPE_DENIED', 'Protected implementation writes require explicit paths.');
    for (const file of input.paths) {
      const normalized = file.normalize('NFC').toLowerCase(); if (['planning', '.byeori', '.git'].includes(normalized.split('/')[0]) || !authorization.scope.allowlist.some(scope => scope.match === 'file' ? file === scope.path : file === scope.path || file.startsWith(scope.path + '/'))) reject('SCOPE_DENIED', 'Path is outside the frozen allowlist.', file);
    }
    return { allowed: true, protection, checked_paths: input.paths, authorization_manifest_hash: authorization.manifest_hash };
  });
}
function documentView(document: ParsedDocument, revision: DocumentView['revision'], provenance: DocumentView['provenance']): DocumentView { return { id: document.id, kind: document.kind, path: document.path, raw: document.raw, content: document.content, projection: document.projection, semantic_hash: document.content_hash, raw_hash: document.raw_hash, revision, provenance }; }
export async function get(root: string, input: GetRequest): Promise<DocumentView> {
  return withWriteLock(root, 'document get', async () => {
    if (input.revision && input.revision.side !== 'source') {
      const revision = input.revision; if (!revision.change_id || revision.round === null || revision.side === 'source') reject('VALIDATION_FAILED', 'Historical revision requires change/round/side.'); const round = await readRound(root, revision.change_id, revision.round); if (round.manifest_hash !== revision.manifest_hash) reject('STALE_REVIEW', 'Historical manifest hash mismatch.'); const document = (await roundDocuments(root, round, revision.side)).find(document => document.id === input.object_id); if (!document) reject('VALIDATION_FAILED', 'Object is absent in that frozen side.'); return documentView(document, revision, 'review_snapshot');
    }
    if (input.scope?.type === 'history') reject('VALIDATION_FAILED', 'History get requires an explicit frozen revision.');
    if (input.scope?.type === 'change') {
      const { loadProjectedChange } = await import('./workspace'); const document = (await loadProjectedChange(root, input.scope.change_id)).find(document => document.id === input.object_id); if (!document) reject('VALIDATION_FAILED', 'Draft object is missing.'); return documentView(document, { change_id: input.scope.change_id, round: null, manifest_hash: document.content_hash, side: 'source' }, 'draft');
    }
    const head = await completedHead(root); const revision = { change_id: head.change_id, round: head.round?.manifest.round ?? null, manifest_hash: head.hash, side: 'source' as const }; if (input.revision && !same(input.revision, revision)) reject('STALE_REVIEW', 'Requested source revision is no longer current.'); const document = validateSource(await loadRawSource(root)).find(document => document.id === input.object_id); if (!document) reject('VALIDATION_FAILED', 'Approved object is missing.'); return documentView(document, revision, 'approved');
  });
}
export async function history(root: string, input: HistoryRequest = {}): Promise<HistoryResult> {
  return withWriteLock(root, 'history', async () => {
    const limit = input.limit ?? 25; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.cursor !== undefined && !/^(?:0|[1-9]\d*)$/.test(input.cursor))) reject('VALIDATION_FAILED', 'Invalid history page.');
    const entries: HistoryEntry[] = [];
    for (const file of await recordFiles(root, 'change.yaml')) {
      const id = file.slice('planning/changes/'.length).split('/')[0]; if (input.change_id && input.change_id !== id) continue;
      const numbers = await roundNumbers(root, id); const rounds = await Promise.all(numbers.map(number => readRound(root, id, number)));
      if (input.object_id && !rounds.some(round => round.manifest.deltas.some(delta => delta.object_id === input.object_id))) continue;
      const current = await loadChange(root, id, false); entries.push({ type: 'change', record: current.change });
      for (const round of rounds) { entries.push({ type: 'review', record: round }); const receipt = await acceptedReceipt(root, round); if (receipt) entries.push({ type: 'submission', record: receipt }); entries.push(...(await responses(root, round)).map(record => ({ type: 'response' as const, record }))); entries.push(...(await implementationRecords(root, round)).map(record => ({ type: 'implementation' as const, record }))); }
      const applied = await optionalText(root, changeRoot(id) + '/applied.yaml'); if (applied) { await sourceHead(root, false); entries.push({ type: 'applied', record: parseYaml(applied) as unknown as import('../contracts').AppliedRecord }); }
      const cancelled = await optionalText(root, changeRoot(id) + '/cancelled.yaml'); if (cancelled) { await changeState(root, id); const record = parseYaml(cancelled) as unknown as import('../contracts').CancellationRecord; entries.push({ type: 'cancelled', change_id: id, reason: record.reason, cancelled_at: record.cancelled_at }); }
    }
    const offset = Number(input.cursor ?? '0'); if (!Number.isSafeInteger(offset)) reject('VALIDATION_FAILED', 'Invalid cursor.'); return { entries: entries.slice(offset, offset + limit), next_cursor: offset + limit < entries.length ? String(offset + limit) : null };
  });
}
export async function studioState(root: string): Promise<StudioState> {
  const state = await status(root); const config = await readProjectConfig(root); const identity = await workspaceIdentity(root); let documents: StudioState['documents'] = []; let review: StudioState['review'] = null;
  if (state.source_integrity.state === 'valid') documents = (await readApprovedSource(root)).map(document => ({ id: document.id, kind: document.kind, title: document.projection.title, path: document.path }));
  if (state.active_change && state.current_round && state.manifest_hash) { const { reviewResults } = await import('./review'); review = await reviewResults(root, { ...await currentBinding(root), change_id: state.active_change.change_id, round: state.current_round, manifest_hash: state.manifest_hash }); }
  return { project: { project_id: config.project_id, name: config.name }, branch: identity.git?.branch_ref ?? null, status: state, documents, review };
}
