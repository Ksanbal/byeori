import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import type { ChangeMetadata, WriteOwnership } from '../../src/contracts';
import { apply } from '../../src/core/apply';
import { CoreError } from '../../src/core/errors';
import { withWriteLock } from '../../src/core/ownership';
import { prepareReview, reviewResults, roundBinding, saveReviewDraft } from '../../src/core/review';
import { initializeWorkspace } from '../../src/core/workspace';
import { parseYaml } from '../../src/core/yaml';
import { approvedScenario } from '../fixtures/approved-scenario';

async function temp(action: (root: string, outside: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori-review-regression-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'byeori-external-regression-'));
  try { await initializeWorkspace(root); await action(root, outside); }
  finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
}
async function pathDenied(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === 'PATH_DENIED');
}

test('snapshot create resolves destination after before-mutation parent symlink swap', async () => temp(async (root, outside) => {
  const scenario = await approvedScenario(root); let swapped = false;
  await pathDenied(() => prepareReview(root, { ...scenario.binding, change_id: scenario.change.change_id, expected_version: scenario.change.version }, {
    async beforeMutation(relative) {
      if (!relative.endsWith('/rounds/2/after/actor.yaml')) return;
      swapped = true; const directory = path.dirname(path.join(root, relative));
      await rename(directory, directory + '-original'); await symlink(outside, directory, 'dir');
    },
  }));
  assert.equal(swapped, true);
  await assert.rejects(() => readFile(path.join(outside, 'actor.yaml')), { code: 'ENOENT' });
}));

for (const operation of ['replace', 'delete'] as const) test(`shared writer ${operation} preserves external bytes after before-mutation parent symlink swap`, async () => temp(async (root, outside) => {
  const relative = 'planning/swap-target/victim.yaml'; const directory = path.dirname(path.join(root, relative));
  const insideBytes = Buffer.from('Original managed bytes\r\n'); const outsideBytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 255, 10, 13]);
  await mkdir(directory); await writeFile(path.join(directory, 'victim.yaml'), insideBytes); await writeFile(path.join(outside, 'victim.yaml'), outsideBytes);
  let swapped = false;
  await pathDenied(() => withWriteLock(root, 'destination regression', async writer => {
    if (operation === 'replace') await writer.write(relative, 'Replacement must stay inside'); else await writer.remove(relative);
  }, {
    async beforeMutation(target) {
      if (target !== relative) return;
      swapped = true; await rename(directory, directory + '-original'); await symlink(outside, directory, 'dir');
    },
  }));
  assert.equal(swapped, true);
  assert.deepEqual(await readFile(path.join(outside, 'victim.yaml')), outsideBytes);
  assert.deepEqual(await readFile(path.join(directory + '-original', 'victim.yaml')), insideBytes);
}));

