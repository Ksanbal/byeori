#!/usr/bin/env node
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CoreError, reject } from '../core/errors';
import { reviewInTerminal } from './review';
import { assertHumanTerminal } from './trust';

export async function runHumanReview(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write('Byeori human terminal review\nRun node <plugin>/runtime/review.mjs --root <project> directly in your own terminal.\nNo JSON approval flags, pipes, agent execution, browser, or permission changes.\n'); return; }
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1] || argv[1].startsWith('--')) reject('VALIDATION_FAILED', 'Usage: review.mjs --root <project>. Human approval cannot be supplied as arguments.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 13) reject('CAPABILITY_UNAVAILABLE', 'Byeori requires Node 24.13 or newer Node 24.');
  await assertHumanTerminal();
  const abort = new AbortController();
  const terminal = createInterface({input: process.stdin, output: process.stdout, terminal: true});
  terminal.on('SIGINT', () => abort.abort()); terminal.on('close', () => abort.abort());
  try { await reviewInTerminal(path.resolve(argv[1]), {write: text => {process.stdout.write(text);}, question: prompt => terminal.question(prompt, {signal: abort.signal}), verifyHuman: assertHumanTerminal}); }
  finally { terminal.close(); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { await runHumanReview(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error instanceof CoreError ? error.diagnostics.map(item => item.code + ': ' + item.message).join('\n') : error instanceof Error ? error.message : 'Review stopped') + '\n'); process.exitCode = error instanceof Error && error.name === 'AbortError' ? 130 : 3; }
}
