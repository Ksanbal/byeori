import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { CoreError } from '../../src/core/errors';
import { initializeWorkspace } from '../../src/core/workspace';
import { probeOwnership, readOwnership, withRecoveryClaim, withWriteLock, type Writer } from '../../src/core/ownership';
import { apply } from '../../src/core/apply';
import { roundBinding, sourceHead } from '../../src/core/review';
import { approvedScenario } from '../fixtures/approved-scenario';

async function temp(action: (root: string) => Promise<void>): Promise<void> { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori ownership-')); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function denied(action: () => Promise<unknown>): Promise<void> { await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED'); }
async function childWriter(root: string) {
  const child = fork(fileURLToPath(new URL('../fixtures/ownership-child.ts', import.meta.url)), [root], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
  const exited = once(child, 'exit');
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready: ' + errors); })]);
  return { child, exited };
}

test('real live child retains ownership after cache deletion; another writer/resume denies', { timeout: 10_000 }, async () => temp(async root => {
  const { child, exited } = await childWriter(root);
  try {
    const owner = (await readOwnership(root))!; assert.equal(await probeOwnership(owner), 'alive');
    await mkdir(path.join(root, '.byeori')); await writeFile(path.join(root, '.byeori/cache'), 'disposable'); await rm(path.join(root, '.byeori'), { recursive: true });
    await denied(() => withWriteLock(root, 'second writer', async () => {}));
    await denied(() => withRecoveryClaim(root, owner, async () => {}));
    child.send('continue'); assert.equal((await exited)[0], 0);
    assert.equal(await readFile(path.join(root, 'planning/test-progress.txt'), 'utf8'), 'after'); assert.equal(await readOwnership(root), null);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}));

test('actual killed owner allows one dead-owner claim, competing recovery denies', { timeout: 10_000 }, async () => temp(async root => {
  const { child, exited } = await childWriter(root);
  const owner = (await readOwnership(root))!;
  child.kill('SIGKILL'); await exited; assert.equal(await probeOwnership(owner), 'dead');
  await withRecoveryClaim(root, owner, async writer => {
    assert.notEqual(writer.owner.owner_nonce, owner.owner_nonce); assert.equal(writer.owner.anchor_nonce, owner.anchor_nonce);
    await denied(() => withRecoveryClaim(root, owner, async () => {}));
    await writer.write('planning/test-progress.txt', 'recovered');
  });
  assert.equal(await readFile(path.join(root, 'planning/test-progress.txt'), 'utf8'), 'recovered'); assert.equal(await readOwnership(root), null);
}));

test('partial anchors and ownership-loss fencing fail closed before further writes', async () => temp(async root => {
  const lock = path.join(root, 'planning/.runtime/write-lock'); await mkdir(lock);
  await denied(() => readOwnership(root)); await denied(() => withWriteLock(root, 'partial', async () => {})); await rm(lock, { recursive: true });
  await denied(() => withWriteLock(root, 'lost owner', async writer => {
    await writer.write('planning/test-progress.txt', 'original');
    await writeFile(path.join(lock, 'owner.yaml'), stringify({ ...writer.owner, owner_nonce: 'changed-owner' }));
    await writer.write('planning/test-progress.txt', 'must-not-write');
  }));
  assert.equal(await readFile(path.join(root, 'planning/test-progress.txt'), 'utf8'), 'original');
}));

test('PID reuse/start mismatch and missing identity stay uncertain and cannot claim a live anchor', async () => temp(async root => {
  await withWriteLock(root, 'identity test', async writer => {
    const mismatched = { ...writer.owner, process: { ...writer.owner.process, start_identity: 'different-start' } };
    assert.equal(await probeOwnership(mismatched), 'unknown');
    assert.equal(await probeOwnership({ ...writer.owner, process: { ...writer.owner.process, start_identity: '' } }), 'unknown');
    await denied(() => withRecoveryClaim(root, mismatched, async () => {}));
    await writer.write('planning/test-progress.txt', 'original still owns writes');
  });
}));

test('expired writer continuation cannot write after an actual newer applied change', async () => temp(async root => {
  const first = await approvedScenario(root); await apply(root, roundBinding(first.round)); let old: Writer | null = null;
  await withWriteLock(root, 'prior managed invocation', async writer => { old = writer; });
  const newer = await approvedScenario(root, true); await apply(root, roundBinding(newer.round)); const before = await sourceHead(root);
  await denied(() => old!.write('planning/source/prd.yaml', 'expired invocation must not overwrite newer source'));
  assert.equal((await sourceHead(root)).hash, before.hash); assert.equal(before.change_id, newer.change.change_id);
}));
