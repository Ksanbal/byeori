import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalViewerRoot, loadCatalog, readViewerFile, ViewerSelectionError, VIEWER_LIMITS } from './catalog';

export interface ViewerOptions { root: string; port?: number; assetsRoot?: string }
export interface RunningViewer { server: Server; url: string; port: number; close: () => Promise<void> }
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] } as const;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function defaultAssetsRoot(): string {
  return import.meta.url.endsWith('.mjs') ? fileURLToPath(new URL('./viewer', import.meta.url)) : fileURLToPath(new URL('../../dist/viewer', import.meta.url));
}
function headers(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Cache-Control', 'no-store');
}
function send(request: IncomingMessage, response: ServerResponse, status: number, body: Buffer | string, type = 'text/plain; charset=utf-8'): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  response.setHeader('Content-Length', bytes.length);
  response.end(request.method === 'HEAD' ? undefined : bytes);
}
function allowedRequest(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length;
  if (hostCount !== 1 || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? '')) return false;
  const remote = request.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') return false;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  if (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) return false;
  return true;
}

/** A separate document browser, intentionally unrelated to Core review/apply/ownership. */
export async function startViewer(options: ViewerOptions): Promise<RunningViewer> {
  const requestedPort = options.port ?? 4317;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Viewer port must be an integer between 0 and 65535.');
  const root = await canonicalViewerRoot(path.resolve(options.root));
  const assetsRoot = await canonicalViewerRoot(path.resolve(options.assetsRoot ?? defaultAssetsRoot()));
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [route, [filename, type]] of Object.entries(ASSETS)) assets.set(route, { body: await readViewerFile(assetsRoot, filename, 4 * 1024 * 1024), type });
  let port = requestedPort;
  const readings = new Map<string, Promise<string>>();
  let activeCatalogResponses = 0;
  const catalog = (changeId?: string): Promise<string> => {
    const key = changeId ?? '';
    let reading = readings.get(key);
    if (!reading) {
      if (readings.size >= 2) return Promise.reject(new Error('Viewer is busy.'));
      reading = (async () => {
      if (await canonicalViewerRoot(root) !== root) throw new Error('Workspace path changed.');
      let remaining = VIEWER_LIMITS.response_bytes;
      return JSON.stringify(await loadCatalog(root, changeId), (key: string, value: unknown) => {
        // Bound serialization too: projections can repeat nested OpenAPI content.
        remaining -= Buffer.byteLength(JSON.stringify(key)) + 2;
        remaining -= typeof value === 'string' ? Buffer.byteLength(JSON.stringify(value)) : typeof value === 'number' ? 32 : 5;
        if (remaining < 0) throw new Error('Catalog exceeds viewer response limits.');
        return value;
      });
      })().finally(() => { readings.delete(key); });
      readings.set(key, reading);
    }
    return reading;
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 3000 }, (request, response) => {
    headers(response);
    if (!allowedRequest(request, port)) { send(request, response, 403, 'This viewer accepts local same-origin requests only.\n'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(request, response, 405, 'Read-only viewer: only GET and HEAD are supported.\n'); return;
    }
    if (request.headers['transfer-encoding'] !== undefined || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') { send(request, response, 400, 'Request bodies are not supported.\n'); return; }
    const route = request.url ?? '';
    if (!route.startsWith('/') || route.startsWith('//')) { send(request, response, 400, 'Invalid request target.\n'); return; }
    const selection = /^\/api\/catalog(?:\?change=([A-Za-z0-9][A-Za-z0-9_-]{0,127}))?$/.exec(route);
    if (selection) {
      // Bound both independent parses and slow/pipelined response subscribers.
      if (activeCatalogResponses >= 4) { send(request, response, 503, 'Viewer is busy; retry shortly.\n'); return; }
      activeCatalogResponses++;
      let released = false;
      const release = (): void => { if (!released) { released = true; activeCatalogResponses--; } };
      response.once('finish', release); response.once('close', release);
      void catalog(selection[1]).then(body => { if (!response.destroyed) send(request, response, 200, body, 'application/json; charset=utf-8'); }).catch(error => { if (!response.destroyed) send(request, response, error instanceof ViewerSelectionError ? 404 : 503, error instanceof ViewerSelectionError ? 'Selected change is unavailable.\n' : 'Document catalog is temporarily unavailable.\n'); });
      return;
    }
    const asset = assets.get(route);
    if (asset) { send(request, response, 200, asset.body, asset.type); return; }
    send(request, response, 404, 'Not found.\n');
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(15_000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Viewer could not establish a loopback address.'); }
  port = address.port;
  return { server, port, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
