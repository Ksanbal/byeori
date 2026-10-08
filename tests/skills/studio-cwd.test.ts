import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import type { Result, StudioRuntime } from '../../src/contracts';
import { stopOwnedStudio } from '../../src/server';
const run = promisify(execFile); const repository = fileURLToPath(new URL('../../', import.meta.url));
test('actual external-cwd Studio child uses resolved dev loader and packaged worker needs no tsx', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'byeori external CLI 한글 '))); const runtime = path.join(directory, 'runtime'); await mkdir(path.join(runtime, 'studio'), { recursive: true }); await writeFile(path.join(runtime, 'studio/index.html'), '<!doctype html><html><body>Synthetic relocated runtime</body></html>');
  let activeRoot: string | null = null;
  try {
    await build({ entryPoints: { cli: path.join(repository, 'src/cli/main.ts'), worker: path.join(repository, 'src/server/worker.ts') }, outdir: runtime, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: 'silent' });
    for (const mode of ['development', 'bundled'] as const) {
      const root = path.join(directory, mode + ' nonNode project'); await mkdir(root); const prefix = mode === 'development' ? ['--import', import.meta.resolve('tsx'), path.join(repository, 'src/cli/main.ts')] : [path.join(runtime, 'cli.mjs')];
      const invoke = async (command: string[], flags: string[] = []) => { const response = await run(process.execPath, [...prefix, ...command, '--root', root, '--json', ...flags], { cwd: root, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } }); assert.ok(response.stdout.trim(), mode + ' ' + command.join(' ') + ': empty stdout; stderr=' + response.stderr); assert.equal(response.stdout.trim().split('\n').length, 1); const result = JSON.parse(response.stdout) as Result<StudioRuntime>; assert.ok(result.ok, response.stdout + response.stderr); return result.ok ? result.data : null; };
      await invoke(['init']); const started = await invoke(['studio'], ['--action', 'start', ...(mode === 'development' ? ['--assets', path.join(runtime, 'studio')] : [])]); assert.equal(started!.state, 'running'); activeRoot = root;
      assert.deepEqual(await invoke(['studio'], ['--action', 'status']), started); assert.equal((await invoke(['studio'], ['--action', 'stop']))!.state, 'stopped'); activeRoot = null;
      assert.equal(await readFile(path.join(runtime, 'studio/index.html'), 'utf8'), '<!doctype html><html><body>Synthetic relocated runtime</body></html>');
    }
    console.log(JSON.stringify({ external_cwd: true, modes: ['development', 'temporary bundled CLI/worker'], consumer_install_claim: false, runtime_loader_imports: 'bundled worker execArgv empty; no NODE_PATH/NODE_OPTIONS or runtime node_modules' }));
  } finally { if (activeRoot) await stopOwnedStudio(activeRoot); await rm(directory, { recursive: true, force: true }); }
});
