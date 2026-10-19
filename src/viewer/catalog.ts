import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DOCUMENT_KINDS, type DocumentKind, type JsonObject, type JsonValue } from '../contracts';
import { isObject, parseDocument, validateSource, type ParsedDocument } from '../core/documents';
import { CoreError, reject } from '../core/errors';
import { recordId, relativePath, sourcePath } from '../core/paths';
import { parseYaml, PROFILE, rawHash, semanticHash, VERSIONS } from '../core/yaml';
import type { Catalog, ViewerDocument, ViewerDraftEdit, ViewerInvalidDocument, ViewerIssue, ViewerRelation, ViewerSource } from './types';

export const VIEWER_LIMITS = { documents: 512, changes: 128, entries: 4096, depth: 24, total_bytes: 8 * 1024 * 1024, issues: 256, id_length: 256, relations: 8192, response_bytes: 32 * 1024 * 1024 } as const;
const LABELS: Record<DocumentKind, string> = { prd: 'PRD', actor: 'Actors', scenario: 'Scenarios', feature: 'Features', ia: 'IA', screen: 'Screens', entity: 'Entities', openapi: 'OpenAPI', architecture: 'Architecture' };
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

/** Unlike Core's workflow readers this module never takes a writer lock or repairs records. */
export async function canonicalViewerRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('Viewer root must be an existing directory.');
  return canonical;
}

/** No unbounded readdir and no symlinks in any source/asset path component. */
async function checkedPath(root: string, relative: string): Promise<string> {
  relativePath(relative);
  let current = root;
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) reject('PATH_DENIED', 'Symlinks and non-directory ancestors are not displayed.', relative);
  }
  if (await realpath(current) !== current) reject('PATH_DENIED', 'Source path changed during inspection.', relative);
  return current;
}

/** Bounded even when a file grows while it is being read; special files cannot block open. */
export async function readViewerFile(root: string, relative: string, limit: number = PROFILE.max_bytes): Promise<Buffer> {
  const target = await checkedPath(root, relative);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) reject('VALIDATION_FAILED', 'Only regular files within viewer size limits are displayed.', relative);
    // On Linux pin the opened inode to its inspected path, including all ancestors.
    // The portable checks below also reject ordinary directory/file replacement races.
    if (process.platform === 'linux' && await realpath('/proc/self/fd/' + handle.fd) !== target) reject('PATH_DENIED', 'Source path changed during inspection.', relative);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > limit) reject('VALIDATION_FAILED', 'File exceeds viewer size limits.', relative);
    const after = await handle.stat();
    await checkedPath(root, relative);
    const current = await lstat(target);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject('PATH_DENIED', 'Source changed during inspection; refresh to try again.', relative);
    return Buffer.from(bytes.subarray(0, size));
  } finally { await handle.close(); }
}

function message(error: unknown): string {
  // OS errors may contain absolute paths. Only Core's bounded domain messages leave here.
  return error instanceof CoreError ? error.message.slice(0, 600) : 'This source entry could not be read safely.';
}
function relations(documents: ViewerDocument[], onLimit: () => void): ViewerRelation[] {
  const byId = new Map(documents.map(document => [document.id, document]));
  const edges: ViewerRelation[] = [];
  let limited = false;
  const add = (source: string, target: string, type: string, field: string, kind?: DocumentKind): void => {
    if (edges.length >= VIEWER_LIMITS.relations) { if (!limited) { limited = true; onLimit(); } return; }
    const match = byId.get(target);
    edges.push({ source, target, type, field, resolved: Boolean(match && (!kind || match.kind === kind)) });
  };
  for (const document of documents) {
    const projection = document.projection;
    if (projection.kind !== 'openapi') projection.relations.forEach((relation, index) => add(document.id, relation.target, relation.type, `relations[${index}]`));
    if (projection.kind === 'scenario' || projection.kind === 'feature') projection.actors.forEach((actor, index) => add(document.id, actor, 'actor', `actors[${index}]`, 'actor'));
    if (projection.kind === 'scenario') projection.steps.forEach((step, index) => add(document.id, step.actor, 'step actor', `steps[${index}].actor`, 'actor'));
    if (projection.kind === 'ia') projection.nodes.forEach((node, index) => add(document.id, node.screen_id, 'screen', `nodes[${index}].screen_id`, 'screen'));
    if (projection.kind === 'openapi') projection.operations.forEach(operation => operation.feature_ids.forEach((id, index) => add(document.id, id, 'calls', `${operation.pointer}/x-byeori-features/${index}`, 'feature')));
  }
  return edges;
}


