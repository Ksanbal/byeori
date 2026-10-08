import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hooksConfig } from '../src/adapters/config.ts';
import { root, metadata, payloads, files, hashes, digest } from './release-utils.mjs';
export async function verifyRelease(directory = root) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'plugins/release-manifest.json'), 'utf8'));
  assert.equal(manifest.version, metadata.version);
  const actual = {};
  for (const payload of payloads) for (const [file, hash] of Object.entries(await hashes(path.join(directory, payload)))) actual[payload + '/' + file] = hash;
  for (const file of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'LICENSE', 'THIRD_PARTY_NOTICES']) actual[file] = digest(await readFile(path.join(directory, file)));
  assert.deepEqual(actual, manifest.files, 'Unexpected/missing/changed public payload file');
  const expectedPaths = [...Object.keys(manifest.files), 'plugins/release-manifest.json'].sort();
  const managedPaths = [];
  for (const scope of ['plugins', '.claude-plugin', '.agents/plugins']) for (const file of await files(path.join(directory, scope))) managedPaths.push(scope + '/' + file);
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES']) managedPaths.push(name);
  assert.deepEqual(managedPaths.sort(), expectedPaths, 'Unexpected file outside catalog/payload allowlist');
  assert.deepEqual(await hashes(path.join(directory, payloads[0], 'runtime')), await hashes(path.join(directory, payloads[1], 'runtime')), 'Host runtime bytes diverge');
  const forbidden = /(?:^|\/)(?:\.delivery|\.inputs|node_modules|planning|\.env|\.DS_Store)(?:\/|$)|\.map$|(?:token|cookie|profile|input-pack)\.(?:json|zip)$/i;
  for (const file of Object.keys(actual)) {
    assert.ok(!forbidden.test(file), 'Private/unexpected path: ' + file);
    const data = await readFile(path.join(directory, file));
    if (/\.(?:mjs|js|css|json|md)$/.test(file)) {
      const text = data.toString('utf8');
      assert.ok(!/(?:\/Users\/|\/home\/|\.delivery\/|\.inputs\/|sourceMappingURL=|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/.test(text), 'Private/developer/source-map content: ' + file);
      assert.ok(!/\{\{[^}]+\}\}/.test(text), 'Unrendered slot: ' + file);
    }
  }
  const claude = JSON.parse(await readFile(path.join(directory, '.claude-plugin/marketplace.json'))), codex = JSON.parse(await readFile(path.join(directory, '.agents/plugins/marketplace.json')));
  assert.equal(claude.plugins[0].source, './' + payloads[0]); assert.equal(codex.plugins[0].source.path, './' + payloads[1]);
  for (const [index, payload] of payloads.entries()) {
    const host = index === 0 ? 'claude' : 'codex', plugin = path.join(directory, payload);
    const pluginManifest = JSON.parse(await readFile(path.join(plugin, host === 'claude' ? '.claude-plugin/plugin.json' : 'plugin.json')));
    assert.equal(pluginManifest.version, metadata.version); assert.equal(pluginManifest.name, 'byeori'); assert.equal(pluginManifest.license, 'MIT');
    assert.deepEqual(JSON.parse(await readFile(path.join(plugin, 'hooks/hooks.json'))), hooksConfig(host));
    assert.deepEqual(await hashes(path.join(plugin, 'runtime/schemas')), await hashes(path.join(root, 'schemas')));
    for (const common of ['init', 'start', 'change', 'review']) {
      const name = host === 'claude' ? common : 'byeori-' + common, skill = path.join(plugin, 'skills', name), source = await readFile(path.join(skill, 'SKILL.md'), 'utf8');
      assert.equal(source, (await readFile(path.join(root, 'skills-src', common + '.md'), 'utf8')).replace('{{SKILL_NAME}}', name));
      assert.deepEqual(await hashes(path.join(skill, 'references')), await hashes(path.join(root, 'skills-src/references')));
      for (const markdown of ['SKILL.md', ...await files(path.join(skill, 'references')) .then(list => list.filter(file => file.endsWith('.md')).map(file => 'references/' + file))]) {
        const text = await readFile(path.join(skill, markdown), 'utf8');
        for (const match of text.matchAll(/\]\(([^)]+)\)/g)) if (!/^(?:https?:|#)/.test(match[1])) await readFile(path.resolve(skill, path.dirname(markdown), match[1]));
      }
    }
  }
  console.log(JSON.stringify({ verified_files: Object.keys(actual).length, version: metadata.version, runtime_identity: true, native_claim: false }));
  return manifest;
}
if (import.meta.main) {
await verifyRelease();
if (process.argv.includes('--archives')) {
  const destination = path.join(root, 'artifacts/release'), sums = await readFile(path.join(destination, 'SHA256SUMS'), 'utf8');
  for (const line of sums.trim().split('\n')) { const [hash, name] = line.split('  '); assert.equal(digest(await readFile(path.join(destination, name))), hash); }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'Byeori archive readback 한글 '));
  try {
    execFileSync('unzip', ['-q', path.join(destination, `byeori-${metadata.version}-plugins.zip`), '-d', directory]);
    await verifyRelease(directory);
    const listed = [...Object.keys(JSON.parse(await readFile(path.join(directory, 'plugins/release-manifest.json'))).files), 'plugins/release-manifest.json'].sort();
    assert.deepEqual(await files(directory), listed, 'Unexpected archive member');
    execFileSync('tar', ['-xzf', path.join(destination, `byeori-${metadata.version}.tgz`), '-C', directory]);
    const packedHashes = await hashes(path.join(directory, 'package')), stagedHashes = await hashes(path.join(root, 'artifacts/release-staging/cli-package'));
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'package/package.json'))), JSON.parse(await readFile(path.join(root, 'artifacts/release-staging/cli-package/package.json'))), 'Packed manifest semantics changed');
    delete packedHashes['package.json']; delete stagedHashes['package.json'];
    assert.deepEqual(packedHashes, stagedHashes, 'Unexpected/modified tarball member');
    const packed = JSON.parse(await readFile(path.join(directory, 'package/package.json'))); assert.equal(packed.version, metadata.version); assert.equal(packed.bin.byeori, 'runtime/cli.mjs');
    assert.ok(!packed.dependencies && !packed.devDependencies && !packed.scripts && !packed.packageManager, 'Consumer package must not fetch or build dependencies');
    assert.deepEqual(await hashes(path.join(directory, 'package/runtime')), await hashes(path.join(root, payloads[0], 'runtime')));
    const project = path.join(directory, 'tarball non-Node project'); await mkdir(project);
    const cli = path.join(directory, 'package/runtime/cli.mjs');
    const invoke = args => { const start = new Date().toISOString(); const argv = [cli, ...args, '--root', project, '--json']; const output = execFileSync(process.execPath, argv, { cwd: project, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8' }); console.log(JSON.stringify({ command: process.execPath, args: argv, cwd: project, start, end: new Date().toISOString(), exit: 0 })); const result = JSON.parse(output); assert.ok(result.ok, output); assert.equal(result.meta.runtime_version, metadata.version); return result.data; };
    invoke(['--help']); invoke(['init']); assert.ok(invoke(['doctor']).sqlite.fts5_probed); invoke(['search', '--query', 'absent-in-clean-source']);
    let running = false; try { const started = invoke(['studio', '--action', 'start']); running = true; assert.equal(started.state, 'running'); assert.ok(started.url.startsWith('http://127.0.0.1:')); assert.equal(invoke(['studio', '--action', 'status']).runtime_id, started.runtime_id); } finally { if (running) invoke(['studio', '--action', 'stop']); }
    console.log(JSON.stringify({ tarball_clean_runtime_executed: true, registry_dependencies: false, native_claim: false }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

}
