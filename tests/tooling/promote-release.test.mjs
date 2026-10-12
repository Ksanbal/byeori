import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteRelease } from '../../scripts/promote-release.mjs';

const sha = 'a'.repeat(40), old = 'b'.repeat(40), tag = 'v0.1.0-rc.2';
function fixture(overrides = {}) {
  const writes = [];
  let branch = overrides.current;
  let checks = 0;
  const api = async (path, method = 'GET', body) => {
    if (method !== 'GET') {
      writes.push({ path, method, body });
      if (overrides.race) throw new Error('GitHub rejected non-fast-forward/concurrent creation');
      branch = body.sha;
      return {};
    }
    if (path === `git/ref/tags/${tag}`) return { object: { type: 'commit', sha } };
    if (path === `releases/tags/${tag}`) return {
      tag_name: tag, draft: false, published_at: '2026-10-12T00:00:00Z',
      assets: ['byeori-0.1.0-rc.2-plugins.zip', 'byeori-0.1.0-rc.2.tgz', 'SHA256SUMS', 'VERIFICATION.md']
        .map(name => ({ name, state: 'uploaded', size: 1 })), ...overrides.release,
    };
    if (path === 'git/ref/heads/main') return { object: { sha } };
    if (path.startsWith('compare/')) return path.startsWith(`compare/${old}`)
      ? { status: 'ahead', behind_by: 0, ...overrides.ancestry }
      : { status: 'identical', behind_by: 0 };
    if (path.startsWith('actions/workflows/')) {
      checks++;
      return { workflow_runs: [{ id: 7, run_attempt: 1, head_sha: sha, head_branch: tag, event: 'push',
        path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', ...overrides.run,
        ...(checks > 1 ? overrides.freshRun : {}) }] };
    }
    if (path.startsWith('actions/runs/')) return { jobs: [{ name: 'verify', status: 'completed', conclusion: overrides.job ?? 'success' }] };
    if (path === 'git/matching-refs/heads/release') return branch ? [{ ref: 'refs/heads/release', object: { sha: branch } }] : [];
    if (path === 'git/ref/heads/release') return { object: { sha: branch } };
    throw new Error(`Unexpected API call: ${path}`);
  };
  return { api, writes };
}

test('promotion dry run never writes; apply creates exact verified commit; retry is idempotent', async () => {
  const f = fixture();
  assert.equal((await promoteRelease(tag, f)).applied, false);
  assert.equal(f.writes.length, 0);
  assert.equal((await promoteRelease(tag, { ...f, apply: true })).applied, true);
  assert.deepEqual(f.writes, [{ path: 'git/refs', method: 'POST', body: { ref: 'refs/heads/release', sha } }]);
  assert.equal((await promoteRelease(tag, { ...f, apply: true })).applied, false);
  assert.equal(f.writes.length, 1);
});

test('promotion rejects failed, pending, mismatched, skipped and superseded CI before writing', async () => {
  for (const override of [
    { run: { conclusion: 'failure' } }, { run: { status: 'in_progress' } },
    { run: { head_sha: old } }, { run: { event: 'pull_request' } },
    { run: { head_branch: 'main' } }, { run: { path: 'other.yml' } },
    { job: 'skipped' }, { freshRun: { conclusion: 'failure' } }, { freshRun: { run_attempt: 2 } },
    { release: { draft: true } }, { release: { assets: [] } },
  ]) {
    const f = fixture(override);
    await assert.rejects(promoteRelease(tag, { ...f, apply: true }));
    assert.equal(f.writes.length, 0);
  }
});

test('promotion rejects rollback/divergence and uses server-enforced fast-forward on concurrent updates', async () => {
  for (const status of ['behind', 'diverged']) {
    const f = fixture({ current: old, ancestry: { status, behind_by: 1 } });
    await assert.rejects(promoteRelease(tag, { ...f, apply: true }), /stale/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ current: old, race: true });
  await assert.rejects(promoteRelease(tag, { ...f, apply: true }), /non-fast-forward/);
  assert.deepEqual(f.writes[0].body, { sha, force: false });
  const create = fixture({ race: true });
  await assert.rejects(promoteRelease(tag, { ...create, apply: true }), /concurrent creation/);
});

test('promotion refuses non-version refs without contacting GitHub', async () => {
  for (const input of ['main', 'release', '../main', 'v1.0.0?x=y']) {
    await assert.rejects(promoteRelease(input, { api: () => assert.fail('must not query') }), /version tag/);
  }
});
