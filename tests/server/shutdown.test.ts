import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { readOwnership } from '../../src/core/ownership';
import { observeStudioOperations } from '../../src/server/operation-observation';
import { readRuntime } from '../../src/server/runtime';
import { browserSession, serverCase } from './helpers';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test('a partial body completed after stopped is rejected without a durable write', { timeout: 15_000 }, async () => serverCase(async (root, _, handle) => {
  const url = handle.runtime.url!; const session = await browserSession(url);
  const raw = JSON.stringify({ host: 'codex', reason: 'Synthetic delayed body' });
  const host = path.join(root, 'planning/hosts/codex.yaml');
  const call = request({ hostname: '127.0.0.1', port: new URL(url).port, path: '/api/advisory', method: 'POST', headers: { ...session.headers, 'Content-Length': Buffer.byteLength(raw), Expect: '100-continue' } });
  const reply = new Promise<{ status: number; raw: string }>((resolve, rejectReply) => {
    call.once('error', rejectReply);
    call.once('response', response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', rejectReply);
      response.on('end', () => resolve({ status: response.statusCode!, raw: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  try {
    const continued = once(call, 'continue'); call.flushHeaders(); await continued; call.write(raw.slice(0, 1));
    await assert.rejects(() => readFile(host), { code: 'ENOENT' });
    const stopped = await handle.close(); assert.equal(stopped.ok, true);
    if (stopped.ok) assert.equal(stopped.data.state, 'stopped');
    assert.equal(await readRuntime(root), null);
    call.end(raw.slice(1)); const response = await reply;
    assert.equal(response.status, 503); assert.equal(JSON.parse(response.raw).ok, false);
    await assert.rejects(() => readFile(host), { code: 'ENOENT' });
  } finally { call.destroy(); }
}));

test('stop drains a genuine admitted Core mutation before fenced runtime cleanup', { timeout: 15_000 }, async () => serverCase(async (root, _, handle) => {
  const session = await browserSession(handle.runtime.url!);
  const admitted = barrier(); const proceed = barrier(); const completed = barrier(); const finish = barrier(); const quiescing = barrier();
  const detach = await observeStudioOperations(root, async event => {
    if (event.phase === 'quiescing') { quiescing.release(); return; }
    if (event.route !== '/api/advisory') return;
    if (event.phase === 'admitted') { admitted.release(); await proceed.wait; }
    else { completed.release(); await finish.wait; }
  });
  let stoppedReturned = false;
  const host = path.join(root, 'planning/hosts/codex.yaml');
  try {
    const mutation = session.post('/api/advisory', { host: 'codex', reason: 'Synthetic operation retained while stopping' });
    await admitted.wait;
    const stop = handle.close().then(value => { stoppedReturned = true; return value; });
    await quiescing.wait;
    assert.equal(stoppedReturned, false); assert.ok(await readRuntime(root));
    assert.equal(await readOwnership(root), null, 'stop must not hold the Core lock needed by the admitted mutation');
    await assert.rejects(() => readFile(host), { code: 'ENOENT' });
    proceed.release(); await completed.wait;
    const durable = await readFile(host, 'utf8'); assert.match(durable, /Synthetic operation retained while stopping/);
    assert.equal(stoppedReturned, false); assert.ok(await readRuntime(root));
    const refused = await session.post('/api/advisory', { host: 'codex', reason: 'Synthetic operation after admission closed' });
    assert.equal(refused.status, 503); assert.equal(await readFile(host, 'utf8'), durable);
    finish.release(); const response = await mutation;
    assert.equal(response.status, 200); assert.equal(response.result().ok, true);
    const stopped = await stop; assert.equal(stopped.ok, true);
    if (stopped.ok) assert.equal(stopped.data.state, 'stopped');
    assert.equal(await readRuntime(root), null); assert.equal(await readFile(host, 'utf8'), durable);
  } finally { proceed.release(); finish.release(); detach(); }
}));