interface StoredPut { operation: 'put'; object_id: string; kind: DocumentKind; path: string; draft_file: string; raw_hash: string }
type StoredEdit = StoredPut | { operation: 'move'; object_id: string; path: string } | { operation: 'delete'; object_id: string };
interface DraftManifest { schema_version: 1; edits: StoredEdit[] }
const HASH = /^[a-f0-9]{64}$/;
const OBJECT_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const normalized = (value: string): string => value.normalize('NFC').toLowerCase();
function exact(value: unknown, keys: string[], label: string): asserts value is JsonObject {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) reject('VALIDATION_FAILED', `Invalid ${label} fields.`);
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) reject('VALIDATION_FAILED', 'Expected a nonempty record string.');
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) reject('VALIDATION_FAILED', 'Invalid SHA-256 record hash.');
}
function texts(value: unknown, identifiers = false): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || identifiers && !OBJECT_ID.test(item)) || new Set(value).size !== value.length) reject('VALIDATION_FAILED', 'Invalid or duplicate record strings.');
}
function contract(value: JsonObject): void {
  for (const [key, expected] of Object.entries(VERSIONS)) if (value[key] !== expected) reject('POLICY_MISMATCH', 'Unsupported record contract versions.');
}
/** Local pure checks mirror persisted record shapes; no workflow reader or writer is called. */
function changeRecord(value: JsonValue, id: string): JsonObject {
  exact(value, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'workspace_fingerprint', 'change_id', 'created_at', 'display_name', 'metadata'], 'change record');
  contract(value); nonempty(value.project_id); recordId(value.project_id); hash(value.workspace_fingerprint); nonempty(value.created_at);
  if (value.change_id !== id || value.display_name !== null && typeof value.display_name !== 'string') reject('VALIDATION_FAILED', 'Change identity or display name is invalid.');
  const metadata = value.metadata;
  exact(metadata, ['type', 'title', 'request', 'reason', 'affected_object_ids', 'implementation_scope'], 'change metadata');
  if (!['spec_change', 'implementation_only'].includes(metadata.type as string)) reject('VALIDATION_FAILED', 'Unknown change type.');
  for (const key of ['title', 'request', 'reason']) nonempty(metadata[key]);
  texts(metadata.affected_object_ids, true);
  const scope = metadata.implementation_scope;
  exact(scope, ['allowlist', 'related_object_ids', 'validation_plan'], 'implementation scope');
  texts(scope.related_object_ids, true); texts(scope.validation_plan);
  if (!Array.isArray(scope.allowlist)) reject('VALIDATION_FAILED', 'Invalid implementation scope.');
  const paths = new Set<string>();
  for (const entry of scope.allowlist) {
    exact(entry, ['path', 'match'], 'scope entry'); nonempty(entry.path); relativePath(entry.path);
    const key = normalized(entry.path);
    if (!['file', 'directory'].includes(entry.match as string) || ['planning', '.byeori', '.git'].includes(key.split('/')[0]) || paths.has(key)) reject('VALIDATION_FAILED', 'Invalid or duplicate scope entry.');
    paths.add(key);
  }
  if (metadata.type === 'implementation_only' && (!scope.allowlist.length || !scope.related_object_ids.length || !scope.validation_plan.length)) reject('VALIDATION_FAILED', 'Incomplete implementation-only scope.');
  return value;
}
function draftManifest(value: JsonValue, id: string): DraftManifest {
  exact(value, ['schema_version', 'edits'], 'draft manifest');
  if (value.schema_version !== 1 || !Array.isArray(value.edits)) reject('VALIDATION_FAILED', 'Invalid draft manifest.');
  if (value.edits.length > VIEWER_LIMITS.documents) reject('VALIDATION_FAILED', 'Draft manifest exceeds the viewer edit limit.');
  const ids = new Set<string>();
  for (const edit of value.edits) {
    if (!isObject(edit)) reject('VALIDATION_FAILED', 'Invalid draft edit.');
    nonempty(edit.object_id);
    if (!OBJECT_ID.test(edit.object_id) || edit.object_id.length > VIEWER_LIMITS.id_length || ids.has(edit.object_id)) reject('VALIDATION_FAILED', 'Invalid or duplicate draft object ID.');
    ids.add(edit.object_id);
    if (edit.operation === 'put') {
      exact(edit, ['operation', 'object_id', 'kind', 'path', 'draft_file', 'raw_hash'], 'put draft');
      nonempty(edit.path); sourcePath(edit.path); hash(edit.raw_hash);
      if (!DOCUMENT_KINDS.includes(edit.kind as DocumentKind) || edit.draft_file !== `planning/changes/${id}/draft/${edit.raw_hash}.yaml`) reject('PATH_DENIED', 'Draft file or kind is not bound to its manifest.');
    } else if (edit.operation === 'move') {
      exact(edit, ['operation', 'object_id', 'path'], 'move draft'); nonempty(edit.path); sourcePath(edit.path);
    } else if (edit.operation === 'delete') exact(edit, ['operation', 'object_id'], 'delete draft');
    else reject('VALIDATION_FAILED', 'Unknown draft operation.');
  }
  return value as unknown as DraftManifest;
}
export class ViewerSelectionError extends Error {}

