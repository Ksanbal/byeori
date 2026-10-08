import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import cases from '../fixtures/search-cases.json';
import { initializeWorkspace, currentBinding, createChange, putDraft, deleteDraft } from '../../src/core/workspace';
import { prepareReview, roundBinding, saveReviewDraft, submitReview } from '../../src/core/review';
import { apply } from '../../src/core/apply';
import { get } from '../../src/core/state';
import { withWriteLock } from '../../src/core/ownership';
import { impact, rebuildIndex, search } from '../../src/core/search';
import { parseDocument } from '../../src/core/documents';
import type { ChangeMetadata, ReviewRound } from '../../src/contracts';

const metadata: ChangeMetadata = { type: 'spec_change', title: 'Synthetic search', request: 'Search test', reason: 'Synthetic only', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } };
async function approve(root: string, round: ReviewRound) {
  const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } };
  const draft = await saveReviewDraft(root, { ...body, expected_version: null });
  await submitReview(root, { ...body, schema_version: 1, submission_id: 'synthetic-' + round.manifest.change_id, expected_feedback_version: draft.version, final_confirmation: true });
  await apply(root, roundBinding(round));
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori-search-')); await initializeWorkspace(root);
  const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata });
  for (const name of ['prd', 'actor', 'scenario', 'feature', 'ia', 'screen', 'entity', 'openapi', 'architecture']) {
    const raw = await readFile(new URL('../fixtures/planning/' + name + '.yaml', import.meta.url), 'utf8'); const document = parseDocument({ path: 'planning/source/' + name + '.yaml', raw });
    change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: document.id, kind: document.kind, path: document.path, raw })).change;
  }
  const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); await approve(root, round); return root;
}
test('actual pinned SQLite FTS5 create/insert/query and extension disabled', () => {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try { db.exec('CREATE VIRTUAL TABLE probe USING fts5(body);'); db.prepare('INSERT INTO probe VALUES (?)').run('상담 sendMessage'); assert.equal(db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?').get('"상담"')?.n, 1); assert.throws(() => db.loadExtension('missing')); } finally { db.close(); }
});
test('exact 40-case benchmark, heldout ranking and hostile raw queries', async () => {
  const root = await fixture();
  try {
    let recalled = 0; let negativeEmpty = 0; const measured = [];
    assert.equal(cases.cases.length, 40);
    for (const item of cases.cases) {
      const result = await search(root, { query: item.engine_query ?? item.user_query }); const ids = result.hits.map(hit => hit.id);
      if (item.type === 'positive') { if (item.expected_ids?.every(id => ids.includes(id))) recalled++; }
      else { assert.deepEqual(ids, []); negativeEmpty++; }
      measured.push({ id: item.id, ids, expected_behavior: item.expected_behavior ?? null });
    }
    console.log(JSON.stringify({ benchmark: 'exact40', engine_recall_at_5: recalled / 32, positive_hits: recalled, positives: 32, negative_empty: negativeEmpty, negatives: 8, user_expansion_measured: false, cases: measured }));
    assert.ok(recalled / 32 >= 0.9);
    for (const [query, expected, reason] of [['FEAT-MSG-001', 'FEAT-MSG-001', 'id_exact'], ['담당 직원', 'ACT-WORKER-001', 'title_exact'], ['sendMessage', 'API-MSG-001', 'fts'], ['message.read', 'ACT-WORKER-001', 'fts']] as const) { const result = await search(root, { query }); assert.equal(result.hits[0]?.id, expected); if (query !== 'message.read') assert.equal(result.hits[0]?.match_reason, reason); }
    for (const query of ['" OR *', "'; DROP TABLE objects; --", 'NEAR(a b)', 'title:foo', '"', '*', '']) await search(root, { query });
    await assert.rejects(search(root, { query: 'x', limit: 26 })); await assert.rejects(search(root, { query: 'x'.repeat(1025) }));
    assert.equal((await search(root, { query: '메시지', kinds: ['openapi'] })).hits.every(hit => hit.kind === 'openapi'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cache rebuild, draft drift, relationship/deletion freshness and immutable history', async () => {
  const root = await fixture();
  try {
    const first = await rebuildIndex(root); await rm(path.join(root, '.byeori/index.sqlite')); assert.deepEqual(await rebuildIndex(root), first);
    const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata });
    const original = await readFile(path.join(root, 'planning/source/architecture.yaml'), 'utf8');
    let raw = original.replace('상담 시스템 구조', '새 구조').replace('  target: FEAT-MSG-001', '  target: PRD-DEMO-001');
    change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'ARCH-DEMO-001', kind: 'architecture', path: 'planning/source/architecture.yaml', raw })).change;
    const scope = { type: 'change' as const, change_id: change.change_id }; const before = await rebuildIndex(root, scope);
    assert.equal((await search(root, { query: '새 구조', scope })).hits[0]?.id, 'ARCH-DEMO-001'); assert.deepEqual((await search(root, { query: '새 구조' })).hits, []);
    raw = raw.replace('새 구조', '다음 구조'); change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'ARCH-DEMO-001', kind: 'architecture', path: 'planning/source/architecture.yaml', raw })).change;
    assert.notEqual((await rebuildIndex(root, scope)).source_hash, before.source_hash); assert.deepEqual((await search(root, { query: '새 구조', scope })).hits, []);
    assert.ok((await impact(root, { object_id: 'PRD-DEMO-001', scope })).relations.some(edge => edge.direction === 'inverse' && edge.from === 'ARCH-DEMO-001'));
    change = await deleteDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: 'ARCH-DEMO-001' }); assert.deepEqual((await search(root, { query: 'ARCH-DEMO-001', scope })).hits, []);
    const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); await approve(root, round);
    assert.deepEqual((await search(root, { query: 'ARCH-DEMO-001' })).hits, []);
    const historical = await search(root, { query: 'ARCH-DEMO-001', scope: { type: 'history', change_id: change.change_id, round: 1 } }); assert.equal(historical.hits[0]?.revision.side, 'before');
    assert.equal((await get(root, { object_id: 'ARCH-DEMO-001', revision: historical.hits[0].revision })).projection.title, '상담 시스템 구조');
    await rm(path.join(root, '.byeori/index.sqlite')); assert.equal((await search(root, { query: 'ARCH-DEMO-001', scope: { type: 'history' } })).hits.length, 2);
    const prd = path.join(root, 'planning/source/prd.yaml'); const saved = await readFile(prd, 'utf8');
    await writeFile(prd, saved.replace('합성 상담 서비스', '미승인 변경')); await assert.rejects(search(root, { query: '기획' }), /differs from durable applied history/);
    await rm(prd); await assert.rejects(search(root, { query: '기획' })); await writeFile(prd, saved);
    await writeFile(prd, 'broken: true'); await assert.rejects(search(root, { query: '기획' })); await assert.rejects(rebuildIndex(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('bounded owned/inverse impact and source/cache/sidecar symlink denial', async () => {
  const root = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), 'byeori-outside-'));
  try {
    const result = await impact(root, { object_id: 'FEAT-MSG-001', depth: 1 }); assert.ok(result.relations.some(edge => edge.direction === 'owned')); assert.ok(result.relations.some(edge => edge.direction === 'inverse')); assert.equal(result.coverage.code_impact, 'not_investigated');
    assert.equal((await impact(root, { object_id: 'FEAT-MSG-001', limit: 1 })).coverage.truncated, true);
    await assert.rejects(impact(root, { object_id: 'FEAT-MSG-001', depth: 6 }));
    await withWriteLock(root, 'test retained search ownership', async () => { await assert.rejects(rebuildIndex(root), /ownership/); });
    await rebuildIndex(root);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const target = path.join(root, '.byeori/index.sqlite' + suffix); await rm(target, { force: true }); const external = path.join(outside, 'cache' + suffix); await writeFile(external, 'external-bytes'); await symlink(external, target); await assert.rejects(search(root, { query: '기획' })); assert.equal(await readFile(external, 'utf8'), 'external-bytes'); await rm(target);
    }
    await rm(path.join(root, '.byeori'), { recursive: true }); await symlink(outside, path.join(root, '.byeori')); await assert.rejects(search(root, { query: '기획' })); await rm(path.join(root, '.byeori'));
    const source = path.join(root, 'planning/source/prd.yaml'); await rm(source); await symlink(path.join(outside, 'cache'), source); await assert.rejects(search(root, { query: '기획' }));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
