import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result, StudioRuntime } from '../contracts';
import { reject } from '../core/errors';
import { result } from '../core/services';
import { workspaceIdentity } from '../core/workspace';
import { inspectStudio, stopOwnedStudio } from '../server';

export interface LaunchOptions { assetsRoot?: string; port?: number }
export async function studio(root: string, action: 'start' | 'status' | 'stop', options: LaunchOptions = {}): Promise<Result<StudioRuntime>> {
  return result(async () => {
    const canonicalRoot = (await workspaceIdentity(root)).canonical_root;
    if (action === 'status') return inspectStudio(canonicalRoot);
    if (action === 'stop') return stopOwnedStudio(canonicalRoot);
    const current = await inspectStudio(canonicalRoot); if (current.state === 'running') return current;
    const development = import.meta.url.endsWith('.ts');
    const worker = new URL(development ? '../server/worker.ts' : './worker.mjs', import.meta.url);
    const assetsRoot = options.assetsRoot ? path.resolve(options.assetsRoot) : fileURLToPath(new URL(development ? '../../dist/' : './studio/', import.meta.url));
    const response = await new Promise<Result<StudioRuntime>>((resolve, rejectLaunch) => {
      const child = fork(worker, [], { detached: true, execArgv: development ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let settled = false;
      const finish = (value?: Result<StudioRuntime>, error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.unref(); if (child.connected) child.disconnect(); if (error) rejectLaunch(error); else resolve(value!); };
      const timer = setTimeout(() => { try { reject('CAPABILITY_UNAVAILABLE', 'Studio readiness timed out; inspect Studio before retrying launch.'); } catch (error) { finish(undefined, error as Error); } }, 15000);
      child.once('error', error => finish(undefined, error));
      child.once('exit', () => { if (!settled) { try { reject('CAPABILITY_UNAVAILABLE', 'Studio worker exited before readiness.'); } catch (error) { finish(undefined, error as Error); } } });
      child.once('message', (value: Result<StudioRuntime>) => finish(value));
      child.send({ root: canonicalRoot, options: { assetsRoot, ...(options.port === undefined ? {} : { port: options.port }) } }, error => { if (error) finish(undefined, error); });
    });
    if (!response.ok) { const { CoreError } = await import('../core/errors'); const diagnostic = response.diagnostics[0]; throw new CoreError(diagnostic.code, diagnostic.message, diagnostic.path, diagnostic.field); }
    return response.data;
  });
}
