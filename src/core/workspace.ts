import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { DOCUMENT_KINDS, type ChangeMetadata, type ChangeRecord, type CreateChangeRequest, type DeleteDraftRequest, type DraftWriteResult, type JsonObject, type MoveDraftRequest, type ProjectConfig, type PutDraftRequest, type UpdateChangeRequest, type WorkflowRecord, type WorkflowWriteRequest, type WorkspaceBinding, type WorkspaceIdentity } from '../contracts';
import { isObject, parseDocument, projectSource, sourceManifest, validateSource, type DraftEdit, type ParsedDocument, type RawDocument } from './documents';
import { CoreError, reject } from './errors';
import { withWriteLock, type Writer } from './ownership';
import { ensureDirectory, listFiles, readText, recordId, relativePath, safePath, sourcePath } from './paths';
import { canonicalJson, checkRaw, parseYaml, rawHash, semanticHash, VERSIONS } from './yaml';

const run = promisify(execFile);
const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const HASH = /^[a-f0-9]{64}$/;
type StoredChange = Omit<ChangeRecord, 'version'>;
type StoredEdit = Exclude<DraftEdit, { operation: 'put' }> | { operation: 'put'; object_id: string; kind: PutDraftRequest['kind']; path: string; draft_file: string; raw_hash: string };
interface DraftManifest { schema_version: 1; edits: StoredEdit[] }
function exact(value: unknown, keys: string[], label: string): asserts value is JsonObject {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) reject('VALIDATION_FAILED', `Invalid ${label} fields.`);
}
function texts(value: unknown, label: string, identifiers = false): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || (identifiers && !ID.test(item))) || new Set(value).size !== value.length) reject('VALIDATION_FAILED', `Invalid/duplicate ${label}.`);
}
function text(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value) reject('VALIDATION_FAILED', `Missing ${label}.`); }
function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !HASH.test(value)) reject('VALIDATION_FAILED', 'Malformed version hash.'); }
export function validateMetadata(value: unknown): asserts value is ChangeMetadata {
  canonicalJson(value);
  exact(value, ['type', 'title', 'request', 'reason', 'affected_object_ids', 'implementation_scope'], 'change metadata');
  if (!['spec_change', 'implementation_only'].includes(value.type as string)) reject('VALIDATION_FAILED', 'Unknown change type.');
  for (const key of ['title', 'request', 'reason']) text(value[key], key);
  texts(value.affected_object_ids, 'affected object IDs', true);
  exact(value.implementation_scope, ['allowlist', 'related_object_ids', 'validation_plan'], 'implementation scope');
  const scope = value.implementation_scope;
  texts(scope.related_object_ids, 'related planning IDs', true); texts(scope.validation_plan, 'validation plan');
  if (!Array.isArray(scope.allowlist)) reject('VALIDATION_FAILED', 'Allowlist must be an array.');
  const entries = new Set<string>();
  for (const entry of scope.allowlist) {
    exact(entry, ['path', 'match'], 'scope entry'); text(entry.path, 'scope path'); relativePath(entry.path);
    const normalized = entry.path.normalize('NFC').toLowerCase();
    if (!['file', 'directory'].includes(entry.match as string) || ['planning', '.byeori', '.git'].includes(normalized.split('/')[0]) || entries.has(normalized)) reject('SCOPE_DENIED', 'Invalid, duplicate or managed-record implementation scope.');
    entries.add(normalized);
  }
  if (value.type === 'implementation_only' && (!scope.allowlist.length || !scope.related_object_ids.length || !scope.validation_plan.length)) reject('VALIDATION_FAILED', 'Implementation-only changes require related planning, scope and validation plan.');
}
export async function workspaceIdentity(inputRoot: string): Promise<WorkspaceIdentity> {
  let root = await realpath(inputRoot);
  let top: string;
  try { top = (await run('git', ['-C', root, 'rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch (error) {
    if ((error as { stderr?: string }).stderr?.includes('not a git repository')) return { canonical_root: root, git: null };
    reject('CAPABILITY_UNAVAILABLE', 'Cannot determine Git workspace identity.');
  }
  root = await realpath(top);
  const gitDir = (await run('git', ['-C', root, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
  const commonDir = (await run('git', ['-C', root, 'rev-parse', '--git-common-dir'])).stdout.trim();
  let branch: string | null; let head: string | null = null;
  try { branch = (await run('git', ['-C', root, 'symbolic-ref', '-q', 'HEAD'])).stdout.trim(); }
  catch { branch = null; head = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(); }
  return { canonical_root: root, git: { common_dir: await realpath(path.resolve(root, commonDir)), worktree_git_dir: await realpath(gitDir), branch_ref: branch, detached_head: head } };
}
async function optionalText(root: string, relative: string): Promise<string | null> {
  try { return await readText(root, relative); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function validateConfig(value: unknown): ProjectConfig {
  exact(value, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'name', 'created_at', 'workspace_identity', 'genesis_manifest', 'genesis_hash'], 'project config');
  if (value.schema_version !== 1 || value.policy_version !== VERSIONS.policy_version || value.canonicalization_version !== VERSIONS.canonicalization_version) reject('POLICY_MISMATCH', 'Unsupported project contract versions.');
  text(value.project_id, 'project ID'); recordId(value.project_id); text(value.name, 'project name'); text(value.created_at, 'created timestamp');
  if (!isObject(value.workspace_identity) || typeof value.workspace_identity.canonical_root !== 'string') reject('VALIDATION_FAILED', 'Invalid workspace identity.');
  const genesis = sourceManifest(value.project_id, []);
  if (canonicalJson(value.genesis_manifest) !== canonicalJson(genesis) || value.genesis_hash !== semanticHash(genesis)) reject('SOURCE_DRIFT', 'Genesis must be the fixed empty source manifest.');
  return value as unknown as ProjectConfig;
}
export async function readProjectConfig(inputRoot: string): Promise<ProjectConfig> {
  const identity = await workspaceIdentity(inputRoot);
  const config = validateConfig(parseYaml(await readText(identity.canonical_root, 'planning/config.yaml')));
  const previous = config.workspace_identity;
  if (identity.canonical_root !== previous.canonical_root || identity.git?.common_dir !== previous.git?.common_dir || identity.git?.worktree_git_dir !== previous.git?.worktree_git_dir) reject('WORKSPACE_MISMATCH', 'Project belongs to a different root/worktree.');
  return config;
}
export async function currentBinding(inputRoot: string): Promise<WorkspaceBinding> {
  const config = await readProjectConfig(inputRoot);
  return { project_id: config.project_id, workspace_fingerprint: semanticHash(await workspaceIdentity(inputRoot)) };
}
function initialWorkflow(projectId: string): WorkflowRecord {
  const body = { schema_version: 1 as const, project_id: projectId, focus: { kind: null, object_id: null, change_id: null }, facts: [], assumptions: [], open_questions: [], next_action: null, feedback_progress: [], correction_attempts: [] };
  return { ...body, version: semanticHash(body), updated_at: new Date().toISOString() };
}
export async function initializeWorkspace(inputRoot: string, name = path.basename(inputRoot)): Promise<ProjectConfig> {
  const identity = await workspaceIdentity(inputRoot); const root = identity.canonical_root;
  return withWriteLock(root, 'init', async writer => {
    const existing = await optionalText(root, 'planning/config.yaml');
    const config = existing === null ? (() => {
      const projectId = randomUUID(); const genesis = sourceManifest(projectId, []);
      return { ...VERSIONS, project_id: projectId, name, created_at: new Date().toISOString(), workspace_identity: identity, genesis_manifest: genesis, genesis_hash: semanticHash(genesis) };
    })() : await readProjectConfig(root);
    if (!name.trim()) reject('VALIDATION_FAILED', 'Project name cannot be empty.');
    if (existing === null) await writer.write('planning/config.yaml', stringify(config), true);
    if (await optionalText(root, 'planning/workflow.yaml') === null) await writer.write('planning/workflow.yaml', stringify(initialWorkflow(config.project_id)), true);
    await ensureDirectory(root, 'planning/source', writer.assert); await ensureDirectory(root, 'planning/changes', writer.assert);
    const previousIgnore = await optionalText(root, '.gitignore') ?? '';
    const begin = '# byeori:begin'; const end = '# byeori:end';
    const block = `${begin}\n/.byeori/\n/planning/.runtime/\n${end}`;
    const starts = previousIgnore.split(begin).length - 1; const ends = previousIgnore.split(end).length - 1;
    if (starts !== ends || starts > 1 || (starts === 1 && previousIgnore.indexOf(end) < previousIgnore.indexOf(begin))) reject('VALIDATION_FAILED', 'Malformed managed ignore block; existing content preserved.');
    const next = starts ? previousIgnore.replace(/# byeori:begin[\s\S]*?# byeori:end/, block) : previousIgnore + (previousIgnore && !previousIgnore.endsWith('\n') ? '\n' : '') + block + '\n';
    if (next !== previousIgnore) await writer.write('.gitignore', next);
    return config;
  });
}
async function checkBinding(root: string, binding: WorkspaceBinding): Promise<void> {
  const current = await currentBinding(root);
  if (canonicalJson(current) !== canonicalJson({ project_id: binding.project_id, workspace_fingerprint: binding.workspace_fingerprint })) reject('WORKSPACE_MISMATCH', 'Project/workspace binding is stale.');
}
function changeRoot(id: string): string { return 'planning/changes/' + recordId(id); }
function validateStoredChange(value: unknown): StoredChange {
  exact(value, ['schema_version', 'policy_version', 'canonicalization_version', 'project_id', 'workspace_fingerprint', 'change_id', 'created_at', 'display_name', 'metadata'], 'change record');
  for (const key of ['project_id', 'change_id']) { text(value[key], key); recordId(value[key]); }
  hash(value.workspace_fingerprint); text(value.created_at, 'created timestamp');
  if (value.schema_version !== 1 || value.policy_version !== VERSIONS.policy_version || value.canonicalization_version !== VERSIONS.canonicalization_version || (value.display_name !== null && typeof value.display_name !== 'string')) reject('POLICY_MISMATCH', 'Unsupported change contract or display name.');
  validateMetadata(value.metadata);
  return value as unknown as StoredChange;
}
async function loadManifest(root: string, id: string): Promise<DraftManifest> {
  const raw = await optionalText(root, changeRoot(id) + '/draft-manifest.yaml');
  if (raw === null) return { schema_version: 1, edits: [] };
  const value = parseYaml(raw); exact(value, ['schema_version', 'edits'], 'draft manifest');
  if (value.schema_version !== 1 || !Array.isArray(value.edits)) reject('VALIDATION_FAILED', 'Invalid draft manifest.');
  const ids: string[] = [];
  for (const edit of value.edits) {
    if (!isObject(edit)) reject('VALIDATION_FAILED', 'Invalid draft edit.');
    text(edit.object_id, 'draft object ID'); if (!ID.test(edit.object_id)) reject('VALIDATION_FAILED', 'Invalid planning object ID.'); ids.push(edit.object_id);
    if (edit.operation === 'put') {
      exact(edit, ['operation', 'object_id', 'kind', 'path', 'draft_file', 'raw_hash'], 'put draft'); text(edit.path, 'source path'); sourcePath(edit.path); hash(edit.raw_hash); text(edit.draft_file, 'raw draft file');
      if (!DOCUMENT_KINDS.includes(edit.kind as PutDraftRequest['kind']) || edit.draft_file !== `${changeRoot(id)}/draft/${edit.raw_hash}.yaml`) reject('PATH_DENIED', 'Draft raw file/kind is not bound to its manifest.');
    } else if (edit.operation === 'move') { exact(edit, ['operation', 'object_id', 'path'], 'move draft'); text(edit.path, 'source path'); sourcePath(edit.path); }
    else if (edit.operation === 'delete') exact(edit, ['operation', 'object_id'], 'delete draft');
    else reject('VALIDATION_FAILED', 'Unknown draft operation.');
  }
  if (new Set(ids).size !== ids.length) reject('VALIDATION_FAILED', 'Duplicate draft object IDs.');
  return value as unknown as DraftManifest;
}
async function loadChange(root: string, id: string): Promise<{ change: ChangeRecord; stored: StoredChange; manifest: DraftManifest }> {
  const stored = validateStoredChange(parseYaml(await readText(root, changeRoot(id) + '/change.yaml')));
  if (stored.change_id !== id) reject('VALIDATION_FAILED', 'Change ID/path mismatch.');
  await checkBinding(root, stored);
  const manifest = await loadManifest(root, id);
  return { stored, manifest, change: { ...stored, version: semanticHash({ record: stored, draft_manifest: manifest }) } };
}
async function assertEditable(root: string, id: string): Promise<void> {
  if (await optionalText(root, changeRoot(id) + '/applied.yaml') !== null || await optionalText(root, changeRoot(id) + '/cancelled.yaml') !== null) reject('CONFLICT', 'Applied/cancelled change cannot be edited.');
}
async function mutate<T>(inputRoot: string, input: WorkspaceBinding & { change_id: string; expected_version: string }, action: (writer: Writer, current: Awaited<ReturnType<typeof loadChange>>) => Promise<T>): Promise<T> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'change mutation', async writer => {
    await checkBinding(root, input); const current = await loadChange(root, input.change_id); hash(input.expected_version);
    if (input.expected_version !== current.change.version) reject('CONFLICT', 'Draft version changed; unsaved input must be preserved.');
    await assertEditable(root, input.change_id);
    return action(writer, current);
  });
}
export async function createChange(inputRoot: string, input: CreateChangeRequest): Promise<ChangeRecord> {
  validateMetadata(input.metadata); const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'change create', async writer => {
    await checkBinding(root, input);
    for (const file of await listFiles(root, 'planning/changes')) if (file.endsWith('/change.yaml')) reject('CONFLICT', 'An existing change requires record-derived lifecycle reconciliation before another can be created.');
    for (const scope of input.metadata.implementation_scope.allowlist) await safePath(root, scope.path);
    const stored: StoredChange = { ...VERSIONS, project_id: input.project_id, workspace_fingerprint: input.workspace_fingerprint, change_id: randomUUID(), created_at: new Date().toISOString(), display_name: input.display_name ?? null, metadata: input.metadata };
    if (stored.display_name !== null && typeof stored.display_name !== 'string') reject('VALIDATION_FAILED', 'Invalid display name.');
    await writer.write(changeRoot(stored.change_id) + '/change.yaml', stringify(stored), true);
    return (await loadChange(root, stored.change_id)).change;
  });
}
export async function readChange(inputRoot: string, id: string): Promise<ChangeRecord> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'change read', async () => (await loadChange(root, id)).change);
}
export async function updateChange(inputRoot: string, input: UpdateChangeRequest): Promise<ChangeRecord> {
  validateMetadata(input.metadata);
  return mutate(inputRoot, input, async (writer, current) => {
    for (const scope of input.metadata.implementation_scope.allowlist) await safePath(writer.root, scope.path);
    await writer.write(changeRoot(input.change_id) + '/change.yaml', stringify({ ...current.stored, metadata: input.metadata }));
    return (await loadChange(writer.root, input.change_id)).change;
  });
}
export async function putDraft(inputRoot: string, input: PutDraftRequest): Promise<DraftWriteResult> {
  sourcePath(input.path); checkRaw(input.raw);
  if (!ID.test(input.object_id) || !DOCUMENT_KINDS.includes(input.kind)) reject('VALIDATION_FAILED', 'Invalid draft object ID/kind.');
  return mutate(inputRoot, input, async (writer, current) => {
    await safePath(writer.root, input.path);
    await checkDraftPath(writer.root, current.manifest, input.object_id, input.path);
    const edits = current.manifest.edits.filter(edit => edit.object_id !== input.object_id);
    if (edits.some(edit => edit.operation !== 'delete' && edit.path.normalize('NFC').toLowerCase() === input.path.normalize('NFC').toLowerCase())) reject('CONFLICT', 'Draft source path is already used.');
    const checksum = rawHash(input.raw); const file = `${changeRoot(input.change_id)}/draft/${checksum}.yaml`;
    const previous = await optionalText(writer.root, file);
    if (previous === null) await writer.write(file, input.raw, true);
    else if (previous !== input.raw) reject('CONFLICT', 'Raw draft chunk hash collision/corruption.');
    edits.push({ operation: 'put', object_id: input.object_id, kind: input.kind, path: input.path, draft_file: file, raw_hash: checksum });
    await writer.write(changeRoot(input.change_id) + '/draft-manifest.yaml', stringify({ schema_version: 1, edits }));
    let parsed: ParsedDocument | null; let diagnostics: CoreError['diagnostics'] = [];
    try { parsed = parseDocument(input); if (parsed.id !== input.object_id || parsed.kind !== input.kind) reject('VALIDATION_FAILED', 'Draft identity differs from expected object/kind.'); }
    catch (error) { if (error instanceof CoreError) { parsed = null; diagnostics = error.diagnostics; } else throw error; }
    return { change: (await loadChange(writer.root, input.change_id)).change, draft: { object_id: input.object_id, kind: input.kind, path: input.path, raw: input.raw, content: parsed?.content ?? null, valid: parsed !== null }, diagnostics };
  });
}
async function checkDraftPath(root: string, manifest: DraftManifest, objectId: string, proposed: string): Promise<void> {
  const paths = new Map(validateSource(await loadRawSource(root)).map(document => [document.id, document.path]));
  for (const edit of manifest.edits) { if (edit.operation === 'delete') paths.delete(edit.object_id); else paths.set(edit.object_id, edit.path); }
  paths.set(objectId, proposed);
  const normalized = [...paths.values()].map(value => value.normalize('NFC').toLowerCase());
  if (new Set(normalized).size !== normalized.length) reject('CONFLICT', 'Projected draft/source paths collide.');
}
async function writeIntent(inputRoot: string, input: DeleteDraftRequest | MoveDraftRequest, operation: 'delete' | 'move'): Promise<ChangeRecord> {
  return mutate(inputRoot, input, async (writer, current) => {
    if (!ID.test(input.object_id)) reject('VALIDATION_FAILED', 'Invalid object ID.');
    const original = current.manifest.edits.find(edit => edit.object_id === input.object_id);
    const base = validateSource(await loadRawSource(writer.root));
    const existsInSource = base.some(document => document.id === input.object_id);
    if (!existsInSource && original?.operation !== 'put') reject('VALIDATION_FAILED', 'Cannot move/delete a nonexistent object.');
    const edits = current.manifest.edits.filter(edit => edit.object_id !== input.object_id);
    if (operation === 'move' && 'path' in input) {
      const target = sourcePath(input.path); await safePath(writer.root, target); await checkDraftPath(writer.root, current.manifest, input.object_id, target);
      edits.push(original?.operation === 'put' ? { ...original, path: target } : { operation: 'move', object_id: input.object_id, path: target });
    } else if (existsInSource) edits.push({ operation: 'delete', object_id: input.object_id });
    await writer.write(changeRoot(input.change_id) + '/draft-manifest.yaml', stringify({ schema_version: 1, edits }));
    return (await loadChange(writer.root, input.change_id)).change;
  });
}
export function deleteDraft(root: string, input: DeleteDraftRequest): Promise<ChangeRecord> { return writeIntent(root, input, 'delete'); }
export function moveDraft(root: string, input: MoveDraftRequest): Promise<ChangeRecord> { return writeIntent(root, input, 'move'); }
export async function loadRawSource(root: string): Promise<RawDocument[]> {
  const result: RawDocument[] = [];
  for (const file of await listFiles(root, 'planning/source')) { sourcePath(file); result.push({ path: file, raw: await readText(root, file) }); }
  return result;
}
export async function readProjectedChange(inputRoot: string, id: string): Promise<ParsedDocument[]> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'draft projection', async () => {
    const current = await loadChange(root, id); const edits: DraftEdit[] = [];
    for (const edit of current.manifest.edits) {
      if (edit.operation !== 'put') edits.push(edit);
      else { const raw = await readText(root, edit.draft_file); if (rawHash(raw) !== edit.raw_hash) reject('VALIDATION_FAILED', 'Raw draft chunk is corrupt.'); edits.push({ operation: 'put', object_id: edit.object_id, kind: edit.kind, path: edit.path, raw }); }
    }
    return projectSource(await loadRawSource(root), edits);
  });
}
export async function readDraft(inputRoot: string, id: string, objectId: string): Promise<string> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'draft read', async () => {
    const current = await loadChange(root, id); const edit = current.manifest.edits.find(edit => edit.object_id === objectId && edit.operation === 'put');
    if (!edit || edit.operation !== 'put') reject('VALIDATION_FAILED', 'Draft does not exist.');
    const raw = await readText(root, edit.draft_file); if (rawHash(raw) !== edit.raw_hash) reject('VALIDATION_FAILED', 'Raw draft chunk is corrupt.'); return raw;
  });
}
function workflowBody(workflow: WorkflowRecord): Omit<WorkflowRecord, 'version' | 'updated_at'> {
  return { schema_version: workflow.schema_version, project_id: workflow.project_id, focus: workflow.focus, facts: workflow.facts, assumptions: workflow.assumptions, open_questions: workflow.open_questions, next_action: workflow.next_action, feedback_progress: workflow.feedback_progress, correction_attempts: workflow.correction_attempts };
}
function validateWorkflow(value: unknown): WorkflowRecord {
  exact(value, ['schema_version', 'project_id', 'version', 'updated_at', 'focus', 'facts', 'assumptions', 'open_questions', 'next_action', 'feedback_progress', 'correction_attempts'], 'workflow');
  text(value.project_id, 'project ID'); recordId(value.project_id); hash(value.version); text(value.updated_at, 'update timestamp');
  if (value.schema_version !== 1 || (value.next_action !== null && typeof value.next_action !== 'string')) reject('VALIDATION_FAILED', 'Invalid workflow version/next action.');
  exact(value.focus, ['kind', 'object_id', 'change_id'], 'workflow focus');
  if (value.focus.kind !== null && !DOCUMENT_KINDS.includes(value.focus.kind as PutDraftRequest['kind'])) reject('VALIDATION_FAILED', 'Unknown workflow document kind.');
  if (value.focus.object_id !== null && (typeof value.focus.object_id !== 'string' || !ID.test(value.focus.object_id))) reject('VALIDATION_FAILED', 'Invalid workflow object ID.');
  if (value.focus.change_id !== null) { text(value.focus.change_id, 'focus change ID'); recordId(value.focus.change_id); }
  for (const key of ['facts', 'assumptions', 'open_questions']) {
    const elements = value[key]; if (!Array.isArray(elements)) reject('VALIDATION_FAILED', 'Workflow context must be arrays.');
    const ids: string[] = [];
    for (const element of elements) { exact(element, key === 'open_questions' ? ['id', 'text', 'blocking'] : ['id', 'text'], key); text(element.id, 'element ID'); text(element.text, 'context text'); ids.push(element.id); if (key === 'open_questions' && typeof element.blocking !== 'boolean') reject('VALIDATION_FAILED', 'Question blocking must be explicit.'); }
    if (new Set(ids).size !== ids.length) reject('VALIDATION_FAILED', 'Duplicate workflow context IDs.');
  }
  if (!Array.isArray(value.feedback_progress) || !Array.isArray(value.correction_attempts)) reject('VALIDATION_FAILED', 'Invalid workflow progress.');
  const progressIds = new Set<string>();
  for (const progress of value.feedback_progress) {
    exact(progress, ['submission_id', 'comment_id', 'response_id'], 'feedback progress');
    for (const key of ['submission_id', 'comment_id']) { text(progress[key], key); recordId(progress[key]); }
    if (progress.response_id !== null) { text(progress.response_id, 'response ID'); recordId(progress.response_id); }
    const key = progress.submission_id + '/' + progress.comment_id;
    if (progressIds.has(key)) reject('VALIDATION_FAILED', 'Duplicate workflow feedback progress.');
    progressIds.add(key);
  }
  const attemptIds = new Set<string>();
  for (const attempt of value.correction_attempts) {
    exact(attempt, ['change_id', 'ordinary', 'escalation'], 'correction attempts'); text(attempt.change_id, 'change ID'); recordId(attempt.change_id);
    if (!Number.isSafeInteger(attempt.ordinary) || (attempt.ordinary as number) < 0 || (attempt.ordinary as number) > 2 || !Number.isSafeInteger(attempt.escalation) || (attempt.escalation as number) < 0 || (attempt.escalation as number) > 1) reject('VALIDATION_FAILED', 'Workflow correction budget exceeded.');
    if (attemptIds.has(attempt.change_id)) reject('VALIDATION_FAILED', 'Duplicate workflow correction budget.');
    attemptIds.add(attempt.change_id);
  }
  return value as unknown as WorkflowRecord;
}
export async function readWorkflow(inputRoot: string): Promise<WorkflowRecord> {
  const config = await readProjectConfig(inputRoot); const root = config.workspace_identity.canonical_root;
  const workflow = validateWorkflow(parseYaml(await readText(root, 'planning/workflow.yaml')));
  if (workflow.project_id !== config.project_id || workflow.version !== semanticHash(workflowBody(workflow))) reject('CONFLICT', 'Workflow identity/version does not match its durable body.');
  return workflow;
}
export async function writeWorkflow(inputRoot: string, input: WorkflowWriteRequest): Promise<WorkflowRecord> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'workflow write', async writer => {
    await checkBinding(root, input); const current = await readWorkflow(root);
    if (input.expected_version !== current.version || input.workflow.project_id !== input.project_id) reject('CONFLICT', 'Workflow version changed.');
    const proposed = validateWorkflow(input.workflow); const body = workflowBody(proposed);
    const saved = { ...body, version: semanticHash(body), updated_at: new Date().toISOString() };
    await writer.write('planning/workflow.yaml', stringify(saved)); return saved;
  });
}
