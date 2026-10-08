import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { reject } from './errors';
import { PROFILE } from './yaml';

export function recordId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) reject('PATH_DENIED', 'Invalid record identifier.');
  return value;
}
export function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\%:]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.startsWith('/') || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) reject('PATH_DENIED', 'Unsafe relative path.', value);
  return value;
}
export function sourcePath(value: string): string {
  relativePath(value);
  if (!value.startsWith('planning/source/') || !/\.ya?ml$/.test(value)) reject('PATH_DENIED', 'Document path must be YAML under planning/source/.', value);
  return value;
}
export function decodeRouteSegment(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { reject('PATH_DENIED', 'Malformed route encoding.'); }
  return recordId(decoded);
}
export async function safePath(root: string, relative: string): Promise<string> {
  relativePath(relative);
  const canonicalRoot = await realpath(root);
  const target = path.join(canonicalRoot, ...relative.split('/'));
  let current = canonicalRoot;
  for (const segment of relative.split('/')) {
    const entries = await readdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (entries.some(entry => entry !== segment && entry.normalize('NFC').toLowerCase() === segment.normalize('NFC').toLowerCase())) reject('PATH_DENIED', 'Case/Unicode path collision.', relative);
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) reject('PATH_DENIED', 'Symlink paths are not permitted.', relative);
      if (current !== target && !info.isDirectory()) reject('PATH_DENIED', 'Path ancestor is not a directory.', relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
export async function ensureDirectory(root: string, relative: string, fence?: () => Promise<void>): Promise<string> {
  const segments = relativePath(relative).split('/');
  for (let index = 1; index <= segments.length; index++) {
    const part = segments.slice(0, index).join('/');
    const target = await safePath(root, part);
    await fence?.();
    try { await mkdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await lstat(await safePath(root, part))).isDirectory()) reject('PATH_DENIED', 'Expected a directory.', part);
  }
  return safePath(root, relative);
}
export async function readText(root: string, relative: string): Promise<string> {
  const target = await safePath(root, relative);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > PROFILE.max_bytes) reject('VALIDATION_FAILED', 'Record must be a regular file within size limits.', relative);
    const buffer = await handle.readFile();
    if (buffer.length > PROFILE.max_bytes) reject('VALIDATION_FAILED', 'Record exceeds size limit.', relative);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch { reject('VALIDATION_FAILED', 'Record is not valid UTF-8.', relative); }
  } finally { await handle.close(); }
}
export async function listFiles(root: string, relative: string): Promise<string[]> {
  const target = await safePath(root, relative);
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative + '/' + entry.name;
    await safePath(root, child);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else reject('PATH_DENIED', 'Only regular files/directories are permitted.', child);
  }
  return files.sort();
}
