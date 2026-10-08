import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BODY_LIMIT } from '../../src/server/protocol';
import { browserSession, http, serverCase } from './helpers';

async function submissions(root: string): Promise<string[]> { try { return await readdir(path.join(root, 'planning/reviews/submissions')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }

test('HTTP auth/Origin/Host/method/body checks fail before human writes and never expose credentials', async () => serverCase(async (root, _, handle) => {
  const url = handle.runtime.url!; const session = await browserSession(url); const before = await submissions(root);
  const cases: Array<[string, string, Record<string, string>, string | undefined, number]> = [
    ['/api/state', 'GET', {}, undefined, 401],
    ['/', 'GET', {}, undefined, 403],
    ['/', 'GET', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site' }, undefined, 403],
    ['/api/status', 'GET', { Cookie: session.cookie, Origin: 'https://evil.invalid' }, undefined, 403],
    ['/api/status', 'GET', { Cookie: session.cookie, Host: 'evil.invalid' }, undefined, 403],
    ['/api/status', 'GET', { Cookie: session.cookie, Host: 'localhost:' + new URL(url).port }, undefined, 403],
    ['/api/review/submit', 'POST', { ...session.headers, Origin: 'null' }, '{}', 403],
    ['/api/review/submit', 'POST', { Cookie: session.cookie, 'Content-Type': 'application/json' }, '{}', 403],
    ['/api/review/submit', 'POST', { ...session.headers, 'X-Byeori-CSRF': 'wrong' }, '{}', 403],
    ['/api/review/submit', 'POST', { ...session.headers, 'Content-Type': 'text/plain' }, '{}', 415],
    ['/api/review/submit', 'POST', { ...session.headers, 'Content-Encoding': 'gzip' }, '{}', 415],
    ['/api/review/submit', 'POST', session.headers, '"' + 'x'.repeat(BODY_LIMIT) + '"', 413],
    ['/api/review/submit', 'POST', session.headers, 'null', 400],
    ['/api/review/submit', 'POST', session.headers, '{"round":1,"round":2}', 400],
    ['/api/review/submit', 'POST', session.headers, '{"__proto__":{}}', 400],
    ['/api/review/submit', 'GET', { Cookie: session.cookie }, undefined, 405],
    ['/api/status', 'PUT', { Cookie: session.cookie }, undefined, 405],
    ['/api/internal/stop', 'POST', session.headers, '{}', 401],
  ];
  for (const [route, method, headers, body, expected] of cases) {
    const denied = await http(url, route, method, headers, body); assert.equal(denied.status, expected, route + '/' + method);
    assert.equal(denied.result().ok, false); assert.ok(!denied.raw.includes(root) && !denied.raw.includes(session.csrf) && !denied.raw.includes(session.cookie));
  }
  assert.deepEqual(await submissions(root), before);
  assert.equal((await session.get('/api/status')).status, 200);
}));

test('raw encoded routes, static symlink escape and secrets in query fail closed; safe built-asset policy has CSP', async () => serverCase(async (root, assets, handle) => {
  const url = handle.runtime.url!; const session = await browserSession(url);
  for (const route of ['/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%252e%252e/index.html', '/assets/%2fetc', '/assets/%5cetc', '/api/review%2fsubmit', '/api/%', '//evil.invalid/api/status', '/?token=private-input', '/assets/.env', '/planning/config.yaml']) {
    const reply = await http(url, route, 'GET', { Cookie: session.cookie }); assert.ok(reply.status >= 400, route); assert.ok(!reply.raw.includes('private-input') && !reply.raw.includes(root));
  }
  const outside = await mkdtemp(path.join(os.tmpdir(), 'byeori-static-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.js'), 'private sentinel'); await symlink(outside, path.join(assets, 'escape'));
    const denied = await http(url, '/escape/secret.js'); assert.equal(denied.status, 403); assert.ok(!denied.raw.includes('private sentinel')); assert.equal(await readFile(path.join(outside, 'secret.js'), 'utf8'), 'private sentinel');
    await symlink(path.join(outside, 'secret.js'), path.join(assets, 'assets/symlink.js')); assert.equal((await http(url, '/assets/symlink.js')).status, 403);
  } finally { await rm(outside, { recursive: true, force: true }); }
  const asset = await http(url, '/assets/app.js'); assert.equal(asset.status, 200); assert.equal(asset.headers['x-content-type-options'], 'nosniff'); assert.ok(String(asset.headers['content-security-policy']).includes("script-src 'self'")); assert.equal(asset.headers['access-control-allow-origin'], undefined);
  assert.equal((await http(url, '/documents/ACT-WORKER-001', 'GET', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin' })).status, 200);
}));
