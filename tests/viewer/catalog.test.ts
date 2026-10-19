import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { DOCUMENT_KINDS, type DocumentKind } from '../../src/contracts';
import { rawHash, VERSIONS } from '../../src/core/yaml';
import { createChange, currentBinding, initializeWorkspace, putDraft } from '../../src/core/workspace';
import { apply } from '../../src/core/apply';
import { cancelChange } from '../../src/core/review';
import { approvedScenario } from '../fixtures/approved-scenario';
import { loadCatalog, readViewerFile, VIEWER_LIMITS } from '../../src/viewer/catalog';

const fixtureRoot = new URL('../fixtures/planning/', import.meta.url);
async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'byeori-viewer-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root: string, name: string, raw: string | Buffer): Promise<void> {
  const file = path.join(root, 'planning/source', name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, raw);
}
async function fixture(name = 'prd.yaml'): Promise<string> { return readFile(new URL(name, fixtureRoot), 'utf8'); }

test('catalog shows all nine actual Core projections, raw YAML, explicit references and source-only provenance without initializing a project', async t => {
  const root = await workspace(t);
  for (const name of await readdir(fixtureRoot)) await put(root, name, await fixture(name));
  const before = await readdir(root, { recursive: true });
  const result = await loadCatalog(root);
  assert.equal(result.documents.length, 9);
  assert.deepEqual(result.kinds.map(item => item.kind), [...DOCUMENT_KINDS]);
  assert.ok(result.kinds.every(item => item.count === 1));
  assert.equal(result.mode, 'read-only'); assert.equal(result.provenance, 'source');
  assert.equal(result.workspace.name, path.basename(root));
  assert.equal(result.workspace.source_path, 'planning/source');
  assert.equal(result.issues.length, 0); assert.equal(result.truncated, false);
  assert.ok(result.documents.every(item => item.provenance === 'source' && item.raw_hash.length === 64 && item.semantic_hash.length === 64));
  assert.equal(result.documents.find(item => item.kind === 'prd')?.raw, await fixture());
  assert.ok(result.relations.length > 0 && result.relations.every(edge => edge.resolved));
  assert.ok(result.relations.some(edge => edge.type === 'screen' && edge.field.startsWith('nodes[')));
  assert.ok(result.relations.some(edge => edge.type === 'calls' && edge.field.includes('x-byeori-features')));
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  assert.equal(JSON.stringify(result).includes(root), false, 'absolute filesystem roots are not exposed');
});

test('missing source is an empty catalog; malformed files do not hide valid documents and unrelated files stay private', async t => {
  const root = await workspace(t);
  const empty = await loadCatalog(root);
  assert.deepEqual(empty.documents, []); assert.deepEqual(empty.issues, []); assert.equal(empty.kinds.length, 9);
  await put(root, 'good.yaml', await fixture());
  await put(root, 'bad.yaml', 'not_a_planning_document: true\n');
  await put(root, 'invalid-utf8.yaml', Buffer.from([0xff]));
  await put(root, 'unrelated.txt', 'Do not display this file');
  const result = await loadCatalog(root);
  assert.equal(result.documents.length, 1);
  assert.deepEqual(result.issues.map(item => item.code), ['INVALID_DOCUMENT', 'INVALID_DOCUMENT']);
  assert.equal(JSON.stringify(result).includes('Do not display this file'), false);
});

test('duplicate IDs and case/Unicode path collisions are omitted explicitly', async t => {
  const root = await workspace(t);
  await put(root, 'a.yaml', await fixture()); await put(root, 'b.yaml', await fixture());
  await put(root, 'X.yaml', await fixture()); await put(root, 'x.yaml', await fixture());
  const result = await loadCatalog(root);
  assert.equal(result.documents.length, 0);
  assert.equal(result.issues.filter(item => item.code === 'DUPLICATE_ID').length, 2);
  assert.equal(result.issues.filter(item => item.code === 'PATH_COLLISION').length, 2);
});

test('source-set reference problems are warnings while independently valid documents remain inspectable', async t => {
  const root = await workspace(t);
  await put(root, 'feature.yaml', await fixture('feature.yaml'));
  const result = await loadCatalog(root);
  assert.equal(result.documents.length, 1);
  assert.ok(result.issues.some(item => item.code === 'SOURCE_VALIDATION'));
  assert.ok(result.relations.some(edge => !edge.resolved));
});

