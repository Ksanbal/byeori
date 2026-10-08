import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import type { ReviewBinding } from '../../src/contracts';
import { recover, journalPath } from '../../src/core/apply';
import { CoreError } from '../../src/core/errors';
import { probeOwnership, readOwnership } from '../../src/core/ownership';
import { roundBinding, sourceHead, submitReview } from '../../src/core/review';
import { readApprovedSource, status } from '../../src/core/state';
import { createChange, initializeWorkspace } from '../../src/core/workspace';
import { parseYaml } from '../../src/core/yaml';
import { approvedDeletionMove, approvedScenario } from '../fixtures/approved-scenario';

async function temp(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'byeori crash-')); try { await initializeWorkspace(root); await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function deny(action: () => Promise<unknown>) { await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED'); }
async function childAt(root: string, binding: ReviewBinding, boundary: string, occurrence = 1, action = 'apply') {
  const child = fork(fileURLToPath(new URL('../fixtures/apply-child.ts', import.meta.url)), [root, Buffer.from(JSON.stringify(binding)).toString('base64url'), boundary, String(occurrence), action], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stderr = ''; child.stderr?.on('data', value => { stderr += String(value); }); const exited = once(child, 'exit');
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Exited before ' + boundary + ': ' + stderr); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('No boundary: ' + boundary + ' ' + stderr)), 15_000); timer.unref(); })]);
  return { child, exited };
}
async function stop(value: Awaited<ReturnType<typeof childAt>>) { if (value.child.exitCode === null && value.child.signalCode === null) { value.child.kill('SIGKILL'); await value.exited; } }

test('actual apply child pauses after source write; cache deletion never permits takeover; original continues', { timeout: 20_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'write:planning/source/actor.yaml');
  try {
    const owner = (await readOwnership(root))!; assert.equal(await probeOwnership(owner), 'alive'); await mkdir(path.join(root, '.byeori')); await writeFile(path.join(root, '.byeori/cache'), 'delete me'); await rm(path.join(root, '.byeori'), { recursive: true });
    await deny(() => readApprovedSource(root)); await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' })); await deny(() => createChange(root, { ...scenario.binding, metadata: scenario.change.metadata }));
    assert.equal((await status(root)).source_integrity.state, 'recovery_required');
    value.child.send('continue'); assert.equal((await value.exited)[0], 0); assert.equal((await sourceHead(root)).manifest.entries.length, 2); assert.equal(await readOwnership(root), null); assert.equal((await submitReview(root, scenario.submission)).replayed, true);
  } finally { await stop(value); }
}));

test('kill real partial apply writer; exclusive dead-owner recovery denies competing resume', { timeout: 20_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'write:planning/source/actor.yaml'); await stop(value);
  assert.equal(await probeOwnership((await readOwnership(root))!), 'dead');
  let competed = false; const result = await recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' }, { async afterBoundary(boundary) { if (boundary === 'recovery:published') { competed = true; await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' })); } } });
  assert.ok(competed); assert.equal(result.transaction!.phase, 'completed'); assert.equal((await sourceHead(root)).hash, scenario.round.manifest.target_source_hash); assert.equal(await readOwnership(root), null);
}));

test('third-party edit prevents resume and is never overwritten; partial claim/missing anchor deny', { timeout: 20_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'write:planning/source/actor.yaml'); await stop(value);
  const user = 'title: user-owned unrelated content\n'; await writeFile(path.join(root, 'planning/source/prd.yaml'), user);
  const inspection = await recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'inspect' }); assert.deepEqual(inspection.conflicts, ['planning/source/prd.yaml']); await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' })); assert.equal(await readFile(path.join(root, 'planning/source/prd.yaml'), 'utf8'), user);
  await rm(path.join(root, 'planning/source/prd.yaml')); await mkdir(path.join(root, 'planning/.runtime/write-lock/recovery-claim')); await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' }));
  await rm(path.join(root, 'planning/.runtime/write-lock'), { recursive: true }); await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' }));
}));