/** A selected change displays its own saved puts/intents, never a replay onto today's source. */
export async function loadCatalog(inputRoot: string, changeId?: string): Promise<Catalog> {
  if (changeId !== undefined) recordId(changeId);
  const root = await canonicalViewerRoot(inputRoot);
  const issues: ViewerIssue[] = [];
  const parsed: ParsedDocument[] = [];
  const storage = new Map<ParsedDocument, string>();
  const invalid: ViewerInvalidDocument[] = [];
  const edits: ViewerDraftEdit[] = [];
  const source: ViewerSource = { id: 'source', kind: 'source', change_id: null, label: 'Source files', path: 'planning/source', status: 'source', version: null };
  const sources: ViewerSource[] = [source];
  const manifests = new Map<string, DraftManifest>();
  let truncated = false;
  let entries = 0;
  let candidates = 0;
  let bytes = 0;
  let stopped = false;
  const issue = (code: string, relative: string | null, detail: string): ViewerIssue => {
    const value = { code, path: relative, message: detail.slice(0, 600) };
    if (issues.length < VIEWER_LIMITS.issues) issues.push(value);
    else truncated = true;
    return value;
  };
  const limit = (relative: string, detail: string): void => { truncated = true; issue('LIMIT_REACHED', relative, detail); };
  const read = async (relative: string, optional = false): Promise<string | null> => {
    if (stopped) return null;
    let buffer: Buffer;
    try {
      const info = await lstat(await checkedPath(root, relative));
      if (!info.isFile()) reject('PATH_DENIED', 'Only regular files are displayed.', relative);
      if (info.size > PROFILE.max_bytes) reject('VALIDATION_FAILED', 'Document exceeds the 1 MiB YAML limit.', relative);
      if (bytes + info.size > VIEWER_LIMITS.total_bytes) { stopped = true; limit(relative, 'Total source byte limit reached; the catalog is incomplete.'); return null; }
      buffer = await readViewerFile(root, relative, Math.min(PROFILE.max_bytes, VIEWER_LIMITS.total_bytes - bytes));
    } catch (error) { if (optional && errorCode(error) === 'ENOENT') return null; throw error; }
    bytes += buffer.length;
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { reject('VALIDATION_FAILED', 'Document is not valid UTF-8.', relative); }
  };
  const names = async (relative: string, optional = false): Promise<string[]> => {
    if (stopped) return [];
    let target: string;
    try { target = await checkedPath(root, relative); }
    catch (error) { if (optional && errorCode(error) === 'ENOENT') return []; throw error; }
    const directory = await opendir(target);
    const result: string[] = [];
    for await (const entry of directory) {
      if (++entries > VIEWER_LIMITS.entries) { stopped = true; limit(relative, 'Directory entry limit reached; the catalog is incomplete.'); break; }
      result.push(entry.name);
    }
    const folded = new Map<string, number>();
    for (const name of result) folded.set(normalized(name), (folded.get(normalized(name)) ?? 0) + 1);
    return result.sort().filter(name => {
      if (folded.get(normalized(name)) === 1) return true;
      issue('PATH_COLLISION', relative + '/' + name, 'Case/Unicode-colliding entries are not displayed.'); return false;
    });
  };
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (stopped) return;
    if (depth > VIEWER_LIMITS.depth) { limit(relative, 'Directory depth limit reached; deeper entries were skipped.'); return; }
    let children: string[];
    try { children = await names(relative, relative === 'planning/source'); }
    catch (error) { issue('PATH_SKIPPED', relative, message(error)); return; }
    for (const name of children) {
      if (stopped) break;
      const child = relative + '/' + name;
      try {
        relativePath(child);
        const info = await lstat(await checkedPath(root, child));
        if (info.isDirectory()) { await walk(child, depth + 1); continue; }
        if (!info.isFile()) { issue('PATH_SKIPPED', child, 'Only regular YAML files are displayed.'); continue; }
        if (!/\.ya?ml$/.test(name)) continue;
        sourcePath(child);
        if (++candidates > VIEWER_LIMITS.documents) { stopped = true; limit(child, 'Document limit reached; the catalog is incomplete.'); break; }
        if (info.size > PROFILE.max_bytes) { issue('DOCUMENT_TOO_LARGE', child, 'Document exceeds the 1 MiB YAML limit.'); continue; }
        try {
          const raw = await read(child); if (raw === null) break;
          const document = parseDocument({ path: child, raw });
          if (document.id.length > VIEWER_LIMITS.id_length) issue('IDENTITY_TOO_LONG', child, 'Document ID exceeds the viewer limit of 256 characters.');
          else parsed.push(document);
        } catch (error) { issue('INVALID_DOCUMENT', child, message(error)); }
      } catch (error) { issue('PATH_SKIPPED', child, message(error)); }
    }
  };
  const recordedStatus = async (relative: string, record: JsonObject): Promise<ViewerSource['status']> => {
    const cancellation = await read(relative + '/cancelled.yaml', true);
    const applied = await read(relative + '/applied.yaml', true);
    if (stopped) return 'invalid';
    if (cancellation !== null && applied !== null) reject('VALIDATION_FAILED', 'Both cancellation and applied records are present.');
    for (const [raw, type] of [[cancellation, 'cancelled'], [applied, 'applied']] as const) if (raw !== null) {
      const value = parseYaml(raw);
      if (type === 'cancelled') {
        exact(value, ['project_id', 'workspace_fingerprint', 'change_id', 'cancelled_at', 'reason'], 'cancellation');
        nonempty(value.cancelled_at); nonempty(value.reason);
      } else {
        exact(value, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'transaction_id', 'submission_id', 'payload_hash', 'base_applied_change_id', 'base_source_hash', 'result_source_hash', 'snapshot_tree_hash', 'metadata_hash', 'scope_hash', 'applied_at'], 'applied');
        contract(value); nonempty(value.applied_at);
        for (const key of ['transaction_id', 'submission_id']) { nonempty(value[key]); recordId(value[key]); }
        for (const key of ['manifest_hash', 'payload_hash', 'base_source_hash', 'result_source_hash', 'snapshot_tree_hash', 'metadata_hash', 'scope_hash']) hash(value[key]);
        if (value.base_applied_change_id !== null) { nonempty(value.base_applied_change_id); recordId(value.base_applied_change_id); }
        if (!Number.isSafeInteger(value.round) || (value.round as number) < 1) reject('VALIDATION_FAILED', 'Invalid applied round.');
      }
      for (const key of ['project_id', 'workspace_fingerprint', 'change_id']) if (value[key] !== record[key]) reject('VALIDATION_FAILED', 'Historical status record binding mismatch.');
      return type === 'cancelled' ? 'cancelled-recorded' : 'applied-recorded';
    }
    const rounds = await names(relative + '/rounds', true);
    for (const number of rounds.reverse()) {
      if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) continue;
      const raw = await read(relative + '/rounds/' + number + '/manifest.yaml', true);
      if (raw === null) continue;
      const value = parseYaml(raw);
      exact(value, ['manifest', 'manifest_hash', 'prepared_at'], 'review round');
      nonempty(value.prepared_at); hash(value.manifest_hash);
      if (!isObject(value.manifest) || value.manifest.change_id !== record.change_id || value.manifest.project_id !== record.project_id || value.manifest.workspace_fingerprint !== record.workspace_fingerprint || value.manifest.round !== Number(number) || semanticHash(value.manifest) !== value.manifest_hash) reject('VALIDATION_FAILED', 'Review record binding or hash mismatch.');
      return 'review-recorded';
    }
    return stopped ? 'invalid' : 'draft';
  };
  // Source remains the backward-compatible default. Change discovery never opens draft chunks.
  if (changeId === undefined) await walk('planning/source', 0);
  let changes: string[] = [];
  try { changes = await names('planning/changes', true); }
  catch (error) { issue('PATH_SKIPPED', 'planning/changes', message(error)); }
  for (const id of changes) {
    if (stopped) break;
    const relative = 'planning/changes/' + id;
    try {
      recordId(id);
      if (!(await lstat(await checkedPath(root, relative))).isDirectory()) continue;
      if (sources.length > VIEWER_LIMITS.changes) { limit('planning/changes', 'Change-set limit reached; the source selector is incomplete.'); break; }
      const raw = await read(relative + '/change.yaml', true); if (raw === null) continue;
      const option: ViewerSource = { id: 'change:' + id, kind: 'draft', change_id: id, label: id, path: relative + '/draft', status: 'invalid', version: null };
      sources.push(option);
      let record: JsonObject | null = null;
      try {
        record = changeRecord(parseYaml(raw), id);
        option.label = (typeof record.display_name === 'string' && record.display_name || (record.metadata as JsonObject).title as string).slice(0, 256);
      } catch (error) { issue('INVALID_CHANGE', relative + '/change.yaml', message(error)); }
      try {
        const rawManifest = await read(relative + '/draft-manifest.yaml', true);
        if (stopped) continue;
        const manifest = rawManifest === null ? { schema_version: 1 as const, edits: [] } : draftManifest(parseYaml(rawManifest), id);
        manifests.set(id, manifest);
        if (record) {
          option.version = semanticHash({ record, draft_manifest: manifest });
          option.status = await recordedStatus(relative, record);
        }
      } catch (error) { issue('INVALID_CHANGE', relative, message(error)); }
    } catch (error) { issue('PATH_SKIPPED', relative, message(error)); }
  }
  const selected = changeId === undefined ? source : sources.find(option => option.change_id === changeId);
  if (!selected) throw new ViewerSelectionError('The selected change is unavailable or outside viewer limits.');
  if (changeId !== undefined) {
    const manifest = manifests.get(changeId);
    for (const edit of manifest?.edits ?? []) {
      edits.push({ operation: edit.operation, object_id: edit.object_id, kind: edit.operation === 'put' ? edit.kind : null, path: edit.operation === 'delete' ? null : edit.path, storage_path: edit.operation === 'put' ? edit.draft_file : null });
      if (edit.operation !== 'put' || stopped) continue;
      let raw: string | null;
      try { raw = await read(edit.draft_file); }
      catch (error) { issue('PATH_SKIPPED', edit.draft_file, message(error)); continue; }
      if (raw === null) continue;
      try {
        if (rawHash(raw) !== edit.raw_hash) reject('VALIDATION_FAILED', 'Draft bytes do not match the manifest hash.', edit.draft_file);
        const document = parseDocument({ path: edit.path, raw });
        if (document.id !== edit.object_id || document.kind !== edit.kind) reject('VALIDATION_FAILED', 'Draft identity or kind differs from its manifest.', edit.draft_file);
        parsed.push(document); storage.set(document, edit.draft_file);
      } catch (error) {
        const problem = issue('INVALID_DOCUMENT', edit.draft_file, message(error));
        invalid.push({ id: edit.object_id, kind: edit.kind, path: edit.path, storage_path: edit.draft_file, raw, raw_hash: rawHash(raw), provenance: 'draft', issues: [problem] });
      }
    }
  }
  const idCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  for (const document of parsed) idCounts.set(document.id, (idCounts.get(document.id) ?? 0) + 1);
  for (const item of changeId === undefined ? parsed : edits.filter(edit => edit.path !== null)) { const key = normalized(item.path!); pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1); }
  const unique = parsed.filter(document => {
    if (idCounts.get(document.id) !== 1) { issue('DUPLICATE_ID', document.path, `Duplicate document ID ${document.id}; ambiguous documents are not displayed.`); return false; }
    if (pathCounts.get(normalized(document.path)) !== 1) {
      const problem = issue('PATH_COLLISION', document.path, 'Draft target paths collide; ambiguous projections are not displayed.');
      if (changeId !== undefined) invalid.push({ id: document.id, kind: document.kind, path: document.path, storage_path: storage.get(document)!, raw: document.raw, raw_hash: document.raw_hash, provenance: 'draft', issues: [problem] });
      return false;
    }
    return true;
  });
  try { validateSource(unique.map(document => ({ path: document.path, raw: document.raw }))); }
  catch (error) {
    const location = error instanceof CoreError ? error.diagnostics[0]?.path ?? null : null;
    issue(changeId === undefined ? 'SOURCE_VALIDATION' : 'DRAFT_SET_VALIDATION', location, message(error));
  }
  const documents: ViewerDocument[] = unique.map(document => ({ id: document.id, kind: document.kind, path: document.path, storage_path: storage.get(document) ?? document.path, title: document.projection.title, summary: document.projection.summary, raw: document.raw, content: document.content, projection: document.projection, semantic_hash: document.content_hash, raw_hash: document.raw_hash, provenance: selected.kind }));
  if (selected.kind === 'source') selected.version = semanticHash(documents.map(document => ({ path: document.path, raw_hash: document.raw_hash })));
  const edges = relations(documents, () => limit(selected.path, 'Relation display limit reached; complete references remain in the document source.'));
  return { schema_version: 1, workspace: { name: path.basename(root), source_path: 'planning/source' }, mode: 'read-only', provenance: selected.kind, sources, selected_source: selected, loaded_at: new Date().toISOString(), kinds: DOCUMENT_KINDS.map(kind => ({ kind, label: LABELS[kind], count: documents.filter(document => document.kind === kind).length + invalid.filter(document => document.kind === kind).length })), documents, invalid_documents: invalid, draft_edits: edits, relations: edges, issues, truncated };
}