test('file, directory, source-root and planning-ancestor symlinks never disclose their targets', async t => {
  const root = await workspace(t); const outside = await workspace(t);
  await put(outside, 'outside.yaml', (await fixture()).replace('합성 상담 서비스', 'OUTSIDE SECRET'));
  await mkdir(path.join(root, 'planning/source'), { recursive: true });
  await symlink(path.join(outside, 'planning/source/outside.yaml'), path.join(root, 'planning/source/link.yaml'));
  await symlink(path.join(outside, 'planning/source'), path.join(root, 'planning/source/linkdir'));
  let result = await loadCatalog(root);
  assert.equal(result.documents.length, 0); assert.equal(result.issues.length, 2);
  assert.equal(JSON.stringify(result).includes('OUTSIDE SECRET'), false);
  const sourceRoot = await workspace(t); await mkdir(path.join(sourceRoot, 'planning'));
  await symlink(path.join(outside, 'planning/source'), path.join(sourceRoot, 'planning/source'));
  result = await loadCatalog(sourceRoot); assert.equal(result.documents.length, 0); assert.equal(result.issues[0].code, 'PATH_SKIPPED');
  const ancestorRoot = await workspace(t); await symlink(path.join(outside, 'planning'), path.join(ancestorRoot, 'planning'));
  result = await loadCatalog(ancestorRoot); assert.equal(result.documents.length, 0); assert.equal(result.issues[0].code, 'PATH_SKIPPED');
});

test('per-file, document-count and traversal depth limits are enforced with visible incomplete warnings', async t => {
  const root = await workspace(t);
  await put(root, 'oversized.yaml', 'x'.repeat(1_048_577));
  let result = await loadCatalog(root);
  assert.equal(result.documents.length, 0); assert.equal(result.issues[0].code, 'DOCUMENT_TOO_LARGE');
  const counted = await workspace(t); const raw = await fixture();
  for (let index = 0; index <= VIEWER_LIMITS.documents; index++) await put(counted, String(index).padStart(4, '0') + '.yaml', raw.replace('PRD-DEMO-001', 'PRD-DEMO-' + index));
  result = await loadCatalog(counted);
  assert.equal(result.documents.length, VIEWER_LIMITS.documents); assert.equal(result.truncated, true); assert.ok(result.issues.some(item => item.code === 'LIMIT_REACHED'));
  const nested = await workspace(t); await put(nested, 'nested/'.repeat(VIEWER_LIMITS.depth + 1) + 'prd.yaml', raw);
  result = await loadCatalog(nested); assert.equal(result.documents.length, 0); assert.equal(result.truncated, true);
});

test('aggregate source-byte and directory-entry limits bound complete catalog work', async t => {
  const root = await workspace(t); const raw = await fixture();
  const large = raw.replace('purpose:', 'purpose: ' + 'x'.repeat(990_000) + '\n#');
  for (let index = 0; index < 9; index++) await put(root, index + '.yaml', large.replace('PRD-DEMO-001', 'PRD-DEMO-' + index));
  const result = await loadCatalog(root);
  assert.equal(result.truncated, true); assert.ok(result.issues.some(item => item.message.includes('byte limit')));
  const entries = await workspace(t); await mkdir(path.join(entries, 'planning/source'), { recursive: true });
  for (let index = 0; index <= VIEWER_LIMITS.entries; index++) await writeFile(path.join(entries, 'planning/source', index + '.txt'), '');
  const bounded = await loadCatalog(entries); assert.equal(bounded.truncated, true); assert.ok(bounded.issues.some(item => item.message.includes('entry limit')));
});

test('bounded reader rejects traversal, symlinks, directories and over-limit data', async t => {
  const root = await workspace(t); await writeFile(path.join(root, 'asset'), 'abcd');
  assert.equal((await readViewerFile(root, 'asset', 4)).toString(), 'abcd');
  for (const relative of ['../asset', '/asset', 'a/../asset', 'a%2fasset', 'a\\asset']) await assert.rejects(readViewerFile(root, relative));
  await assert.rejects(readViewerFile(root, 'asset', 3));
  await mkdir(path.join(root, 'directory')); await assert.rejects(readViewerFile(root, 'directory'));
  await symlink(path.join(root, 'asset'), path.join(root, 'link')); await assert.rejects(readViewerFile(root, 'link'));
});

