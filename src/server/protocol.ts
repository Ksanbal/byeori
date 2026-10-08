import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DiagnosticCode, Result } from '../contracts';
import { CoreError, reject } from '../core/errors';
import { result } from '../core/services';
import { parseYaml } from '../core/yaml';

export const BODY_LIMIT = 1024 * 1024;
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export class HttpError extends CoreError {
  constructor(readonly status: number, code: DiagnosticCode, message: string) { super(code, message); }
}
export function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function checkHeaders(request: IncomingMessage, origin: string): void {
  for (const name of ['host', 'origin', 'cookie', 'authorization', 'x-byeori-csrf', 'x-byeori-owner', 'x-byeori-challenge']) if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length > 1) throw new HttpError(400, 'VALIDATION_FAILED', 'Duplicate security header.');
  if (request.headers.host !== origin.slice('http://'.length)) throw new HttpError(403, 'AUTH_REQUIRED', 'Studio Host does not match this loopback server.');
  if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new HttpError(403, 'AUTH_REQUIRED', 'Studio Origin does not match this loopback server.');
}
export function routePath(request: IncomingMessage): string {
  const raw = request.url ?? '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('?') || raw.includes('#') || raw.length > 4096) throw new HttpError(400, 'PATH_DENIED', 'Invalid route; query credentials and arbitrary paths are not accepted.');
  const parts = raw.slice(1).split('/');
  if (raw === '/') return '/';
  return '/' + parts.map(part => {
    let decoded: string; try { decoded = decodeURIComponent(part); } catch { throw new HttpError(400, 'PATH_DENIED', 'Malformed route encoding.'); }
    if (!decoded || decoded === '.' || decoded === '..' || !/^[A-Za-z0-9_.-]+$/.test(decoded) || decoded.startsWith('.')) throw new HttpError(400, 'PATH_DENIED', 'Unsafe route segment.');
    return decoded;
  }).join('/');
}
export async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/.test(request.headers['content-type']?.toLowerCase() ?? '')) throw new HttpError(415, 'VALIDATION_FAILED', 'Expected application/json.');
  if (request.headers['content-encoding'] !== undefined) throw new HttpError(415, 'VALIDATION_FAILED', 'Encoded request bodies are not accepted.');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > BODY_LIMIT)) throw new HttpError(413, 'VALIDATION_FAILED', 'Request body exceeds the limit.');
  const raw = await new Promise<Buffer>((resolve, rejectBody) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', aborted); };
    const fail = () => { cleanup(); rejectBody(new HttpError(400, 'VALIDATION_FAILED', 'Incomplete request body.')); };
    const aborted = () => fail();
    const data = (chunk: Buffer) => { size += chunk.length; if (size > BODY_LIMIT) { cleanup(); request.pause(); rejectBody(new HttpError(413, 'VALIDATION_FAILED', 'Request body exceeds the limit.')); } else chunks.push(chunk); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.on('end', end); request.on('error', fail); request.on('aborted', aborted);
  });
  let value: unknown;
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(raw); JSON.parse(text); value = parseYaml(text); } catch { throw new HttpError(400, 'VALIDATION_FAILED', 'Invalid bounded UTF-8 JSON body.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function fields(body: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, ...optional].includes(key))) reject('VALIDATION_FAILED', 'Invalid HTTP request fields.');
}
export function publicResult<T>(value: Result<T>, secrets: string[] = []): Result<T> {
  return { ...value, diagnostics: value.diagnostics.map(diagnostic => ({ ...diagnostic, path: diagnostic.path?.startsWith('/') ? null : diagnostic.path, message: diagnostic.code === 'UNEXPECTED' ? 'Unexpected Studio operation failure.' : secrets.reduce((message, secret) => secret ? message.replaceAll(secret, '[private]') : message, diagnostic.message) })) };
}
export async function safeResult<T>(action: () => Promise<T>): Promise<Result<T>> { return publicResult(await result(action)); }
export function responseStatus(value: Result<unknown>): number {
  if (value.ok) return 200;
  const code = value.diagnostics[0]?.code;
  if (['CONFLICT', 'STALE_BASE', 'STALE_REVIEW', 'SOURCE_DRIFT', 'WORKSPACE_MISMATCH', 'POLICY_MISMATCH', 'APPLY_RECOVERY_REQUIRED'].includes(code)) return 409;
  if (code === 'AUTH_REQUIRED') return 401;
  if (code === 'SCOPE_DENIED' || code === 'PATH_DENIED' || code === 'REVIEW_REQUIRED') return 403;
  if (code === 'CAPABILITY_UNAVAILABLE' || code === 'HOOK_NOT_ACTIVE') return 503;
  return code === 'UNEXPECTED' ? 500 : 400;
}
export function headers(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', CSP); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cache-Control', 'no-store');
}
export function send<T>(response: ServerResponse, value: Result<T>, status = responseStatus(value)): void {
  headers(response); response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Connection', 'close'); response.end(JSON.stringify(value));
}
