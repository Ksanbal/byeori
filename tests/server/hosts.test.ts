import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { HostCapability } from '../../src/contracts';
import { withWriteLock } from '../../src/core/ownership';
import { putRecord, same } from '../../src/core/record-io';
import { parseYaml } from '../../src/core/yaml';
import { browserSession, http, serverCase } from './helpers';

test('host observations are authenticated real records and advisory requires explicit human choice', async () => serverCase(async (root, _, handle) => {
  const url = handle.runtime.url!;
  assert.equal((await http(url, '/api/hosts')).status, 401);
  const session = await browserSession(url); const initial = (await session.get('/api/hosts')).result<HostCapability[]>();
  assert.equal(initial.ok, true); if (!initial.ok) throw new Error('Missing host result');
  assert.deepEqual(initial.data.map(host => [host.host, host.active, host.mode.type]), [['claude', false, 'enforced'], ['codex', false, 'enforced']]);
  for (const host of initial.data) await assert.rejects(() => readFile(path.join(root, 'planning/hosts', host.host + '.yaml')), { code: 'ENOENT' });
  assert.equal((await session.post('/api/advisory', {host: 'codex', reason: 'Synthetic explicitly accepted advisory limitation'})).status, 200);
  const current = (await session.get('/api/hosts')).result<HostCapability[]>(); assert.equal(current.ok, true);
  if (current.ok) { const codex = current.data.find(host => host.host === 'codex')!; assert.equal(codex.active, false); assert.deepEqual(codex.mode.type, 'advisory'); if (codex.mode.type === 'advisory') assert.equal(codex.mode.reason, 'Synthetic explicitly accepted advisory limitation'); }
  assert.equal((await http(url, '/api/hosts', 'GET', {...session.headers, Origin: 'https://example.invalid'})).status, 403);
}));

test('authenticated host refresh demotes fabricated active observations without losing human advisory', async () => serverCase(async (root, _, handle) => {
  const url = handle.runtime.url!; const session = await browserSession(url);
  const selected = (await session.post('/api/advisory', {host: 'codex', reason: 'Synthetic human accepts unverified current activation'})).result<HostCapability>();
  assert.equal(selected.ok, true);
  const initial = (await session.get('/api/hosts')).result<HostCapability[]>(); assert.equal(initial.ok, true);
  if (!initial.ok) throw new Error('Missing host result');
  await withWriteLock(root, 'synthetic stale host fixture', async writer => {
    for (const host of initial.data) await putRecord(writer, 'planning/hosts/' + host.host + '.yaml', {...host, host_version: 'synthetic-stale-version', active: true, configured: true, trusted: true, probed: {state: 'passed', checked_at: '2000-01-01T00:00:00.000Z', evidence: ['Synthetic fabricated cached observation; no native proof.']}}, false);
  });
  const hostPaths = initial.data.map(host => path.join(root, 'planning/hosts', host.host + '.yaml'));
  const previous = await Promise.all(hostPaths.map(file => readFile(file, 'utf8')));
  assert.equal((await http(url, '/api/hosts')).status, 401);
  assert.equal((await http(url, '/api/hosts', 'GET', {...session.headers, Origin: 'https://example.invalid'})).status, 403);
  assert.deepEqual(await Promise.all(hostPaths.map(file => readFile(file, 'utf8'))), previous);
  const reply = await session.get('/api/hosts'); assert.equal(reply.status, 200);
  const refreshed = reply.result<HostCapability[]>(); assert.equal(refreshed.ok, true);
  if (!refreshed.ok) throw new Error('Missing refreshed host result');
  for (const host of refreshed.data) {
    assert.equal(host.active, false); assert.equal(host.configured, false); assert.equal(host.trusted, null); assert.equal(host.probed.state, 'blocked');
    assert.notEqual(host.probed.checked_at, '2000-01-01T00:00:00.000Z');
    assert.equal(same(parseYaml(await readFile(path.join(root, 'planning/hosts', host.host + '.yaml'), 'utf8')), host), true);
  }
  const codex = refreshed.data.find(host => host.host === 'codex')!;
  assert.deepEqual(codex.mode, selected.ok ? selected.data.mode : null);
  assert.equal(codex.mode.type, 'advisory'); if (codex.mode.type === 'advisory') assert.equal(codex.mode.reason, 'Synthetic human accepts unverified current activation');
  const persisted = await Promise.all(hostPaths.map(file => readFile(file, 'utf8')));
  assert.equal((await session.get('/api/hosts')).status, 200);
  assert.deepEqual(await Promise.all(hostPaths.map(file => readFile(file, 'utf8'))), persisted);
}));