test('external OpenAPI references are reported offline, never fetched or treated as approval', async t => {
  const root = await workspace(t);
  const raw = 'openapi: 3.1.1\ninfo: {title: Offline references, version: "1", x-byeori-id: API-OFFLINE-001}\ncomponents:\n  schemas:\n    Remote:\n      $ref: https://example.invalid/private.yaml\n';
  await put(root, 'api.yaml', raw);
  const result = await loadCatalog(root);
  assert.equal(result.documents.length, 1);
  assert.ok(result.issues.some(item => item.code === 'SOURCE_VALIDATION'));
  assert.equal(result.mode, 'read-only'); assert.equal(result.provenance, 'source');
  assert.equal(JSON.stringify(result).includes('"provenance":"approved"'), false);
});

test('oversized identities and relation expansion cannot amplify the response without bounds', async t => {
  const oversized = await workspace(t);
  await put(oversized, 'long-id.yaml', (await fixture()).replace('PRD-DEMO-001', 'PRD-' + 'A'.repeat(VIEWER_LIMITS.id_length)));
  const rejected = await loadCatalog(oversized);
  assert.equal(rejected.documents.length, 0); assert.equal(rejected.issues[0].code, 'IDENTITY_TOO_LONG');
  const root = await workspace(t);
  const raw = (await fixture()).replace('relations: []', 'relations:\n' + '- {type: related_to, target: PRD-DEMO-001}\n'.repeat(VIEWER_LIMITS.relations + 1));
  await put(root, 'many-links.yaml', raw);
  const bounded = await loadCatalog(root);
  assert.equal(bounded.documents.length, 1);
  assert.equal(bounded.documents[0].projection.relations.length, VIEWER_LIMITS.relations + 1);
  assert.equal(bounded.relations.length, VIEWER_LIMITS.relations);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.issues.some(item => item.message.includes('Relation display limit')));
  assert.ok(bounded.issues.every(item => item.message.length <= 600));
});

const metadata = { type: 'spec_change' as const, title: 'Generated planning', request: 'Browse generated documents', reason: 'Viewer regression', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } };
async function draft(root: string, id: string, documents: { id: string; kind: DocumentKind; path?: string; raw: string }[]): Promise<void> {
  const directory = path.join(root, 'planning/changes', id);
  await mkdir(path.join(directory, 'draft'), { recursive: true });
  const record = { ...VERSIONS, project_id: 'test-project', workspace_fingerprint: 'a'.repeat(64), change_id: id, created_at: '2026-10-19T00:00:00Z', display_name: null, metadata };
  await writeFile(path.join(directory, 'change.yaml'), stringify(record));
  const edits = [];
  for (const document of documents) {
    const checksum = rawHash(document.raw);
    await writeFile(path.join(directory, 'draft', checksum + '.yaml'), document.raw);
    edits.push({ operation: 'put', object_id: document.id, kind: document.kind, path: document.path ?? 'planning/source/' + document.id + '.yaml', draft_file: `planning/changes/${id}/draft/${checksum}.yaml`, raw_hash: checksum });
  }
  await writeFile(path.join(directory, 'draft-manifest.yaml'), stringify({ schema_version: 1, edits }));
}
async function snapshot(root: string): Promise<unknown[]> {
  const entries = ['', ...await readdir(root, { recursive: true })].sort();
  return Promise.all(entries.map(async relative => {
    const file = path.join(root, relative); const info = await stat(file);
    return { path: relative, size: info.size, mtime: info.mtimeMs, ino: info.ino, raw: info.isFile() ? (await readFile(file)).toString('base64') : null };
  }));
}

test('real draft-only generated project exposes all kinds, exact change version, and no viewer filesystem mutations', async t => {
  const root = await workspace(t); await initializeWorkspace(root, 'Generated draft project');
  const binding = await currentBinding(root);
  let change = await createChange(root, { ...binding, metadata });
  for (const name of await readdir(fixtureRoot)) {
    const raw = await fixture(name);
    const { parseDocument } = await import('../../src/core/documents');
    const document = parseDocument({ path: 'planning/source/' + name, raw });
    change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: document.id, kind: document.kind, path: document.path, raw })).change;
  }
  const before = await snapshot(root);
  const applied = await loadCatalog(root);
  assert.equal(applied.documents.length, 0);
  assert.deepEqual(applied.sources.map(source => source.kind), ['source', 'draft']);
  assert.equal(applied.sources[1].version, change.version);
  const result = await loadCatalog(root, change.change_id);
  assert.equal(result.documents.length, 9); assert.equal(result.invalid_documents.length, 0);
  assert.ok(result.kinds.every(kind => kind.count === 1));
  assert.equal(result.provenance, 'draft'); assert.equal(result.selected_source.change_id, change.change_id);
  assert.equal(result.selected_source.status, 'draft'); assert.equal(result.selected_source.version, change.version);
  assert.ok(result.documents.every(document => document.provenance === 'draft' && document.path.startsWith('planning/source/') && document.storage_path?.startsWith(`planning/changes/${change.change_id}/draft/`)));
  assert.ok(result.relations.every(relation => relation.resolved)); assert.equal(result.issues.length, 0);
  assert.equal(result.draft_edits.length, 9);
  assert.deepEqual(await snapshot(root), before, 'no content, directory, mtime, lock, cache, or workflow record changes');
});

