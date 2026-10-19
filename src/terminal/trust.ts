import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CoreError, reject } from '../core/errors';

const run = promisify(execFile);
export interface TerminalProcess { pid: number; parent: number; uid: number; tty: string; executable: string }
const shells = new Set(['/bin/zsh', '/bin/bash', '/bin/sh', '/bin/dash', '/usr/bin/dash', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish', '/usr/bin/login', '/bin/login']);
const terminals = new Set([
  '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
  '/Applications/iTerm.app/Contents/MacOS/iTerm2',
  '/usr/bin/xterm', '/usr/bin/konsole', '/usr/bin/gnome-terminal-server',
  '/usr/libexec/gnome-terminal-server', '/usr/lib/gnome-terminal/gnome-terminal-server',
  '/usr/bin/alacritty', '/usr/bin/kitty',
]);
/** Fail closed: a PTY alone is not evidence that a human owns the review transport. */
export function validateTerminalChain(chain: TerminalProcess[], uid: number): void {
  const self = chain[0];
  if (!self || self.tty === '??' || self.tty === '?' || self.tty === '-' || !self.tty) reject('AUTH_REQUIRED', 'Review requires a directly operated terminal.');
  let terminal = false;
  for (const process of chain.slice(1)) {
    if (/(?:^|[/ ._-])(?:claude|codex)(?:[/ ._-]|$)/i.test(process.executable)) reject('AUTH_REQUIRED', 'Agents cannot run the human review transport. Run it directly from your own terminal shell.');
    if (!terminal) {
      if (terminals.has(process.executable) && process.uid === uid) terminal = true;
      else if (!shells.has(process.executable) || process.uid !== uid || process.tty !== self.tty) reject('AUTH_REQUIRED', 'Unsupported terminal wrapper. Run the review entry directly from Terminal/iTerm or a supported Linux terminal.');
    }
  }
  if (!terminal || chain.at(-1)?.parent !== 1) reject('AUTH_REQUIRED', 'A complete supported terminal process chain could not be verified.');
}
async function inspect(pid: number): Promise<TerminalProcess> {
  const output = (await run('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'uid=', '-o', 'tty=', '-o', 'comm='], {env: {...process.env, LC_ALL: 'C'}})).stdout.trim();
  const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(output);
  if (!match) reject('AUTH_REQUIRED', 'Terminal process identity is unavailable.');
  const executable = await realpath(pid === process.pid ? process.execPath : process.platform === 'linux' ? `/proc/${pid}/exe` : match[4]);
  return {pid, parent: Number(match[1]), uid: Number(match[2]), tty: match[3], executable};
}
export async function assertHumanTerminal(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY || !['darwin', 'linux'].includes(process.platform) || !process.getuid) reject('AUTH_REQUIRED', 'Human review requires a directly operated macOS/Linux TTY; pipes, agent tools and noninteractive input cannot approve.');
  try {
    const chain: TerminalProcess[] = []; const seen = new Set<number>(); let pid = process.pid;
    while (pid > 1 && chain.length < 48 && !seen.has(pid)) { seen.add(pid); const item = await inspect(pid); chain.push(item); pid = item.parent; }
    validateTerminalChain(chain, process.getuid());
    const terminal = chain.find(item => terminals.has(item.executable))!;
    if ((await stat(terminal.executable)).uid !== 0) reject('AUTH_REQUIRED', 'Terminal executable ownership is not trusted.');
  } catch (error) {
    if (error instanceof CoreError) throw error;
    reject('AUTH_REQUIRED', 'Terminal identity could not be verified; no approval was recorded.');
  }
}
