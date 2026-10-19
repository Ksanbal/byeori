import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { startViewer, type RunningViewer } from '../../src/viewer/server';
import { runViewer } from '../../src/viewer/entry';

async function setup(t: TestContext): Promise<{ root: string; assetsRoot: string; viewer: RunningViewer }> {
  const root = await mkdtemp(path.join(tmpdir(), 'byeori-viewer-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetsRoot = path.join(root, 'assets'); await mkdir(assetsRoot);
  await writeFile(path.join(assetsRoot, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="/app.js" defer></script></body></html>');
  await writeFile(path.join(assetsRoot, 'app.js'), 'console.log("viewer")'); await writeFile(path.join(assetsRoot, 'app.css'), 'body{color:black}');
  await mkdir(path.join(root, 'planning/source'), { recursive: true });
  await writeFile(path.join(root, 'planning/source/prd.yaml'), await readFile(new URL('../fixtures/planning/prd.yaml', import.meta.url)));
  const viewer = await startViewer({ root, assetsRoot, port: 0 });
  t.after(() => viewer.close());
  return { root, assetsRoot, viewer };
}
interface Response { status: number; headers: Record<string, string | string[] | undefined>; body: string }
async function get(viewer: RunningViewer, route = '/', method = 'GET', headers: Record<string, string | undefined> | string[] = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port: viewer.port, path: route, method, headers, agent: false }, response => {
      const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(parts).toString('utf8') }));
      response.on('error', reject);
    });
    call.on('error', reject); call.end();
  });
}

test('binds only IPv4 loopback and serves a source-only live catalog without changing workspace files', async t => {
  const { root, viewer } = await setup(t);
  const before = await readdir(root, { recursive: true });
  assert.equal(typeof viewer.server.address() === 'object' && (viewer.server.address() as { address: string }).address, '127.0.0.1');
  assert.equal(viewer.url, `http://127.0.0.1:${viewer.port}`);
  const response = await get(viewer, '/api/catalog');
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.mode, 'read-only'); assert.equal(result.provenance, 'source'); assert.equal(result.documents.length, 1);
  assert.equal(result.kinds.length, 9); assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  await writeFile(path.join(root, 'planning/source/actor.yaml'), await readFile(new URL('../fixtures/planning/actor.yaml', import.meta.url)));
  assert.equal(JSON.parse((await get(viewer, '/api/catalog')).body).documents.length, 2);
});

test('only exact bundled assets are served, with restrictive security headers and body-free HEAD responses', async t => {
  const { viewer } = await setup(t);
  for (const route of ['/', '/index.html', '/app.js', '/app.css', '/api/catalog']) {
    const response = await get(viewer, route);
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const head = await get(viewer, route, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.ok(Number(head.headers['content-length']) > 0);
  }
});

test('mutation methods and old workflow endpoints cannot write or approve anything', async t => {
  const { root, viewer } = await setup(t); const before = await readdir(root, { recursive: true });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    const response = await get(viewer, '/api/catalog', method);
    assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET, HEAD');
  }
  for (const route of ['/api/review', '/api/apply', '/api/trust', '/api/draft', '/api/approve', '/studio', '/api/catalog?root=/etc', '/api/catalog?path=../../etc/passwd']) assert.equal((await get(viewer, route)).status, 404);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});