test('selected draft is distinct from current source and retains unresolved references without overlay', async t => {
  const root = await workspace(t); const original = await fixture();
  await put(root, 'prd.yaml', original.replace('합성 상담 서비스', 'CURRENT SOURCE TITLE'));
  await put(root, 'actor.yaml', await fixture('actor.yaml'));
  await draft(root, 'draft-one', [{ id: 'PRD-DEMO-001', kind: 'prd', raw: original }, { id: 'FEAT-MESSAGE-001', kind: 'feature', raw: (await fixture('feature.yaml')).replace('FEAT-MSG-001', 'FEAT-MESSAGE-001') }]);
  const source = await loadCatalog(root); const selected = await loadCatalog(root, 'draft-one');
  assert.equal(source.documents.find(document => document.kind === 'prd')?.title, 'CURRENT SOURCE TITLE');
  assert.equal(selected.documents.find(document => document.kind === 'prd')?.raw, original);
  assert.ok(selected.documents.every(document => document.provenance === 'draft'));
  assert.ok(selected.relations.some(relation => !relation.resolved), 'source actors are not silently imported into draft set');
  assert.ok(selected.issues.some(issue => issue.code === 'DRAFT_SET_VALIDATION'));
  assert.equal(selected.documents.some(document => document.kind === 'actor'), false);
});

test('invalid persisted draft YAML, identity mismatch and corrupted chunks remain visible as raw-only documents', async t => {
  const root = await workspace(t); const raw = await fixture();
  await draft(root, 'invalid-drafts', [
    { id: 'PRD-INVALID-001', kind: 'prd', raw: 'not_a_planning_document: true\n' },
    { id: 'PRD-MISMATCH-001', kind: 'prd', raw },
    { id: 'PRD-CORRUPT-001', kind: 'prd', raw: raw.replace('PRD-DEMO-001', 'PRD-CORRUPT-001') },
  ]);
  const corrupted = raw.replace('PRD-DEMO-001', 'PRD-CORRUPT-001');
  await writeFile(path.join(root, 'planning/changes/invalid-drafts/draft', rawHash(corrupted) + '.yaml'), corrupted + '# changed after save\n');
  const result = await loadCatalog(root, 'invalid-drafts');
  assert.equal(result.documents.length, 0); assert.equal(result.invalid_documents.length, 3);
  assert.equal(result.kinds.find(kind => kind.kind === 'prd')?.count, 3);
  assert.ok(result.invalid_documents.every(document => document.raw && document.provenance === 'draft' && document.issues.length === 1));
  assert.ok(result.invalid_documents.some(document => document.issues[0].message.includes('manifest hash')));
  assert.equal(result.relations.length, 0);
});

test('historical applied and cancelled records remain browseable without asserting approval or changing active state', async t => {
  const root = await workspace(t); await initializeWorkspace(root);
  const applied = await approvedScenario(root); await apply(root, { project_id: applied.binding.project_id, workspace_fingerprint: applied.binding.workspace_fingerprint, change_id: applied.change.change_id, round: applied.round.manifest.round, manifest_hash: applied.round.manifest_hash });
  const binding = await currentBinding(root); const cancelled = await createChange(root, { ...binding, metadata });
  await cancelChange(root, { ...binding, change_id: cancelled.change_id, expected_version: cancelled.version, reason: 'Superseded' });
  const active = await createChange(root, { ...binding, metadata });
  const before = await snapshot(root); const result = await loadCatalog(root);
  assert.equal(result.sources.find(source => source.change_id === applied.change.change_id)?.status, 'applied-recorded');
  assert.equal(result.sources.find(source => source.change_id === cancelled.change_id)?.status, 'cancelled-recorded');
  assert.equal(result.sources.find(source => source.change_id === active.change_id)?.status, 'draft');
  const historical = await loadCatalog(root, applied.change.change_id);
  assert.equal(historical.documents.length, 2); assert.equal(historical.provenance, 'draft');
  assert.equal(historical.selected_source.status, 'applied-recorded');
  assert.equal(JSON.stringify(historical).includes('"provenance":"approved"'), false);
  assert.deepEqual(await snapshot(root), before);
});

