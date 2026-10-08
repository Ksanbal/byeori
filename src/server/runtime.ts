import { createHmac, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { StudioRuntime, WriteOwnership } from '../contracts';
import { isObject } from '../core/documents';
import { reject } from '../core/errors';
import { probeOwnership, withWriteLock } from '../core/ownership';
import { readText, safePath } from '../core/paths';
import { canonicalJson, parseYaml } from '../core/yaml';
import { workspaceIdentity } from '../core/workspace';

export const RUNTIME_PATH = 'planning/.runtime/studio.yaml';
export interface RuntimeRecord { schema_version: 1; canonical_root: string; owner: WriteOwnership; port: number; management_secret: string }
export function randomSecret(): string { return randomBytes(32).toString('base64url'); }
export function publicRuntime(record: RuntimeRecord): StudioRuntime { return { state: 'running', url: 'http://127.0.0.1:' + record.port, pid: record.owner.process.pid }; }
export const STOPPED: StudioRuntime = { state: 'stopped', url: null, pid: null };
export async function readRuntime(root: string): Promise<RuntimeRecord | null> {
  let raw: string; try { raw = await readText(root, RUNTIME_PATH); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if ((await lstat(await safePath(root, RUNTIME_PATH))).mode & 0o077) reject('AUTH_REQUIRED', 'Studio credentials require owner-only file permissions.');
  const value = parseYaml(raw);
  if (!isObject(value) || Object.keys(value).length !== 5 || value.schema_version !== 1 || typeof value.canonical_root !== 'string' || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535 || typeof value.management_secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.management_secret) || !isObject(value.owner)) reject('APPLY_RECOVERY_REQUIRED', 'Malformed Studio ownership; inspect the runtime record.');
  const { validateOwner } = await import('../core/ownership'); validateOwner(value.owner);
  if (value.canonical_root !== (await workspaceIdentity(root)).canonical_root || value.owner.operation !== 'studio start') reject('WORKSPACE_MISMATCH', 'Studio ownership does not belong to this workspace.');
  return value as unknown as RuntimeRecord;
}
export function sameRuntime(a: RuntimeRecord | null, b: RuntimeRecord): boolean { return a !== null && canonicalJson(a) === canonicalJson(b); }
export function managementProof(record: RuntimeRecord, action: string, challenge: string): string { return createHmac('sha256', record.management_secret).update(action + '\n' + record.owner.owner_nonce + '\n' + challenge).digest('hex'); }
export async function control(record: RuntimeRecord, action: 'identity' | 'stop'): Promise<unknown> {
  const origin = publicRuntime(record).url!;
  const challenge = randomSecret();
  let response: Response;
  try { response = await fetch(origin + '/api/internal/' + action, { method: 'POST', redirect: 'error', headers: { Origin: origin, Authorization: 'Byeori ' + managementProof(record, action, challenge), 'X-Byeori-Owner': record.owner.owner_nonce, 'X-Byeori-Challenge': challenge, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }); }
  catch { reject('CAPABILITY_UNAVAILABLE', 'Owned Studio endpoint is unavailable; no process was signalled.'); }
  const reader = response.body?.getReader(); if (!reader) reject('AUTH_REQUIRED', 'Studio identity response is missing.');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 8192) { await reader.cancel(); reject('AUTH_REQUIRED', 'Studio identity response exceeds the limit.'); } chunks.push(item.value); }
  const raw = Buffer.concat(chunks).toString('utf8');
  let value: unknown; try { value = JSON.parse(raw); } catch { reject('AUTH_REQUIRED', 'Studio identity response is invalid.'); }
  if (!response.ok || !isObject(value) || value.ok !== true || !isObject(value.data) || canonicalJson(value.data.owner) !== canonicalJson(record.owner) || value.data.proof !== managementProof(record, 'response:' + action, challenge)) reject('AUTH_REQUIRED', 'Studio endpoint ownership differs; no process was signalled.');
  return value.data;
}
export async function inspectStudio(root: string): Promise<StudioRuntime> {
  const record = await readRuntime(root); if (!record) return STOPPED;
  const live = await probeOwnership(record.owner); if (live === 'dead') return STOPPED;
  if (live !== 'alive') reject('APPLY_RECOVERY_REQUIRED', 'Studio process identity is uncertain; inspect before stopping.');
  await control(record, 'identity'); return publicRuntime(record);
}
export async function stopOwnedStudio(root: string, expectedNonce?: string): Promise<StudioRuntime> {
  return withWriteLock(root, 'studio stop', async writer => {
    const record = await readRuntime(root); if (!record) return STOPPED;
    if (expectedNonce !== undefined && record.owner.owner_nonce !== expectedNonce) reject('CONFLICT', 'Studio handle does not own this runtime.');
    const live = await probeOwnership(record.owner); if (live === 'unknown') reject('APPLY_RECOVERY_REQUIRED', 'Studio identity is uncertain; no process was signalled.');
    if (live === 'alive') {
      await control(record, 'identity'); await control(record, 'stop');
    }
    if (!sameRuntime(await readRuntime(root), record)) reject('CONFLICT', 'Studio owner record changed before cleanup.');
    await writer.remove(RUNTIME_PATH); return STOPPED;
  });
}
