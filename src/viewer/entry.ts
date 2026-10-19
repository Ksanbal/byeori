#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startViewer, type RunningViewer } from './server';

export async function runViewer(argv: string[]): Promise<RunningViewer | null> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write('Byeori read-only document viewer\nUsage: byeori-viewer --root <project> [--port 4317]\nReads source files and selected persisted draft/change sets. No approval, editing, or implementation actions.\nBinds to 127.0.0.1; open the printed URL in your browser. Use --port 0 for an available port.\n'); return null;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 13) throw new Error('Byeori requires Node 24.13 or newer Node 24.');
  let root: string | undefined;
  let port = 4317;
  let portProvided = false;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Usage: byeori-viewer --root <project> [--port 4317]');
    if (flag === '--root' && root === undefined) root = value;
    else if (flag === '--port' && !portProvided && /^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= 65535) { port = Number(value); portProvided = true; }
    else throw new Error('Usage: byeori-viewer --root <project> [--port 4317]');
  }
  if (!root) throw new Error('A project root is required: byeori-viewer --root <project> [--port 4317]');
  const viewer = await startViewer({ root, port });
  process.stdout.write(`Byeori read-only document viewer: ${viewer.url}\nSource and draft inspection only. This view does not establish approval or implementation authority.\n`);
  return viewer;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    const viewer = await runViewer(process.argv.slice(2));
    if (viewer) {
      let closing = false;
      const stop = (): void => { if (!closing) { closing = true; void viewer.close().catch(() => { process.exitCode = 1; }); } };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } catch (error) {
    process.stderr.write(`Viewer could not start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
