import type { Diagnostic, HostCapability, Result } from '../../contracts';

export class ApiError extends Error {
  constructor(readonly diagnostics: Diagnostic[], readonly status: number) {
    super(diagnostics.map(item => item.message).join('\n') || '서버 응답을 확인하지 못했습니다.');
  }
}
let session: Promise<string> | undefined;
let pending: Promise<void> = Promise.resolve();
async function response<T>(request: Promise<Response>): Promise<T> {
  const reply = await request;
  const value = await reply.json() as Result<T>;
  if (!value.ok) throw new ApiError(value.diagnostics, reply.status);
  if (!reply.ok) throw new Error('서버 응답을 확인하지 못했습니다.');
  return value.data;
}
function csrf(): Promise<string> {
  session ??= response<{ csrf_token: string }>(fetch('/api/session', { credentials: 'same-origin' })).then(value => value.csrf_token).catch(error => { session = undefined; throw error; });
  return session;
}
// ponytail: one Core read per tab; parallel reads can replace this when the server supports them.
function read<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const next = pending.then(async () => {
    signal?.throwIfAborted();
    // A cancelled view must await the server response before another Core read starts.
    const value = await action();
    signal?.throwIfAborted();
    return value;
  });
  pending = next.then(() => undefined, () => undefined);
  return next;
}
export async function getState<T>(signal?: AbortSignal): Promise<T> {
  await csrf();
  return read(() => response(fetch('/api/state', { credentials: 'same-origin' })), signal);
}
export async function getHosts(signal?: AbortSignal): Promise<HostCapability[]> {
  await csrf();
  return read(() => response(fetch('/api/hosts', { credentials: 'same-origin' })), signal);
}
export async function post<T>(route: '/api/document' | '/api/history' | '/api/review/results' | '/api/review/draft' | '/api/review/submit' | '/api/advisory', body: unknown, signal?: AbortSignal): Promise<T> {
  const token = await csrf();
  try {
    return await read<T>(() => response(fetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Byeori-CSRF': token }, body: JSON.stringify(body) })), signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) session = undefined;
    throw error;
  }
}
