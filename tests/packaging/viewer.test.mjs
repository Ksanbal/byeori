import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashes, root } from '../../scripts/release-utils.mjs';

async function launch(entry, project) {
  const child = spawn(process.execPath, [entry, '--root', project, '--port', '0'], {
    cwd: project, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged viewer start timed out: ' + stderr)); }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Packaged viewer exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const found = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (found) { clearTimeout(timeout); resolve(found[0]); }
    });
  });
  return { url, child };
}

test('both relocated Node-only viewers serve bundled Kumo assets without project writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'Byeori relocated viewer 한글 '));
  try {
    for (const host of ['claude', 'codex']) {
      const plugin = path.join(directory, host + ' plugin');
      const project = path.join(directory, host + ' non-Node project');
      await cp(path.join(root, 'plugins/byeori-' + host), plugin, { recursive: true });
      await mkdir(path.join(project, 'planning/source'), { recursive: true });
      await cp(path.join(root, 'tests/fixtures/planning'), path.join(project, 'planning/source'), { recursive: true });
      const before = await hashes(project);
      const beforeEntries = (await readdir(project, { recursive: true })).sort();
      const { child, url } = await launch(path.join(plugin, 'runtime/viewer.mjs'), project);
      try {
        const home = await fetch(url);
        assert.equal(home.status, 200);
        const html = await home.text();
        assert.match(html, /src="\/app\.js"/);
        assert.match(html, /href="\/app\.css"/);
        assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i);
        assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
        const js = await fetch(url + '/app.js'), css = await fetch(url + '/app.css');
        assert.equal(js.status, 200); assert.equal(css.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);
        const stylesheet = await css.text();
        assert.match(stylesheet, /--color-kumo-/);
        assert.doesNotMatch(stylesheet, /@import\s|url\(["']?https?:/i);
        const catalog = await fetch(url + '/api/catalog').then(response => response.json());
        assert.equal(catalog.mode, 'read-only'); assert.equal(catalog.provenance, 'source');
        assert.equal(catalog.documents.length, 9);
        assert.equal(catalog.selected_source.id, 'source');
        assert.equal(catalog.invalid_documents.length, 0);
        assert.ok(catalog.documents.every(document => document.provenance === 'source'));
        assert.equal((await fetch(url + '/api/catalog', { method: 'POST', body: '{}' })).status, 405);
        assert.equal((await fetch(url + '/api/review/submit', { method: 'POST', body: '{}' })).status, 405);
        assert.equal((await fetch(url + '/api/catalog', { headers: { Origin: 'https://example.invalid' } })).status, 403);
        assert.equal((await fetch(url + '/planning/source/prd.yaml')).status, 404);
      } finally {
        const exit = once(child, 'exit'); child.kill('SIGTERM');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { const [code, signal] = await exit; assert.equal(code, 0, `Viewer stopped with ${signal}`); }
        finally { clearTimeout(timeout); }
      }
      assert.deepEqual(await hashes(project), before, 'Reading must leave every selected-project byte unchanged');
      assert.deepEqual((await readdir(project, { recursive: true })).sort(), beforeEntries, 'Reading cannot create even empty cache, index or lock directories');
      await assert.rejects(readFile(path.join(project, 'package.json')));
      await assert.rejects(readFile(path.join(plugin, 'node_modules/package.json')));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bundled viewer provenance includes real Kumo, React, icons and embedded stylesheet licenses', async () => {
  const runtime = path.join(root, 'plugins/byeori-claude/runtime');
  const release = JSON.parse(await readFile(path.join(runtime, 'release.json'), 'utf8'));
  for (const name of ['@cloudflare/kumo', '@phosphor-icons/react', 'react', 'react-dom', 'tailwindcss', '@base-ui/react', '@base-ui/utils', '@floating-ui/core', '@floating-ui/dom', '@floating-ui/react-dom', '@floating-ui/utils', 'cnfast']) {
    const dependency = release.dependencies.find(dependency => dependency.name === name);
    assert.ok(dependency, 'Missing bundled dependency/license: ' + name);
    const slug = name.replaceAll('/', '__').replaceAll('@', '') + '-' + dependency.version;
    const license = await readFile(path.join(runtime, 'licenses', slug + '-LICENSE'), 'utf8');
    assert.match(license, /copyright|permission/i);

  }
  const input = JSON.parse(await readFile(path.join(root, 'artifacts/release-staging/bundle-inputs.json'), 'utf8'));
  assert.ok(input.runtime_module_ids.some(id => /@cloudflare\/kumo\/dist\//.test(id)));
  const server = Object.entries(input.runtime.outputs).find(([name]) => name.endsWith('/viewer.mjs'))[1];
  for (const id of Object.keys(server.inputs)) assert.doesNotMatch(id, /src\/(?:terminal|studio|adapters)\/|src\/core\/(?:review|workspace|apply|ownership|store)\.ts$/, 'Viewer cannot depend on mutation or approval services');
});
