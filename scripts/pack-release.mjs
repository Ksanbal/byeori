import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, utimes, chmod } from 'node:fs/promises';
import path from 'node:path';
import { root, metadata, files, digest } from './release-utils.mjs';
const destination = path.join(root, 'artifacts/release'); await mkdir(destination, { recursive: true });
const archiveRoot = path.join(root, 'artifacts/archive-staging'); await rm(archiveRoot, { recursive: true, force: true }); await mkdir(archiveRoot);
for (const directory of ['plugins', '.claude-plugin', '.agents/plugins']) await cp(path.join(root, directory), path.join(archiveRoot, directory), { recursive: true });
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES']) await cp(path.join(root, name), path.join(archiveRoot, name));
const entries = await files(archiveRoot), epoch = new Date('1980-01-01T00:00:00Z');
for (const file of entries) { await chmod(path.join(archiveRoot, file), 0o644); await utimes(path.join(archiveRoot, file), epoch, epoch); }
const zip = path.join(destination, `byeori-${metadata.version}-plugins.zip`); await rm(zip, { force: true });
function invoke(command, args, cwd, input) { const start = new Date().toISOString(); const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }); console.log(JSON.stringify({ command, args, cwd, start, end: new Date().toISOString(), exit: result.status })); if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); if (result.status !== 0) throw new Error(command + ' failed'); }
invoke('zip', ['-X', '-q', zip, '-@'], archiveRoot, entries.join('\n') + '\n');
const stage = path.join(root, 'artifacts/release-staging/cli-package');
invoke('pnpm', ['pack', '--pack-destination', destination], stage);
const tgz = path.join(destination, `byeori-${metadata.version}.tgz`);
// Read back real archives; do not treat command success as a complete package.
execFileSync('unzip', ['-t', zip]); execFileSync('tar', ['-tzf', tgz]);
const names = [path.basename(zip), path.basename(tgz)];
const sums = (await Promise.all(names.map(async name => digest(await readFile(path.join(destination, name))) + '  ' + name))).join('\n') + '\n';
await (await import('node:fs/promises')).writeFile(path.join(destination, 'SHA256SUMS'), sums);
console.log(sums.trim());
