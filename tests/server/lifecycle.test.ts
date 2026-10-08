import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { build } from 'vite';
import type { Result, StudioRuntime } from '../../src/contracts';
import { CoreError } from '../../src/core/errors';
import { startStudio, createStudioLifecycle, inspectStudio, stopOwnedStudio } from '../../src/server';
import { readRuntime, RUNTIME_PATH } from '../../src/server/runtime';
import { browserSession, http, workspace } from './helpers';

test('actual child start/status/stop survives cache deletion and refuses uncertain/wrong owners without signalling', { timeout: 15_000 }, async () => {
  const fixture = await workspace(); const child = fork(fileURLToPath(new URL('../../src/server/worker.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); const exited = once(child, 'exit'); let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  try {
    child.send({ root: fixture.root, options: { assetsRoot: fixture.assets } });
    const [ready] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Studio child exited before ready: ' + errors); })]);
    const response = ready as Result<StudioRuntime>; assert.equal(response.ok, true); if (!response.ok) throw new Error('No runtime');
    assert.equal(response.data.pid, child.pid); assert.equal(response.data.url?.includes('?'), false); const record = (await readRuntime(fixture.root))!;
    assert.equal((await lstat(path.join(fixture.root, RUNTIME_PATH))).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(response).includes(record.management_secret), false);
    await mkdir(path.join(fixture.root, '.byeori')); await writeFile(path.join(fixture.root, '.byeori/disposable'), 'cache'); await rm(path.join(fixture.root, '.byeori'), { recursive: true });
    assert.equal((await inspectStudio(fixture.root)).pid, child.pid); const session = await browserSession(response.data.url!);
    assert.equal((await session.get('/api/state')).status, 200);
    await assert.rejects(() => stopOwnedStudio(fixture.root, 'wrong-handle'), error => error instanceof CoreError && error.diagnostics[0].code === 'CONFLICT');
    assert.equal((await inspectStudio(fixture.root)).pid, child.pid);
    const altered = { ...record, owner: { ...record.owner, process: { ...record.owner.process, start_identity: 'uncertain' } } };
    await writeFile(path.join(fixture.root, RUNTIME_PATH), stringify(altered));
    await assert.rejects(() => stopOwnedStudio(fixture.root), error => error instanceof CoreError && error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED');
    assert.equal(child.exitCode, null); assert.equal(await readFile(path.join(fixture.root, RUNTIME_PATH), 'utf8'), stringify(altered));
    await writeFile(path.join(fixture.root, RUNTIME_PATH), stringify(record));
    assert.equal((await stopOwnedStudio(fixture.root)).state, 'stopped'); assert.equal((await exited)[0], 0); assert.equal((await inspectStudio(fixture.root)).state, 'stopped');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await fixture.cleanup(); }
});

test('loopback port conflict leaves occupied listener and runtime untouched; real lifecycle restarts safely', async () => {
  const fixture = await workspace(); const occupied = createServer((_, response) => response.end('existing'));
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve)); const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(() => startStudio(fixture.root, { assetsRoot: fixture.assets, port: address.port }), error => error instanceof CoreError && error.diagnostics[0].code === 'CONFLICT');
    assert.equal(await readRuntime(fixture.root), null); assert.equal((await http('http://127.0.0.1:' + address.port, '/')).raw, 'existing');
    const lifecycle = createStudioLifecycle(fixture.root, { assetsRoot: fixture.assets });
    assert.equal((await lifecycle({ action: 'status' })).ok, true); const first = await lifecycle({ action: 'start' }); assert.equal(first.ok, true);
    assert.deepEqual(await lifecycle({ action: 'start' }), await lifecycle({ action: 'status' }));
    const stopped = await lifecycle({ action: 'stop' }); assert.equal(stopped.ok, true); if (stopped.ok) assert.equal(stopped.data.state, 'stopped');
    const next = await lifecycle({ action: 'start' }); assert.equal(next.ok, true); assert.equal((await lifecycle({ action: 'stop' })).ok, true);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); await fixture.cleanup(); }
});

test('actual freshly built Vite output is served by the same protected HTTP transport', async () => {
  const fixture = await workspace(); let handle: Awaited<ReturnType<typeof startStudio>> | null = null;
  try {
    await build({ logLevel: 'silent', build: { outDir: fixture.assets, emptyOutDir: true } });
    handle = await startStudio(fixture.root, { assetsRoot: fixture.assets }); const session = await browserSession(handle.runtime.url!);
    const page = await http(handle.runtime.url!, '/', 'GET', { Cookie: session.cookie, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin' });
    const script = page.raw.match(/src="(\/assets\/[^" ]+\.js)"/); assert.ok(script); const built = await http(handle.runtime.url!, script[1]); assert.equal(built.status, 200); assert.ok(built.raw.length > 100);
  } finally { if (handle) await handle.close(); await fixture.cleanup(); }
});

test('wrong live endpoint and expired server handle cannot stop a newer owned server or obtain management credentials', async () => {
  const fixture = await workspace(); const first = await startStudio(fixture.root, { assetsRoot: fixture.assets });
  let received = ''; let redirect = false;
  const impostor = createServer((request, response) => { received = JSON.stringify(request.headers); if (redirect) { response.statusCode = 302; response.setHeader('Location', 'http://127.0.0.1:' + destinationPort + '/must-not-follow'); response.end(); } else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, data: { proof: 'wrong', owner: record.owner } })); } });
  let followed = 0; const destination = createServer((_, response) => { followed++; response.end('untrusted destination'); });
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve)); const destinationAddress = destination.address(); assert.ok(destinationAddress && typeof destinationAddress !== 'string'); const destinationPort = destinationAddress.port;
  const record = (await readRuntime(fixture.root))!; await new Promise<void>(resolve => impostor.listen(0, '127.0.0.1', resolve)); const address = impostor.address(); assert.ok(address && typeof address !== 'string');
  let next: Awaited<ReturnType<typeof startStudio>> | null = null;
  try {
    const altered = stringify({ ...record, port: address.port }); await writeFile(path.join(fixture.root, RUNTIME_PATH), altered);
    await assert.rejects(() => inspectStudio(fixture.root), error => error instanceof CoreError && error.diagnostics[0].code === 'AUTH_REQUIRED');
    await assert.rejects(() => stopOwnedStudio(fixture.root), error => error instanceof CoreError && error.diagnostics[0].code === 'AUTH_REQUIRED');
    assert.ok(!received.includes(record.management_secret)); assert.equal(await readFile(path.join(fixture.root, RUNTIME_PATH), 'utf8'), altered);
    redirect = true; await assert.rejects(() => inspectStudio(fixture.root), error => error instanceof CoreError && error.diagnostics[0].code === 'CAPABILITY_UNAVAILABLE'); assert.equal(followed, 0);
    await writeFile(path.join(fixture.root, RUNTIME_PATH), stringify(record)); assert.equal((await first.close()).ok, true);
    next = await startStudio(fixture.root, { assetsRoot: fixture.assets }); const expired = await first.close(); assert.equal(expired.ok, false); assert.equal(expired.diagnostics[0].code, 'CONFLICT');
    assert.deepEqual(await inspectStudio(fixture.root), next.runtime);
  } finally { await first.close(); if (next) await next.close(); await new Promise<void>(resolve => impostor.close(() => resolve())); await new Promise<void>(resolve => destination.close(() => resolve())); await fixture.cleanup(); }
});
