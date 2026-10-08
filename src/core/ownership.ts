import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import type { WriteOwnership } from '../contracts';
import { reject } from './errors';
import { ensureDirectory, listFiles, readText, recordId, relativePath, safePath } from './paths';
import { canonicalJson, checkRaw, parseYaml } from './yaml';
import { isObject } from './documents';

const run = promisify(execFile);
const LOCK = 'planning/.runtime/write-lock';
export type Liveness = 'alive' | 'dead' | 'unknown';
async function bootIdentity(): Promise<string> {
  if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (process.platform === 'darwin') return (await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).stdout.trim();
  reject('CAPABILITY_UNAVAILABLE', 'Process ownership probes support macOS and Linux only.');
}
async function startIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return 'linux:' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'darwin') {
      const output = (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
      return output ? 'darwin:' + output : null;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && process.platform === 'linux') return null;
    try { process.kill(pid, 0); } catch (signalError) { if ((signalError as NodeJS.ErrnoException).code === 'ESRCH') return null; }
    throw error;
  }
}
export async function probeOwnership(owner: WriteOwnership): Promise<Liveness> {
  try {
    const boot = await bootIdentity();
    if (!boot || !owner.process.boot_identity || !owner.process.start_identity) return 'unknown';
    if (boot !== owner.process.boot_identity) return 'dead';
    const start = await startIdentity(owner.process.pid);
    if (start === null) return 'dead';
    // A currently reused PID is conservatively uncertain; never displace that process automatically.
    return start === owner.process.start_identity ? 'alive' : 'unknown';
  } catch { return 'unknown'; }
}
export function validateOwner(value: unknown): WriteOwnership {
  if (!isObject(value) || value.schema_version !== 1 || typeof value.anchor_nonce !== 'string' || typeof value.owner_nonce !== 'string' || !isObject(value.process) || !Number.isSafeInteger(value.process.pid) || (value.process.pid as number) < 1 || typeof value.process.start_identity !== 'string' || !value.process.start_identity || typeof value.process.boot_identity !== 'string' || !value.process.boot_identity || typeof value.operation !== 'string' || typeof value.acquired_at !== 'string') reject('APPLY_RECOVERY_REQUIRED', 'Malformed/partial write ownership; inspect before recovery.');
  recordId(value.anchor_nonce); recordId(value.owner_nonce);
  return value as unknown as WriteOwnership;
}
export async function readOwnership(root: string): Promise<WriteOwnership | null> {
  try { return validateOwner(parseYaml(await readText(root, LOCK + '/owner.yaml'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    try { await lstat(await safePath(root, LOCK)); } catch (lockError) { if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') return null; throw lockError; }
    reject('APPLY_RECOVERY_REQUIRED', 'Partial ownership anchor exists without its durable owner.');
  } throw error; }
}
async function currentOwner(operation: string, anchor?: string): Promise<WriteOwnership> {
  const nonce = randomUUID();
  let boot: string; let start: string | null;
  try { boot = await bootIdentity(); start = await startIdentity(process.pid); }
  catch { reject('CAPABILITY_UNAVAILABLE', 'Unable to observe process start/boot identity.'); }
  if (!boot || !start) reject('CAPABILITY_UNAVAILABLE', 'Unable to observe process start/boot identity.');
  return { schema_version: 1, anchor_nonce: anchor ?? nonce, owner_nonce: nonce, process: { pid: process.pid, start_identity: start, boot_identity: boot }, operation, acquired_at: new Date().toISOString() };
}
async function flushDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export interface Writer {
  root: string; owner: WriteOwnership;
  assert(): Promise<void>;
  write(relative: string, raw: string, createOnly?: boolean): Promise<void>;
  remove(relative: string): Promise<void>;
  retain(value?: boolean): void;
  bindJournal(relative: string): Promise<void>;
}
/** Internal fault/observation dependency; never a human-approval capability. */
export interface MutationHooks { afterBoundary?: (boundary: string) => Promise<void>; beforeMutation?: (relative: string) => Promise<void> }
async function writer(root: string, owner: WriteOwnership, claim: boolean, hooks: MutationHooks): Promise<Writer & { release(): Promise<void> }> {
  let retained = false;
  let journal: string | null = null;
  const assert = async (): Promise<void> => {
    const anchor = await readOwnership(root);
    if (!anchor || anchor.anchor_nonce !== owner.anchor_nonce) reject('APPLY_RECOVERY_REQUIRED', 'Writer has lost its ownership anchor.');
    if (claim) {
      const active = validateOwner(parseYaml(await readText(root, LOCK + '/recovery-claim/owner.yaml')));
      if (canonicalJson(active) !== canonicalJson(owner)) reject('APPLY_RECOVERY_REQUIRED', 'Writer has lost its recovery claim.');
    } else {
      if (canonicalJson(anchor) !== canonicalJson(owner)) reject('APPLY_RECOVERY_REQUIRED', 'Writer ownership changed.');
      try { await open(await safePath(root, LOCK + '/recovery-claim'), constants.O_RDONLY).then(handle => handle.close()); reject('APPLY_RECOVERY_REQUIRED', 'Original writer lost ownership to a recovery claim.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (journal) {
      const transaction = parseYaml(await readText(root, journal));
      if (!isObject(transaction) || !isObject(transaction.owner) || canonicalJson(transaction.owner) !== canonicalJson(owner)) reject('APPLY_RECOVERY_REQUIRED', 'Writer lost durable journal ownership.', journal);
    }
  };
  const write = async (relative: string, raw: string, createOnly = false): Promise<void> => {
    relativePath(relative); checkRaw(raw);
    if (!relative.startsWith('planning/') && relative !== '.gitignore') reject('PATH_DENIED', 'Core writes only managed planning paths and the ignore block.', relative);
    await assert();
    if (path.posix.dirname(relative) !== '.') await ensureDirectory(root, path.posix.dirname(relative), assert);
    const target = await safePath(root, relative);
    await assert();
    await ensureDirectory(root, LOCK + '/staging', assert);
    const temporary = LOCK + '/staging/' + randomUUID() + '.tmp';
    const handle = await open(await safePath(root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(raw, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await hooks.afterBoundary?.('temporary:' + relative);
    await assert(); await safePath(root, relative);
    if (createOnly) {
      await assert(); await hooks.beforeMutation?.(relative); await assert();
      try { await link(await safePath(root, temporary), target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') reject('CONFLICT', 'Create-only record already exists.', relative); throw error; }
      await assert(); await rm(await safePath(root, temporary));
    } else {
      await assert(); await hooks.beforeMutation?.(relative); await assert(); await rename(await safePath(root, temporary), target);
    }
    await flushDirectory(path.dirname(target)); await assert();
    await hooks.afterBoundary?.('write:' + relative); await assert();
  };
  return { root, owner, assert, write,
    async remove(relative) { relativePath(relative); if (!relative.startsWith('planning/')) reject('PATH_DENIED', 'Delete outside planning denied.'); const target = await safePath(root, relative); await assert(); await hooks.beforeMutation?.(relative); await assert(); await rm(target); await flushDirectory(path.dirname(target)); await assert(); await hooks.afterBoundary?.('delete:' + relative); await assert(); },
    retain(value = true) { retained = value; },
    async bindJournal(relative) { relativePath(relative); if (!relative.startsWith('planning/changes/') || !relative.endsWith('/apply-transaction.yaml')) reject('PATH_DENIED', 'Invalid apply journal path.'); journal = relative; await assert(); },
    async release() { if (retained) return; await assert(); await rm(await safePath(root, LOCK), { recursive: true }); await flushDirectory(await safePath(root, 'planning/.runtime')); },
  };
}
async function publishOwner(root: string, relative: string, owner: WriteOwnership): Promise<void> {
  const target = await safePath(root, relative);
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(stringify(owner)); await handle.sync(); } finally { await handle.close(); }
  await flushDirectory(path.dirname(target));
}
export async function withWriteLock<T>(root: string, operation: string, action: (writer: Writer) => Promise<T>, hooks: MutationHooks = {}): Promise<T> {
  const owner = await currentOwner(operation);
  await ensureDirectory(root, 'planning/.runtime');
  try { await mkdir(await safePath(root, LOCK)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') reject('APPLY_RECOVERY_REQUIRED', 'Workspace writer ownership is live, stale or uncertain; inspect it, never remove by PID alone.'); throw error; }
  await publishOwner(root, LOCK + '/owner.yaml', owner);
  await flushDirectory(await safePath(root, 'planning/.runtime'));
  await hooks.afterBoundary?.('ownership:published');
  const active = await writer(root, owner, false, hooks);
  try {
    for (const file of await listFiles(root, 'planning/changes')) if (file.endsWith('/apply-transaction.yaml')) {
      const transaction = parseYaml(await readText(root, file));
      if (!isObject(transaction) || transaction.phase !== 'completed') reject('APPLY_RECOVERY_REQUIRED', 'Unfinished durable apply blocks new managed mutations.', file);
      const applied = parseYaml(await readText(root, file.replace(/apply-transaction\.yaml$/, 'applied.yaml')));
      if (!isObject(applied) || applied.transaction_id !== transaction.transaction_id || applied.result_source_hash !== transaction.target_source_hash) reject('APPLY_RECOVERY_REQUIRED', 'Completed transaction is missing its matching applied result.', file);
      const { readTransaction } = await import('./apply');
      await readTransaction(root, file.slice('planning/changes/'.length).split('/')[0]);
    }
    return await action(active);
  } finally { await active.release(); }
}
/** B04 owns journal rebinding and write fencing after this exclusive, proven-dead claim. */
export async function withRecoveryClaim<T>(root: string, expected: WriteOwnership, action: (writer: Writer) => Promise<T>, hooks: MutationHooks = {}): Promise<T> {
  const anchor = await readOwnership(root);
  if (!anchor || canonicalJson(anchor) !== canonicalJson(expected) || await probeOwnership(anchor) !== 'dead') reject('APPLY_RECOVERY_REQUIRED', 'Original writer must be unchanged and provably dead before recovery.');
  const owner = await currentOwner('recover', anchor.anchor_nonce);
  try { await mkdir(await safePath(root, LOCK + '/recovery-claim')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') reject('APPLY_RECOVERY_REQUIRED', 'Another/partial recovery claim already exists; explicit operator recovery is required.'); throw error; }
  await publishOwner(root, LOCK + '/recovery-claim/owner.yaml', owner);
  await flushDirectory(await safePath(root, LOCK));
  await hooks.afterBoundary?.('recovery:published');
  const verified = await readOwnership(root);
  if (!verified || canonicalJson(verified) !== canonicalJson(anchor) || await probeOwnership(verified) !== 'dead') reject('APPLY_RECOVERY_REQUIRED', 'Original identity changed or cannot be proven dead.');
  const active = await writer(root, owner, true, hooks);
  try { return await action(active); } catch (error) { active.retain(); throw error; } finally { await active.release(); }
}
