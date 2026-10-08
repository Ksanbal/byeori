import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { root } from '../../scripts/release-utils.mjs';
import { verifyRelease } from '../../scripts/verify-release.mjs';
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'Byeori allowlist '));
  try { for (const name of ['plugins', '.claude-plugin', '.agents/plugins', 'LICENSE', 'THIRD_PARTY_NOTICES']) await cp(path.join(root, name), path.join(directory, name), { recursive: true }); await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test('public payload verification rejects unexpected root catalog/plugin files', () => fixture(async directory => {
  await writeFile(path.join(directory, 'plugins/unexpected-secret.json'), '{"synthetic":"not real secret"}'); await assert.rejects(verifyRelease(directory), /outside catalog\/payload allowlist/);
}));
test('public payload verification rejects absent assets and changed runtime bytes', () => fixture(async directory => {
  await writeFile(path.join(directory, 'plugins/byeori-codex/runtime/cli.mjs'), '// synthetic altered bytes'); await assert.rejects(verifyRelease(directory), /Unexpected\/missing\/changed/);
  await cp(path.join(root, 'plugins/byeori-codex/runtime/cli.mjs'), path.join(directory, 'plugins/byeori-codex/runtime/cli.mjs')); await rm(path.join(directory, 'plugins/byeori-claude/runtime/studio/index.html')); await assert.rejects(verifyRelease(directory), /Unexpected\/missing\/changed/);
}));
