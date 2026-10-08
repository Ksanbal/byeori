import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Result } from '../../src/contracts';
import { initializeWorkspace } from '../../src/core/workspace';
import { startStudio, type StudioServerHandle } from '../../src/server';

export interface Reply { status: number; headers: IncomingHttpHeaders; raw: string; result<T>(): Result<T> }
export function http(url: string, route: string, method = 'GET', headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  const parsed = new URL(url);
  return new Promise((resolve, rejectHttp) => {
    const call = request({ hostname: '127.0.0.1', port: parsed.port, path: route, method, headers }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', rejectHttp);
      response.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode!, headers: response.headers, raw, result: <T>() => JSON.parse(raw) as Result<T> }); });
    });
    call.on('error', rejectHttp); if (body !== undefined) call.write(body); call.end();
  });
}
export async function browserSession(url: string) {
  const navigation = await http(url, '/', 'GET', { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' });
  assert.equal(navigation.status, 200); const setCookie = navigation.headers['set-cookie']![0];
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict')); const cookie = setCookie.split(';')[0];
  const reply = await http(url, '/api/session', 'GET', { Cookie: cookie }); const data = reply.result<{ csrf_token: string }>(); assert.equal(data.ok, true); if (!data.ok) throw new Error('No browser session');
  const headers = { Cookie: cookie, Origin: url, 'X-Byeori-CSRF': data.data.csrf_token, 'Content-Type': 'application/json' };
  return { cookie, csrf: data.data.csrf_token, headers, get: (route: string) => http(url, route, 'GET', { Cookie: cookie }), post: (route: string, body: unknown) => http(url, route, 'POST', headers, JSON.stringify(body)) };
}
export async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori-http-')); const assets = await mkdtemp(path.join(os.tmpdir(), 'byeori-assets-'));
  await initializeWorkspace(root); await mkdir(path.join(assets, 'assets'));
  await writeFile(path.join(assets, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><main>HTTP fixture</main></body></html>');
  await writeFile(path.join(assets, 'assets/app.js'), 'export const fixture = true;');
  return { root, assets, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(assets, { recursive: true, force: true }); } };
}
export async function serverCase(action: (root: string, assets: string, handle: StudioServerHandle) => Promise<void>): Promise<void> {
  const fixture = await workspace(); let handle: StudioServerHandle | null = null;
  try { handle = await startStudio(fixture.root, { assetsRoot: fixture.assets }); await action(fixture.root, fixture.assets, handle); }
  finally { if (handle) await handle.close(); await fixture.cleanup(); }
}
