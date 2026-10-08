import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest, metadata, root } from '../../scripts/release-utils.mjs';
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

test('Codex Legacy hooks manifest is selected without a competing portable root', () => fixture(async directory => {
  const plugin = path.join(directory, 'plugins/byeori-codex');
  const manifest = JSON.parse(await readFile(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.version, metadata.version); assert.equal(manifest.skills, './skills'); assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.ok(!manifest.$schema && !manifest.extensions);
  assert.deepEqual(JSON.parse(await readFile(path.join(plugin, manifest.hooks), 'utf8')), JSON.parse(await readFile(path.join(root, 'plugins/byeori-codex/hooks/hooks.json'), 'utf8')));
  await verifyRelease(directory);
  // Even a self-consistent hash inventory cannot legitimize the root that wins native precedence.
  const competing = JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'byeori' });
  await writeFile(path.join(plugin, 'plugin.json'), competing);
  const releasePath = path.join(directory, 'plugins/release-manifest.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8')); release.files['plugins/byeori-codex/plugin.json'] = digest(competing);
  await writeFile(releasePath, JSON.stringify(release));
  await assert.rejects(verifyRelease(directory), /shadow Legacy hook discovery/);
}));
