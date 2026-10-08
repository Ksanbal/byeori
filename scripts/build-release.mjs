import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { build } from 'esbuild';
import { build as buildStudio } from 'vite';
import { hooksConfig } from '../src/adapters/config.ts';
import { root, metadata, payloads, files, hashes, json, digest } from './release-utils.mjs';

const staging = path.join(root, 'artifacts/release-staging');
await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
const runtime = path.join(staging, 'runtime'); await mkdir(runtime);
const bundled = await build({
  absWorkingDir: root, entryPoints: { cli: 'src/cli/main.ts', worker: 'src/server/worker.ts', hook: 'src/adapters/hook-entry.ts' },
  outdir: runtime, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24',
  sourcemap: false, minify: true, legalComments: 'none', metafile: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
for (const output of Object.values(bundled.metafile.outputs)) for (const item of output.imports) if (item.external && !isBuiltin(item.path)) throw new Error('Unbundled consumer dependency: ' + item.path);
const moduleIds = new Set(Object.values(bundled.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, item]) => item.bytesInOutput > 0).map(([id]) => id)));
await buildStudio({ root: path.join(root, 'src/studio'), configFile: path.join(root, 'vite.config.ts'), build: { sourcemap: false }, plugins: [{ name: 'byeori-license-inputs', generateBundle(_options, bundle) { for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const [id, rendered] of Object.entries(chunk.modules)) if (rendered.renderedLength > 0) moduleIds.add(id); } }] });
await cp(path.join(root, 'dist/studio'), path.join(runtime, 'studio'), { recursive: true });
await cp(path.join(root, 'schemas'), path.join(runtime, 'schemas'), { recursive: true });
// CSS transforms and copied shadcn component source have license obligations beyond JS module IDs.
for (const name of ['tw-animate-css', 'tailwindcss', 'shadcn']) moduleIds.add(path.join(root, 'node_modules', name, 'package.json'));
await json(path.join(staging, 'bundle-inputs.json'), { runtime: bundled.metafile, studio_module_ids: [...moduleIds].sort() });
const vendors = new Map();
for (const id of [...moduleIds].sort()) {
  if (!id.includes('node_modules/')) continue;
  let directory = path.dirname(path.resolve(root, id.split('?')[0]));
  while (directory !== path.dirname(directory)) {
    try {
      const data = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (data.name && data.version && data.name !== metadata.name) {
        const key = data.name + '@' + data.version;
        if (!vendors.has(key)) {
          const licenseFiles = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(?:\.|$)/i.test(name));
          const supplement = path.join(root, 'scripts/vendor-licenses', data.name.replaceAll('/', '__') + '-' + data.version);
          if (!licenseFiles.length) {
            const provenance = JSON.parse(await readFile(path.join(supplement, 'source.json'), 'utf8'));
            const text = await readFile(path.join(supplement, 'LICENSE'));
            if (provenance.package !== data.name || provenance.version !== data.version || digest(text) !== provenance.sha256) throw new Error('Invalid vendored license provenance: ' + key);
            vendors.set(key, { name: data.name, version: data.version, license: data.license, licenses: [{ filename: 'LICENSE', text: text.toString('utf8') }, { filename: 'source.json', text: JSON.stringify(provenance, null, 2) + '\n' }] });
            break;
          }
          const licenses = [];
          for (const filename of licenseFiles.sort()) if ((await stat(path.join(directory, filename))).isFile()) licenses.push({ filename, text: await readFile(path.join(directory, filename), 'utf8') });
          vendors.set(key, { name: data.name, version: data.version, license: data.license, licenses });
        }
        break;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
}
const vendorList = [...vendors.values()].sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version, 'en'));
let notices = 'Byeori third-party notices\n\nBundled runtime and Studio dependencies retain their original licenses.\nThe inventory includes emitted CSS and shadcn-derived component attribution.\n\n';
await mkdir(path.join(runtime, 'licenses'));
for (const vendor of vendorList) {
  const slug = vendor.name.replaceAll('/', '__').replaceAll('@', '') + '-' + vendor.version;
  notices += `${vendor.name}@${vendor.version} — ${vendor.license}\n`;
  for (const license of vendor.licenses) { const target = slug + '-' + license.filename; await writeFile(path.join(runtime, 'licenses', target), license.text); notices += `  runtime/licenses/${target}\n`; }
}
notices += '\nreact-remove-scroll-bar@2.3.8 declares MIT but its npm tarball omits LICENSE. Its declared npm gitHead is unavailable upstream; the actual official repository MIT text is pinned and preserved with commit/checksum in runtime/licenses/react-remove-scroll-bar-2.3.8-source.json. This does not claim release-commit correspondence.\n';
notices += '\nOffline OpenAPI schema resources and adapted structural schema: Apache-2.0.\nSee runtime/schemas/vendor/openapi/LICENSE and README.md for pinned source, checksums and modifications.\n';
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES'), notices);
await writeFile(path.join(runtime, 'THIRD_PARTY_NOTICES'), notices);
await cp(path.join(root, 'LICENSE'), path.join(runtime, 'LICENSE'));
await json(path.join(runtime, 'release.json'), { version: metadata.version, node: metadata.engines.node, dependencies: vendorList.map(({ name, version, license }) => ({ name, version, license })) });
const description = 'Human-reviewed planning for AI development.';
for (const [index, destination] of payloads.entries()) {
  const host = index === 0 ? 'claude' : 'codex', plugin = path.join(root, destination);
  await rm(plugin, { recursive: true, force: true }); await mkdir(plugin, { recursive: true });
  await cp(runtime, path.join(plugin, 'runtime'), { recursive: true });
  await cp(path.join(root, 'LICENSE'), path.join(plugin, 'LICENSE')); await cp(path.join(root, 'THIRD_PARTY_NOTICES'), path.join(plugin, 'THIRD_PARTY_NOTICES'));
  const manifest = { name: 'byeori', version: metadata.version, description, author: { name: 'Ksanbal' }, license: 'MIT' };
  // Codex 0.161 loads hooks only through Legacy; a schema-bearing root manifest shadows it.
  if (host === 'codex') Object.assign(manifest, { skills: './skills', hooks: './hooks/hooks.json', interface: { displayName: 'Byeori · 벼리', shortDescription: 'Human-reviewed planning' } });
  await json(path.join(plugin, host === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json'), manifest);
  await json(path.join(plugin, 'hooks/hooks.json'), hooksConfig(host));
  for (const common of ['init', 'start', 'change', 'review']) {
    const name = host === 'claude' ? common : 'byeori-' + common;
    const source = await readFile(path.join(root, 'skills-src', common + '.md'), 'utf8');
    if ((source.match(/\{\{[^}]+\}\}/g) ?? []).join() !== '{{SKILL_NAME}}') throw new Error('Unexpected skill substitution contract');
    const directory = path.join(plugin, 'skills', name); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), source.replace('{{SKILL_NAME}}', name));
    await cp(path.join(root, 'skills-src/references'), path.join(directory, 'references'), { recursive: true });
  }
}
await json(path.join(root, '.claude-plugin/marketplace.json'), { name: 'byeori-plugins', owner: { name: 'Ksanbal' }, metadata: { description }, plugins: [{ name: 'byeori', source: './plugins/byeori-claude', description }] });
await json(path.join(root, '.agents/plugins/marketplace.json'), { name: 'byeori-plugins', plugins: [{ name: 'byeori', source: { source: 'local', path: './plugins/byeori-codex' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
const cliStage = path.join(staging, 'cli-package'); await mkdir(cliStage);
await cp(runtime, path.join(cliStage, 'runtime'), { recursive: true });
for (const name of ['src', 'skills-src', 'schemas']) await cp(path.join(root, name), path.join(cliStage, name), { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES']) await cp(path.join(root, name), path.join(cliStage, name));
await json(path.join(cliStage, 'package.json'), { name: 'byeori', version: metadata.version, type: 'module', description, license: 'MIT', author: 'Ksanbal', engines: metadata.engines, bin: { byeori: 'runtime/cli.mjs' }, files: ['runtime/', 'src/', 'skills-src/', 'schemas/', 'LICENSE', 'THIRD_PARTY_NOTICES', 'README.md'] });
await writeFile(path.join(cliStage, 'README.md'), '# Byeori CLI\n\nRequires Node 24.13 or newer Node 24. Run `node runtime/cli.mjs --help --json`, then `init --root <project> --json` and `doctor --root <project> --json`. No consumer pnpm, build or node_modules required. Native plugin trust/activation is a separate host step; CLI presence does not prove enforcement. Version is provisional until release/native checks. Source and third-party licenses are included.\n');
const publicHashes = {};
for (const directory of payloads) for (const [file, value] of Object.entries(await hashes(path.join(root, directory)))) publicHashes[directory + '/' + file] = value;
for (const file of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'LICENSE', 'THIRD_PARTY_NOTICES']) publicHashes[file] = digest(await readFile(path.join(root, file)));
await json(path.join(root, 'plugins/release-manifest.json'), { version: metadata.version, files: Object.fromEntries(Object.entries(publicHashes).sort(([a], [b]) => a.localeCompare(b, 'en'))) });
await json(path.join(staging, 'bundle-inputs.json'), { runtime: bundled.metafile, studio_module_ids: [...moduleIds].sort() });
console.log(JSON.stringify({ version: metadata.version, payloads, runtime_files: (await files(runtime)).length, dependencies: vendorList.map(item => item.name + '@' + item.version), native_activation_claim: false }));
