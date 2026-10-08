import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLI_COMMANDS, type Result } from '../../src/contracts';
const run = promisify(execFile);
const entry = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
test('actual child help outside initialized workspace is bounded JSON and errors suggest installed usage', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'byeori help 한글 '));
  const invoke = async (args: string[], expected = 0) => {
    let stdout: string; let exit = 0;
    try { stdout = (await run(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], { cwd })).stdout; }
    catch (error) { const failure = error as { stdout: string; code: number }; stdout = failure.stdout; exit = failure.code; }
    assert.equal(exit, expected); assert.equal(stdout.trim().split('\n').length, 1); assert.ok(stdout.length < 16384); return JSON.parse(stdout) as Result<{ commands: { command: string; flags: string }[] }>;
  };
  try {
    const flags = await invoke(['--help', '--json']); const command = await invoke(['help', '--json', '--root', path.join(cwd, 'nonexistent')]); assert.deepEqual(command, flags); assert.ok(flags.ok); if (!flags.ok) return;
    for (const expected of CLI_COMMANDS) assert.ok(flags.data.commands.some(item => item.command === expected), expected);
    assert.ok(flags.data.commands.find(item => item.command === 'search')!.flags.includes('--query')); assert.ok(flags.data.commands.find(item => item.command === 'studio')!.flags.includes('--action'));
    const invalid = await invoke(['unrecognized', '--json'], 2); assert.equal(invalid.ok, false); if (!invalid.ok) { assert.match(invalid.diagnostics[0].suggested_action, /byeori --help --json/); assert.ok(!JSON.stringify(invalid).includes('src/')); }
    await invoke(['help', '--unknown', 'x'], 2); await invoke(['--help', '--help'], 2); await invoke(['help', 'extra', '--json'], 2);
    assert.deepEqual(await readdir(cwd), []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
