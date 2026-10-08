import { DatabaseSync } from 'node:sqlite';
import type { ImpactRequest, ImpactResult, IndexResult, QueryScope, Revision, SearchHit, SearchRequest, SearchResult } from '../../contracts';
import { DOCUMENT_KINDS } from '../../contracts';
import { readTransaction } from '../apply';
import { type ParsedDocument, validateSource } from '../documents';
import { reject } from '../errors';
import { withWriteLock } from '../ownership';
import { ensureDirectory, recordId, safePath } from '../paths';
import { recordFiles } from '../record-io';
import { readRound, roundDocuments, roundNumbers, sourceHead } from '../review';
import { loadProjectedChange, loadRawSource, workspaceIdentity } from '../workspace';
import { semanticHash } from '../yaml';

export const INDEXER_VERSION = '1';
interface Entry { document: ParsedDocument; revision: Revision }
function queryScope(scope: QueryScope = { type: 'approved' }): QueryScope {
  if (!scope || !['approved', 'change', 'history'].includes(scope.type)) reject('VALIDATION_FAILED', 'Invalid search scope.');
  if (scope.type === 'change') recordId(scope.change_id);
  if (scope.type === 'history') { if (scope.change_id !== undefined) recordId(scope.change_id); if (scope.round !== undefined && (!scope.change_id || !Number.isSafeInteger(scope.round) || scope.round < 1)) reject('VALIDATION_FAILED', 'Historical round requires a change ID and positive round.'); }
  return scope;
}
function bounded(value: number | undefined, fallback: number, maximum: number): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1 || result > maximum) reject('VALIDATION_FAILED', 'Query bound is outside supported limits.'); return result; }
async function entries(root: string, scope: QueryScope): Promise<Entry[]> {
  const head = await sourceHead(root);
  if (head.applied) { const { transaction } = await readTransaction(root, head.applied.change_id); if (transaction.phase !== 'completed' || transaction.transaction_id !== head.applied.transaction_id) reject('APPLY_RECOVERY_REQUIRED', 'Search requires normally completed apply.'); }
  if (scope.type === 'approved') return validateSource(await loadRawSource(root)).map(document => ({ document, revision: { change_id: head.change_id, round: head.round?.manifest.round ?? null, manifest_hash: head.hash, side: 'source' } }));
  if (scope.type === 'change') return (await loadProjectedChange(root, scope.change_id)).map(document => ({ document, revision: { change_id: scope.change_id, round: null, manifest_hash: document.content_hash, side: 'source' } }));
  const result: Entry[] = [];
  for (const file of await recordFiles(root, 'change.yaml')) {
    const id = file.slice('planning/changes/'.length).split('/')[0]; if (scope.change_id && scope.change_id !== id) continue;
    for (const number of await roundNumbers(root, id)) {
      if (scope.round && scope.round !== number) continue;
      const round = await readRound(root, id, number);
      for (const side of ['before', 'after'] as const) for (const document of await roundDocuments(root, round, side)) result.push({ document, revision: { change_id: id, round: number, manifest_hash: round.manifest_hash, side } });
    }
  }
  return result;
}
async function database(root: string): Promise<DatabaseSync> {
  await ensureDirectory(root, '.byeori');
  for (const suffix of ['', '-journal', '-wal', '-shm']) await safePath(root, '.byeori/index.sqlite' + suffix);
  const db = new DatabaseSync(await safePath(root, '.byeori/index.sqlite'), { allowExtension: false });
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;');
  return db;
}
function populate(db: DatabaseSync, rows: Entry[], scope: QueryScope): string {
  const hash = semanticHash({ indexer_version: INDEXER_VERSION, scope, entries: rows.map(({ document, revision }) => ({ path: document.path, content_hash: document.content_hash, revision })) });
  db.exec('CREATE TABLE IF NOT EXISTS freshness (hash TEXT);');
  if (db.prepare('SELECT hash FROM freshness').get()?.hash === hash) return hash;
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('DROP TABLE IF EXISTS objects; DROP TABLE IF EXISTS relations; DROP TABLE IF EXISTS revisions; CREATE VIRTUAL TABLE objects USING fts5(id, title, aliases, body, tokenize=unicode61); CREATE TABLE relations (entry INTEGER, target TEXT, type TEXT); CREATE TABLE revisions (entry INTEGER PRIMARY KEY, revision TEXT); DELETE FROM freshness;');
    const insert = db.prepare('INSERT INTO objects(rowid,id,title,aliases,body) VALUES (?,?,?,?,?)'); const relation = db.prepare('INSERT INTO relations VALUES (?,?,?)'); const revision = db.prepare('INSERT INTO revisions VALUES (?,?)');
    rows.forEach(({ document, revision: value }, index) => { insert.run(index + 1, document.id, document.projection.title, document.projection.aliases.join(' '), JSON.stringify(document.content)); revision.run(index + 1, JSON.stringify(value)); for (const edge of document.projection.relations) relation.run(index + 1, edge.target, edge.type); });
    db.prepare('INSERT INTO freshness VALUES (?)').run(hash); db.exec('COMMIT;');
  } catch (error) { db.exec('ROLLBACK;'); throw error; }
  return hash;
}
async function indexed<T>(inputRoot: string, scope: QueryScope, action: (db: DatabaseSync, rows: Entry[], hash: string) => T, rebuild = false): Promise<T> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'search index', async () => { const rows = await entries(root, scope); const db = await database(root); try { if (rebuild) db.exec('DROP TABLE IF EXISTS freshness;'); const hash = populate(db, rows, scope); return action(db, rows, hash); } finally { db.close(); } });
}
export async function rebuildIndex(root: string, scope: QueryScope = { type: 'approved' }): Promise<IndexResult> {
  scope = queryScope(scope); return indexed(root, scope, (_db, rows, hash) => ({ indexed_objects: rows.length, source_hash: hash, indexer_version: INDEXER_VERSION, scope }), true);
}
export async function search(root: string, input: SearchRequest): Promise<SearchResult> {
  const scope = queryScope(input.scope); const limit = bounded(input.limit, 5, 25);
  if (typeof input.query !== 'string' || input.query.length > 1024 || input.query.includes('\0')) reject('VALIDATION_FAILED', 'Search query must be at most 1024 characters without NUL.');
  if (input.kinds && (!Array.isArray(input.kinds) || input.kinds.some(kind => !DOCUMENT_KINDS.includes(kind)))) reject('VALIDATION_FAILED', 'Unknown search kind.');
  const query = input.query.trim().normalize('NFC').toLowerCase(); const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
  return indexed(root, scope, (db, rows) => {
    const fts = new Map<number, number>();
    if (tokens.length) for (const row of db.prepare('SELECT rowid, bm25(objects,10,8,6,1) AS score FROM objects WHERE objects MATCH ?').all(tokens.map(token => '"' + token + '"').join(' AND '))) fts.set(Number(row.rowid), Number(row.score));
    const ranked: { hit: SearchHit; priority: number }[] = [];
    rows.forEach(({ document, revision }, index) => {
      if (!query || !tokens.length || (input.kinds && !input.kinds.includes(document.kind))) return;
      let reason: SearchHit['match_reason']; let score: number; let priority: number;
      if (document.id.toLowerCase() === query) { reason = 'id_exact'; score = 3; priority = 0; }
      else if (document.projection.title.normalize('NFC').toLowerCase() === query) { reason = 'title_exact'; score = 2; priority = 1; }
      else if (document.projection.aliases.some(alias => alias.normalize('NFC').toLowerCase() === query)) { reason = 'alias_exact'; score = 1; priority = 2; }
      else if (fts.has(index + 1)) { reason = 'fts'; score = fts.get(index + 1)!; priority = 3; }
      else if (query.length >= 3 && [document.projection.title, ...document.projection.aliases, document.projection.summary].some(text => text.normalize('NFC').toLowerCase().includes(query))) { reason = 'substring'; score = query.length; priority = 4; }
      else return;
      ranked.push({ priority, hit: { id: document.id, kind: document.kind, title: document.projection.title, excerpt: document.projection.summary.slice(0, 240), path: document.path, revision, match_reason: reason, score, score_meaning: reason === 'fts' ? 'bm25_rank' : reason === 'substring' ? 'substring_rank' : 'exact_priority' } });
    });
    ranked.sort((a, b) => a.priority - b.priority || (a.priority === 3 ? a.hit.score - b.hit.score : b.hit.score - a.hit.score) || a.hit.id.localeCompare(b.hit.id));
    return { scope, hits: ranked.slice(0, limit).map(row => row.hit), score_is_probability: false, truncated: ranked.length > limit };
  });
}
export async function impact(root: string, input: ImpactRequest): Promise<ImpactResult> {
  const scope = queryScope(input.scope); const depth = bounded(input.depth, 1, 5); const limit = bounded(input.limit, 25, 100);
  if (scope.type === 'history') reject('VALIDATION_FAILED', 'Impact requires a current approved or projected graph.');
  return indexed(root, scope, (_db, rows) => {
    const documents = new Map(rows.map(row => [row.document.id, row.document])); if (!documents.has(input.object_id)) reject('VALIDATION_FAILED', 'Impact object is absent.');
    const visited = new Set([input.object_id]); let frontier = [input.object_id]; let truncated = false; let explored = 0; const relations: ImpactResult['relations'] = [];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: string[] = []; explored = level + 1;
      for (const id of frontier) for (const document of documents.values()) for (const edge of document.projection.relations) {
        if (document.id !== id && edge.target !== id) continue;
        const target = document.id === id ? edge.target : document.id;
        if (!visited.has(target)) { if (visited.size >= limit) { truncated = true; continue; } visited.add(target); next.push(target); }
        const relation = { from: document.id, to: edge.target, type: edge.type, direction: document.id === id ? 'owned' as const : 'inverse' as const };
        if (!relations.some(existing => existing.from === relation.from && existing.to === relation.to && existing.type === relation.type)) relations.push(relation);
      }
      frontier = next;
    }
    if (frontier.some(id => [...documents.values()].some(document => document.projection.relations.some(edge => (document.id === id && !visited.has(edge.target)) || (edge.target === id && !visited.has(document.id)))))) truncated = true;
    return { objects: [...visited].map(id => { const document = documents.get(id)!; return { id, kind: document.kind, title: document.projection.title }; }), relations, coverage: { depth: explored, visited: visited.size, truncated, code_impact: 'not_investigated' } };
  });
}