test('DNS rebinding, foreign origins, null origins and cross-site requests are rejected before exposing documents', async t => {
  const { viewer } = await setup(t);
  for (const headers of [
    { Host: 'evil.example' }, { Host: `evil.example:${viewer.port}` }, { Host: '127.0.0.1:1' },
    { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `http://localhost:${viewer.port}` },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const response = await get(viewer, '/api/catalog', 'GET', headers);
    assert.equal(response.status, 403); assert.equal(response.body.includes('PRD-DEMO-001'), false);
  }
  const host = `127.0.0.1:${viewer.port}`;
  assert.equal((await get(viewer, '/api/catalog', 'GET', { Host: host, Origin: 'http://' + host, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await get(viewer, '/api/catalog', 'GET', ['Host', host, 'Host', host])).status, 403);
  assert.equal((await get(viewer, '/', 'GET', { Host: `localhost:${viewer.port}`, Origin: `http://localhost:${viewer.port}` })).status, 200);
});

test('filesystem routes, encoded traversal, absolute URLs and arbitrary asset names never expose files', async t => {
  const { root, assetsRoot, viewer } = await setup(t);
  await writeFile(path.join(root, 'secret.txt'), 'private marker'); await writeFile(path.join(assetsRoot, 'secret.txt'), 'private marker');
  for (const route of ['/../secret.txt', '/%2e%2e/secret.txt', '/%252e%252e/secret.txt', '/planning/source/prd.yaml', '/secret.txt', '/app.js.map', '/etc/passwd', '/app.js?file=secret.txt', '/api/document/PRD-DEMO-001']) {
    const response = await get(viewer, route); assert.equal(response.status, 404); assert.equal(response.body.includes('private marker'), false);
  }
  assert.equal((await get(viewer, 'http://evil.example/api/catalog')).status, 400);
  assert.equal((await get(viewer, '//evil.example/api/catalog')).status, 400);
});

test('markup stays data in JSON and never enters the static HTML response', async t => {
  const { root, viewer } = await setup(t);
  const file = path.join(root, 'planning/source/prd.yaml'); const raw = await readFile(file, 'utf8');
  await writeFile(file, raw.replace('title: 합성 상담 서비스', 'title: "<script>alert(1)</script>"'));
  const catalog = await get(viewer, '/api/catalog');
  assert.equal(JSON.parse(catalog.body).documents[0].title, '<script>alert(1)</script>');
  assert.equal((await get(viewer)).body.includes('alert(1)'), false);
});

test('rejects unsafe ports, missing assets, linked assets and invalid CLI flags', async t => {
  const { root, assetsRoot } = await setup(t);
  for (const port of [-1, 65536, 1.5, NaN]) await assert.rejects(startViewer({ root, assetsRoot, port }));
  await assert.rejects(startViewer({ root, assetsRoot: path.join(root, 'missing'), port: 0 }));
  await rm(path.join(assetsRoot, 'app.js')); await symlink(path.join(assetsRoot, 'app.css'), path.join(assetsRoot, 'app.js'));
  await assert.rejects(startViewer({ root, assetsRoot, port: 0 }));
  for (const argv of [[], ['--root'], ['--root', root, '--host', '0.0.0.0'], ['--root', root, '--port', '65536'], ['--root', root, '--port', '4317', '--port', '4317'], ['--root', root, '--approve', 'yes']]) await assert.rejects(runViewer(argv));
});

test('draft catalog is selectable only by bounded change ID and keeps source/draft responses distinct', async t => {
  const { root, viewer } = await setup(t);
  const { stringify } = await import('yaml');
  const { rawHash, VERSIONS } = await import('../../src/core/yaml');
  const raw = (await readFile(path.join(root, 'planning/source/prd.yaml'), 'utf8')).replace('합성 상담 서비스', 'DRAFT ONLY TITLE');
  const id = 'generated-change'; const directory = path.join(root, 'planning/changes', id);
  const hash = rawHash(raw); await mkdir(path.join(directory, 'draft'), { recursive: true });
  await writeFile(path.join(directory, 'draft', hash + '.yaml'), raw);
  await writeFile(path.join(directory, 'change.yaml'), stringify({ ...VERSIONS, project_id: 'test-project', workspace_fingerprint: 'a'.repeat(64), change_id: id, created_at: '2026-10-19T00:00:00Z', display_name: null, metadata: { type: 'spec_change', title: 'Generated documents', request: 'Browse', reason: 'Regression', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } } }));
  await writeFile(path.join(directory, 'draft-manifest.yaml'), stringify({ schema_version: 1, edits: [{ operation: 'put', object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', draft_file: `planning/changes/${id}/draft/${hash}.yaml`, raw_hash: hash }] }));
  const [source, draft] = await Promise.all([get(viewer, '/api/catalog'), get(viewer, '/api/catalog?change=' + id)]);
  assert.equal(source.status, 200); assert.equal(draft.status, 200);
  assert.equal(JSON.parse(source.body).provenance, 'source'); assert.equal(JSON.parse(source.body).documents[0].title, '합성 상담 서비스');
  assert.equal(JSON.parse(draft.body).provenance, 'draft'); assert.equal(JSON.parse(draft.body).documents[0].title, 'DRAFT ONLY TITLE');
  assert.equal(JSON.parse(draft.body).selected_source.change_id, id);
  assert.equal(JSON.parse(source.body).sources.length, 2);
  const head = await get(viewer, '/api/catalog?change=' + id, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, '');
  for (const route of ['/api/catalog?change=', '/api/catalog?change=missing', '/api/catalog?change=../secret', '/api/catalog?change=%2e%2e', '/api/catalog?change=' + 'a'.repeat(129), '/api/catalog?change=' + id + '&root=/etc', '/api/catalog?change=' + id + '&change=' + id, '/api/catalog?change=' + id + '#fragment']) {
    const response = await get(viewer, route); assert.equal(response.status, 404, route); assert.equal(response.body.includes('DRAFT ONLY TITLE'), false);
  }
  assert.equal((await get(viewer, '/api/catalog?change=' + id, 'POST')).status, 405);
  assert.equal((await get(viewer, '/api/catalog?change=' + id, 'GET', { Origin: 'https://foreign.invalid' })).status, 403);
});

test('concurrent catalog scopes and same-scope subscribers are bounded and recover after busy responses', async t => {
  const { root, viewer } = await setup(t);
  const raw = await readFile(path.join(root, 'planning/source/prd.yaml'), 'utf8');
  // Keep a catalog read pending long enough that the burst reaches the admission cap.
  for (let index = 0; index < 30; index++) await writeFile(path.join(root, 'planning/source', index + '.yaml'), raw.replace('PRD-DEMO-001', 'PRD-DEMO-' + index));
  const distinct = await Promise.all(Array.from({ length: 12 }, (_, index) => get(viewer, '/api/catalog?change=unknown-' + index)));
  assert.ok(distinct.some(response => response.status === 503));
  assert.ok(distinct.every(response => response.status === 404 || response.status === 503));
  const shared = await Promise.all(Array.from({ length: 12 }, () => get(viewer, '/api/catalog')));
  assert.ok(shared.some(response => response.status === 503));
  assert.ok(shared.some(response => response.status === 200));
  assert.equal((await get(viewer, '/api/catalog')).status, 200, 'admission slots are released after finish/close');
});
