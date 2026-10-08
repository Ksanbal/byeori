import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { stringify } from 'yaml';
import type { CoreApi, GetRequest, HistoryRequest, Result, ReviewBinding, ReviewSubmission, SaveReviewDraftRequest, StudioRuntime } from '../contracts';
import { reject } from '../core/errors';
import { withWriteLock } from '../core/ownership';
import { safePath } from '../core/paths';
import { createHumanReview, createReviewCore, result } from '../core/services';
import { readHost } from '../core/state';
import { workspaceIdentity } from '../core/workspace';
import { checkHeaders, equalSecret, fields, headers, HttpError, jsonBody, publicResult, responseStatus, routePath, safeResult, send } from './protocol';
import { inspectStudio, managementProof, publicRuntime, randomSecret, readRuntime, RUNTIME_PATH, sameRuntime, stopOwnedStudio, type RuntimeRecord } from './runtime';
import { operationObserved } from './operation-observation';

export interface StudioServerOptions { assetsRoot: string; port?: number }
export interface StudioServerHandle { runtime: StudioRuntime; close(): Promise<Result<StudioRuntime>> }
interface Session { csrf: string; expires: number }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const BINDING_FIELDS = ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash'];
function cookie(request: IncomingMessage, name: string): string | null {
  const matches = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (matches.length > 1) throw new HttpError(401, 'AUTH_REQUIRED', 'Ambiguous Studio session.');
  return matches.length ? matches[0].slice(name.length + 1) : null;
}
function closeServer(server: Server): Promise<void> { return new Promise((resolve, rejectClose) => server.close(error => error ? rejectClose(error) : resolve())); }
async function staticAsset(root: string, relative: string): Promise<{ raw: Buffer; mime: string }> {
  const mime = MIME[path.extname(relative)]; if (!mime) throw new HttpError(404, 'PATH_DENIED', 'Static asset is unavailable.');
  const handle = await open(await safePath(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new HttpError(404, 'PATH_DENIED', 'Static asset is unavailable.'); return { raw: await handle.readFile(), mime }; } finally { await handle.close(); }
}
export async function startStudio(inputRoot: string, options: StudioServerOptions): Promise<StudioServerHandle> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  if (!options || typeof options.assetsRoot !== 'string' || options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) reject('VALIDATION_FAILED', 'Invalid Studio launch configuration.');
  if (!(await lstat(options.assetsRoot)).isDirectory() || (await lstat(options.assetsRoot)).isSymbolicLink()) reject('PATH_DENIED', 'Studio assets must be a regular directory.');
  await staticAsset(options.assetsRoot, 'index.html');
  return withWriteLock(root, 'studio start', async writer => {
    if (await readRuntime(root)) reject('CONFLICT', 'Studio runtime already exists; inspect or stop its verified owner first.');
    const core = createReviewCore(root); const human = createHumanReview(root);
    let record: RuntimeRecord | null = null; let origin = ''; let cookieName = ''; let closing = false;
    let activeCore = 0; let drained: (() => void) | null = null;
    const runCore = async <T>(route: string, action: () => Promise<Result<T>>): Promise<Result<T>> => {
      if (closing) throw new HttpError(503, 'CAPABILITY_UNAVAILABLE', 'Studio is stopping; this operation was not admitted.');
      activeCore++;
      try { await operationObserved(root, { phase: 'admitted', route }); const value = await action(); await operationObserved(root, { phase: 'completed', route }); return value; }
      finally { activeCore--; if (activeCore === 0) { drained?.(); drained = null; } }
    };
    const sessions = new Map<string, Session>(); const usedChallenges = new Set<string>();
    const session = (request: IncomingMessage): Session => {
      const token = cookie(request, cookieName); const found = token === null ? undefined : sessions.get(token);
      if (!found || found.expires <= Date.now()) throw new HttpError(401, 'AUTH_REQUIRED', 'Open Studio from a trusted browser navigation to establish a session.');
      return found;
    };
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 5000 }, async (request, response) => {
      let forcedStatus: number | undefined;
      try {
        if (!record || closing) throw new HttpError(503, 'CAPABILITY_UNAVAILABLE', 'Studio is starting or stopping.');
        checkHeaders(request, origin); const route = routePath(request);
        if (!['GET', 'POST'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, POST'); throw new HttpError(405, 'VALIDATION_FAILED', 'Unsupported Studio method.'); }
        if (route.startsWith('/api/internal/')) {
          if (request.method !== 'POST') throw new HttpError(405, 'VALIDATION_FAILED', 'Management requires POST.');
          const action = route.slice('/api/internal/'.length); const challenge = request.headers['x-byeori-challenge'];
          if (!['identity', 'stop'].includes(action) || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || request.headers.origin !== origin || !equalSecret(request.headers['x-byeori-owner'], record.owner.owner_nonce) || !equalSecret(request.headers.authorization, 'Byeori ' + managementProof(record, action, challenge))) throw new HttpError(401, 'AUTH_REQUIRED', 'Invalid Studio management proof.');
          if (usedChallenges.has(challenge)) throw new HttpError(409, 'CONFLICT', 'Management proof already used.');
          const body = await jsonBody(request); fields(body, []);
          if (!sameRuntime(await readRuntime(root), record)) throw new HttpError(409, 'CONFLICT', 'Studio runtime ownership changed.');
          usedChallenges.add(challenge); if (usedChallenges.size > 128) usedChallenges.delete(usedChallenges.values().next().value!);
          if (action === 'stop') {
            if (closing) throw new HttpError(409, 'CONFLICT', 'Studio is already stopping.');
            closing = true; sessions.clear(); await operationObserved(root, { phase: 'quiescing' });
            if (activeCore > 0) await new Promise<void>(resolve => { drained = resolve; });
          }
          send(response, await safeResult(async () => ({ owner: record!.owner, proof: managementProof(record!, 'response:' + action, challenge) })));
          if (action === 'stop') setImmediate(() => { void closeServer(server).catch(() => {}); });
          return;
        }
        if (route.startsWith('/api/')) {
          const currentSession = session(request);
          if (request.method === 'GET') {
            if (['/api/document', '/api/history', '/api/review/results', '/api/review/draft', '/api/review/submit', '/api/advisory'].includes(route)) throw new HttpError(405, 'VALIDATION_FAILED', 'This route requires a bounded POST.');
            const value: Result<unknown> | null = route === '/api/session' ? await safeResult(async () => ({ csrf_token: currentSession.csrf })) : route === '/api/state' ? await runCore(route, () => human.studioState()) : route === '/api/status' ? await runCore(route, () => core.status()) : route === '/api/hosts' ? await runCore(route, () => result(async () => [await readHost(root, 'claude'), await readHost(root, 'codex')])) : null;
            if (!value) throw new HttpError(404, 'VALIDATION_FAILED', 'Unknown Studio API route.');
            const safe = publicResult(value, [root, record.management_secret]); send(response, safe); return;
          }
          if (request.headers.origin !== origin || !equalSecret(request.headers['x-byeori-csrf'], currentSession.csrf)) throw new HttpError(403, 'AUTH_REQUIRED', 'Studio mutation requires exact Origin and the current session CSRF proof.');
          const body = await jsonBody(request); let value: Result<unknown>;
          if (closing) throw new HttpError(503, 'CAPABILITY_UNAVAILABLE', 'Studio is stopping; this operation was not admitted.');
          switch (route) {
            case '/api/document': fields(body, ['object_id'], ['scope', 'revision']); value = await runCore(route, () => core.get(body as unknown as GetRequest)); break;
            case '/api/history': fields(body, [], ['object_id', 'change_id', 'limit', 'cursor']); value = await runCore(route, () => core.history(body as HistoryRequest)); break;
            case '/api/review/results': fields(body, BINDING_FIELDS); value = await runCore(route, () => core.reviewResults(body as unknown as ReviewBinding)); break;
            case '/api/review/draft': fields(body, [...BINDING_FIELDS, 'items', 'implementation_authorization', 'expected_version']); value = await runCore(route, () => human.saveReviewDraft(body as unknown as SaveReviewDraftRequest)); break;
            case '/api/review/submit': fields(body, [...BINDING_FIELDS, 'items', 'implementation_authorization', 'schema_version', 'submission_id', 'expected_feedback_version', 'final_confirmation']); value = await runCore(route, () => human.submitReview(body as unknown as ReviewSubmission)); break;
            case '/api/advisory': fields(body, ['host', 'reason']); value = await runCore(route, () => human.selectAdvisory(body as unknown as { host: 'claude' | 'codex'; reason: string })); break;
            default: throw new HttpError(404, 'VALIDATION_FAILED', 'Unknown Studio API route.');
          }
          const safe = publicResult(value, [root, record.management_secret]); send(response, safe, responseStatus(safe)); return;
        }
        if (request.method !== 'GET') throw new HttpError(405, 'VALIDATION_FAILED', 'Static routes require GET.');
        const navigation = route === '/' || route === '/index.html' || /^\/(?:documents|review)(?:\/[A-Za-z0-9_-]+)*$/.test(route);
        if (navigation) {
          if (request.headers['sec-fetch-mode'] !== 'navigate' || request.headers['sec-fetch-dest'] !== 'document' || !['none', 'same-origin'].includes(String(request.headers['sec-fetch-site']))) throw new HttpError(403, 'AUTH_REQUIRED', 'Studio session bootstrap requires trusted browser navigation.');
          let token = cookie(request, cookieName); let found = token === null ? undefined : sessions.get(token);
          if (!found || found.expires <= Date.now()) {
            token = randomSecret(); found = { csrf: randomSecret(), expires: Date.now() + 3600_000 };
            for (const [key, existing] of sessions) if (existing.expires <= Date.now()) sessions.delete(key);
            if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
            sessions.set(token, found); response.setHeader('Set-Cookie', cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600');
          }
        }
        const asset = await staticAsset(options.assetsRoot, navigation ? 'index.html' : route.slice(1)); headers(response); response.statusCode = 200; response.setHeader('Content-Type', asset.mime); response.end(asset.raw);
      } catch (error) {
        let failure = error;
        if (error instanceof HttpError) forcedStatus = error.status;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { failure = new HttpError(404, 'PATH_DENIED', 'Static asset is unavailable.'); forcedStatus = 404; }
        const value = publicResult(await result(async () => { throw failure; }), [root, record?.management_secret ?? '']);
        if (!response.headersSent) send(response, value, forcedStatus ?? responseStatus(value)); else response.destroy();
      }
    });
    server.on('clientError', (_, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    try {
      await new Promise<void>((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', rejectListen); resolve(); }); });
      const address = server.address(); if (!address || typeof address === 'string') reject('CAPABILITY_UNAVAILABLE', 'Studio failed to bind loopback.');
      origin = 'http://127.0.0.1:' + address.port; cookieName = 'byeori_session_' + address.port;
      const stored: RuntimeRecord = { schema_version: 1, canonical_root: root, owner: writer.owner, port: address.port, management_secret: randomSecret() };
      await writer.write(RUNTIME_PATH, stringify(stored), true); record = stored;
      return { runtime: publicRuntime(stored), close: () => safeResult(() => stopOwnedStudio(root, stored.owner.owner_nonce)) };
    } catch (error) {
      if (server.listening) await closeServer(server);
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') reject('CONFLICT', 'Requested loopback port is already in use; choose another port.');
      throw error;
    }
  });
}
export function createStudioLifecycle(root: string, options: StudioServerOptions): CoreApi['studio'] {
  return input => safeResult(async () => {
    if (!input || !['start', 'status', 'stop'].includes(input.action)) reject('VALIDATION_FAILED', 'Unknown Studio lifecycle action.');
    if (input.action === 'status') return inspectStudio(root);
    if (input.action === 'stop') return stopOwnedStudio(root);
    const current = await inspectStudio(root); return current.state === 'running' ? current : (await startStudio(root, options)).runtime;
  });
}