test('journal ownership loss stops the paused old invocation before any further write', { timeout: 20_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'write:planning/source/actor.yaml');
  try { const file = journalPath(scenario.change.change_id); const journal = parseYaml(await readFile(path.join(root, file), 'utf8')) as { owner: { owner_nonce: string } }; journal.owner.owner_nonce = 'new-owner'; await writeFile(path.join(root, file), stringify(journal)); value.child.send('continue'); assert.equal((await value.exited)[0], 1); await assert.rejects(() => readFile(path.join(root, 'planning/source/prd.yaml')), { code: 'ENOENT' }); assert.ok((await readFile(path.join(root, 'planning/source/actor.yaml'), 'utf8')).includes('ACT-WORKER-001')); }
  finally { await stop(value); }
}));

test('bounded actual crash matrix recovers each durable apply stage without duplicate receipt/result', { timeout: 120_000 }, async () => {
  for (const stage of ['apply:journal-ready', 'journal:writing', 'journal:actor-progress', 'journal:prd-progress', 'temporary:planning/source/actor.yaml', 'write:planning/source/actor.yaml', 'apply:target-verified', 'applied:temporary', 'apply:applied-durable', 'apply:completed', 'cache:refresh']) await temp(async root => {
    const scenario = await approvedScenario(root); const point = stage === 'applied:temporary' ? 'temporary:' + 'planning/changes/' + scenario.change.change_id + '/applied.yaml' : stage.startsWith('journal:') ? 'write:' + journalPath(scenario.change.change_id) : stage;
    const occurrence = stage === 'journal:writing' ? 2 : stage === 'journal:actor-progress' ? 3 : stage === 'journal:prd-progress' ? 4 : 1;
    const value = await childAt(root, roundBinding(scenario.round), point, occurrence); await stop(value); await rm(path.join(root, '.byeori'), { recursive: true, force: true });
    const result = await recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' }); assert.equal(result.transaction!.phase, 'completed', stage); assert.equal((await sourceHead(root)).hash, scenario.round.manifest.target_source_hash, stage); assert.equal((await submitReview(root, scenario.submission)).replayed, true, stage); assert.equal(await readOwnership(root), null, stage);
  });
});

test('actual delete/move crashes resume from explicit absent and before/after path states', { timeout: 60_000 }, async () => {
  for (const stage of ['delete:planning/source/actor.yaml', 'temporary:planning/source/nested/moved.yaml', 'write:planning/source/nested/moved.yaml', 'delete:planning/source/prd.yaml']) await temp(async root => {
    const scenario = await approvedDeletionMove(root); const value = await childAt(root, roundBinding(scenario.round), stage); await stop(value); const result = await recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' }); assert.equal(result.transaction!.phase, 'completed'); const head = await sourceHead(root); assert.equal(head.manifest.entries.length, 1); assert.equal(head.manifest.entries[0].path, 'planning/source/nested/moved.yaml');
  });
});

test('edit between staging and atomic replacement denies overwrite; a crashed recovery claim is never auto-reclaimed', { timeout: 30_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'temporary:planning/source/prd.yaml');
  try { await writeFile(path.join(root, 'planning/source/prd.yaml'), 'external user edit\n'); value.child.send('continue'); assert.equal((await value.exited)[0], 1); assert.equal(await readFile(path.join(root, 'planning/source/prd.yaml'), 'utf8'), 'external user edit\n'); }
  finally { await stop(value); }
  await rm(path.join(root, 'planning/source/prd.yaml')); const claimant = await childAt(root, roundBinding(scenario.round), 'recovery:published', 1, 'recover'); await stop(claimant);
  await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' }));
}));

test('prepared journal temporary crash retains partial evidence and refuses guessed recovery', { timeout: 20_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'temporary:' + journalPath(scenario.change.change_id)); await stop(value); await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' })); assert.equal((await sourceHead(root)).manifest.entries.length, 0);
}));

test('ownership publication crash without journal fails closed, never imports source', { timeout: 20_000 }, async () => temp(async root => {
  const scenario = await approvedScenario(root); const value = await childAt(root, roundBinding(scenario.round), 'ownership:published'); await stop(value); await deny(() => recover(root, { ...scenario.binding, change_id: scenario.change.change_id, action: 'resume' })); assert.equal((await sourceHead(root)).manifest.entries.length, 0);
}));