test('move and delete draft intents remain explicit without fabricating documents from current source', async t => {
  const root = await workspace(t); await put(root, 'prd.yaml', await fixture());
  await draft(root, 'intents', []);
  await writeFile(path.join(root, 'planning/changes/intents/draft-manifest.yaml'), stringify({ schema_version: 1, edits: [
    { operation: 'move', object_id: 'PRD-DEMO-001', path: 'planning/source/new-location.yaml' },
    { operation: 'delete', object_id: 'ACT-WORKER-001' },
  ] }));
  const result = await loadCatalog(root, 'intents');
  assert.deepEqual(result.documents, []);
  assert.deepEqual(result.draft_edits, [
    { operation: 'move', object_id: 'PRD-DEMO-001', kind: null, path: 'planning/source/new-location.yaml', storage_path: null },
    { operation: 'delete', object_id: 'ACT-WORKER-001', kind: null, path: null, storage_path: null },
  ]);
});

test('draft target collisions preserve raw evidence and exclude ambiguous projections', async t => {
  const root = await workspace(t); const raw = await fixture();
  await draft(root, 'collision', [
    { id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/Title.yaml', raw },
    { id: 'PRD-OTHER-001', kind: 'prd', path: 'planning/source/title.yaml', raw: raw.replace('PRD-DEMO-001', 'PRD-OTHER-001') },
  ]);
  const result = await loadCatalog(root, 'collision');
  assert.equal(result.documents.length, 0); assert.equal(result.invalid_documents.length, 2);
  assert.ok(result.invalid_documents.every(document => document.issues[0].code === 'PATH_COLLISION'));
});

test('draft paths are manifest-bound and symlinked metadata or chunks never disclose other files', async t => {
  const root = await workspace(t); const outside = await workspace(t); const raw = await fixture();
  await writeFile(path.join(outside, 'secret.yaml'), 'OUTSIDE PRIVATE MARKER');
  await draft(root, 'linked', [{ id: 'PRD-DEMO-001', kind: 'prd', raw }]);
  const chunk = path.join(root, 'planning/changes/linked/draft', rawHash(raw) + '.yaml');
  await rm(chunk); await symlink(path.join(outside, 'secret.yaml'), chunk);
  let result = await loadCatalog(root, 'linked');
  assert.equal(result.documents.length, 0); assert.equal(result.invalid_documents.length, 0);
  assert.ok(result.issues.some(issue => issue.code === 'PATH_SKIPPED'));
  assert.equal(JSON.stringify(result).includes('OUTSIDE PRIVATE MARKER'), false);
  await draft(root, 'traversal', []);
  await writeFile(path.join(root, 'planning/changes/traversal/draft-manifest.yaml'), stringify({ schema_version: 1, edits: [{ operation: 'put', object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', draft_file: '../secret.yaml', raw_hash: rawHash(raw) }] }));
  result = await loadCatalog(root, 'traversal');
  assert.equal(result.selected_source.status, 'invalid'); assert.ok(result.issues.some(issue => issue.code === 'INVALID_CHANGE'));
  for (const id of ['../linked', 'linked/../linked', 'linked%2f', '/linked', 'a'.repeat(129)]) await assert.rejects(loadCatalog(root, id));
  await assert.rejects(loadCatalog(root, 'missing'));
});

test('change discovery bounds options and oversized draft manifests without unbounded traversal', async t => {
  const root = await workspace(t);
  for (let index = 0; index <= VIEWER_LIMITS.changes; index++) await draft(root, 'change-' + String(index).padStart(3, '0'), []);
  const result = await loadCatalog(root);
  assert.equal(result.sources.length, VIEWER_LIMITS.changes + 1); assert.equal(result.truncated, true);
  assert.ok(result.issues.some(issue => issue.code === 'LIMIT_REACHED' && issue.message.includes('Change-set')));
  const large = await workspace(t); await draft(large, 'oversized', []);
  await writeFile(path.join(large, 'planning/changes/oversized/draft-manifest.yaml'), stringify({ schema_version: 1, edits: Array.from({ length: VIEWER_LIMITS.documents + 1 }, (_, index) => ({ operation: 'delete', object_id: 'PRD-DELETE-' + index })) }));
  const rejected = await loadCatalog(large, 'oversized');
  assert.equal(rejected.selected_source.status, 'invalid'); assert.equal(rejected.documents.length, 0);
  assert.ok(rejected.issues.some(issue => issue.code === 'INVALID_CHANGE'));
});
