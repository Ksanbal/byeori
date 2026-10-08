import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { HostCapability } from '../../src/contracts';
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
