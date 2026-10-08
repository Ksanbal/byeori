import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
export const payloads = ['plugins/byeori-claude', 'plugins/byeori-codex'];
export const digest = data => createHash('sha256').update(data).digest('hex');
export async function files(directory) {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolute = path.join(directory, name), state = await lstat(absolute);
    if (state.isSymbolicLink()) throw new Error('Release tree cannot contain symlinks: ' + absolute);
    if (state.isDirectory()) output.push(...(await files(absolute)).map(file => name + '/' + file));
    else if (state.isFile()) output.push(name); else throw new Error('Unexpected release file type: ' + absolute);
  }
  return output;
}
export async function json(destination, value) { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(value, null, 2) + '\n'); }
export async function hashes(directory) { return Object.fromEntries(await Promise.all((await files(directory)).map(async file => [file, digest(await readFile(path.join(directory, file)))]))); }