test('applied review results invalidate semantic metadata drift while preserving frozen receipt and format-only equality', async () => temp(async root => {
  const scenario = await approvedScenario(root, true); const binding = roundBinding(scenario.round); await apply(root, binding);
  const file = path.join(root, 'planning/changes', scenario.change.change_id, 'change.yaml');
  const original = parseYaml(await readFile(file, 'utf8')) as unknown as { metadata: ChangeMetadata };
  const baseline = await reviewResults(root, binding); assert.equal(baseline.approval.implementation_allowed, true);
  const mutations: Array<[string, (metadata: ChangeMetadata) => void]> = [
    ['reason', metadata => { metadata.reason = 'Unreviewed reason'; }],
    ['scope', metadata => { metadata.implementation_scope.allowlist = [{ path: 'other', match: 'directory' }]; }],
    ['type', metadata => { metadata.type = 'implementation_only'; }],
    ['request', metadata => { metadata.request = 'Unreviewed request'; }],
    ['title', metadata => { metadata.title = 'Unreviewed title'; }],
    ['affected IDs', metadata => { metadata.affected_object_ids = ['ACT-WORKER-001']; }],
    ['related IDs', metadata => { metadata.implementation_scope.related_object_ids = ['ACT-WORKER-001']; }],
    ['validation plan', metadata => { metadata.implementation_scope.validation_plan = ['Unreviewed validation']; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(original); mutate(changed.metadata); await writeFile(file, stringify(changed));
    const stale = await reviewResults(root, binding);
    assert.equal(stale.approval.documents_approved, false, label); assert.equal(stale.approval.implementation_allowed, false, label);
    assert.ok(stale.approval.blockers.some(blocker => blocker.code === 'STALE_REVIEW'), label);
    assert.deepEqual(stale.accepted_submission, baseline.accepted_submission, label); assert.deepEqual(stale.round.manifest.metadata, baseline.round.manifest.metadata, label);
  }
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  await writeFile(file, '# Formatting and mapping order only\r\n' + stringify(reordered).replaceAll('\n', '\r\n'));
  const compatible = await reviewResults(root, binding);
  assert.equal(compatible.approval.documents_approved, true); assert.equal(compatible.approval.implementation_allowed, true); assert.deepEqual(compatible.approval.blockers, []);
  assert.deepEqual(compatible.accepted_submission, baseline.accepted_submission);
}));

async function pendingFeedback(root: string) {
  const scenario = await approvedScenario(root);
  const round = await prepareReview(root, { ...scenario.binding, change_id: scenario.change.change_id, expected_version: scenario.change.version });
  return { ...roundBinding(round), expected_version: null, items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } };
}

test('review waits for observed transient partial publication and then acquires its own normal lock', { timeout: 10_000 }, async () => temp(async root => {
  const input = await pendingFeedback(root); const ownerPath = path.join(root, 'planning/.runtime/write-lock/owner.yaml');
  let partialReady!: () => void; const ready = new Promise<void>(resolve => { partialReady = resolve; });
  let partialObserved!: () => void; const observed = new Promise<void>(resolve => { partialObserved = resolve; });
  let priorNonce = ''; let newNonce = ''; let waits = 0;
  // Real ownership identity; the missing owner publication is a deterministic filesystem fault.
  const contender = withWriteLock(root, 'review autosave', async writer => {
    priorNonce = writer.owner.owner_nonce; const raw = await readFile(ownerPath, 'utf8');
    await rm(ownerPath); partialReady(); await observed; await writeFile(ownerPath, raw);
  });
  await ready;
  const saved = await saveReviewDraft(root, input, {
    async afterBoundary(boundary) {
      if (boundary === 'review:ownership-pending') { waits++; partialObserved(); await contender; }
      if (boundary === 'ownership:published') newNonce = (parseYaml(await readFile(ownerPath, 'utf8')) as unknown as WriteOwnership).owner_nonce;
    },
  });
  await contender; assert.equal(waits, 1); assert.ok(newNonce); assert.notEqual(newNonce, priorNonce); assert.equal(saved.round, input.round);
  await assert.rejects(() => lstat(path.dirname(ownerPath)), { code: 'ENOENT' });
}));

test('review bounded wait leaves persistent partial and uncertain ownership untouched', { timeout: 10_000 }, async () => temp(async root => {
  const input = await pendingFeedback(root); const directory = path.join(root, 'planning/.runtime/write-lock');
  let observedOwner!: WriteOwnership;
  await withWriteLock(root, 'review autosave', async writer => { observedOwner = writer.owner; });
  await mkdir(directory); let waits = 0;
  await assert.rejects(() => saveReviewDraft(root, input, { async afterBoundary(boundary) { if (boundary === 'review:ownership-pending') waits++; } }), error => error instanceof CoreError && error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED');
  assert.ok(waits > 1 && waits < 100); assert.equal((await lstat(directory)).isDirectory(), true);
  await assert.rejects(() => readFile(path.join(directory, 'owner.yaml')), { code: 'ENOENT' });
  const uncertain = stringify({ ...observedOwner, process: { ...observedOwner.process, start_identity: 'uncertain-start' } });
  await writeFile(path.join(directory, 'owner.yaml'), uncertain);
  await assert.rejects(() => saveReviewDraft(root, input), error => error instanceof CoreError && error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED');
  assert.equal(await readFile(path.join(directory, 'owner.yaml'), 'utf8'), uncertain);
}));
