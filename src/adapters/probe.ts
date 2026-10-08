import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { GateRequest, HostCapability, HostId, WorkspaceBinding, WriteOwnership } from '../contracts';
import { isObject } from '../core/documents';
import { probeOwnership, validateOwner, withWriteLock } from '../core/ownership';
import { putRecord, readRecord, same } from '../core/record-io';
import { readHost } from '../core/state';
import { currentBinding, optionalText } from '../core/workspace';
import { parseYaml, rawHash, semanticHash } from '../core/yaml';
import { hooksConfig, installedCliPath } from './config';
import { literalWords } from './normalize';
import { actualArgvHash, hookTicket, receiptMatches, type LiteralGate } from './ticket';

const run = promisify(execFile);
const coverage = (host: HostId): HostCapability['coverage'] => ({
  protected_tools: host === 'claude' ? ['Write', 'Edit', 'Bash'] : ['apply_patch', 'Bash', 'exec_command'],
  uncovered_tools: ['write_stdin', 'functions.exec', 'MCP', 'unknown tools', 'unclassified shell'],
  limitations: ['Only typed file writes, canonical patches and the documented literal shell subset are classified.', 'No new PreToolUse for write_stdin; hosted/specialized tools may bypass local hooks.', 'Local orchestration only. Same-OS privileged tampering is outside the protection boundary.', 'Active is attested only inside the currently executing native hook; ordinary doctor/gate calls conservatively report inactive.'],
});
interface Observation extends WorkspaceBinding {
  host: HostId; owner: WriteOwnership; plugin_root: string; definition_hash: string; runtime_hash: string; session_hash: string; checked_at: string;
}
async function definition(host: HostId, pluginRoot: string): Promise<{ definition_hash: string; runtime_hash: string }> {
  const canonical = await realpath(pluginRoot);
  if (canonical !== pluginRoot) throw new Error('Noncanonical plugin root');
  const config = parseYaml(await readFile(path.join(pluginRoot, 'hooks/hooks.json'), 'utf8'));
  if (!same(config, hooksConfig(host))) throw new Error('Hook definition changed or missing');
  const runtime = await readFile(path.join(pluginRoot, 'runtime/hook.mjs'));
  return { definition_hash: semanticHash(config), runtime_hash: rawHash(runtime.toString('utf8')) };
}
async function processRow(pid: number): Promise<{ parent: number; executable: string; arguments: string; start: string }> {
  const options = { timeout: 1500, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } };
  const parent = Number((await run('/bin/ps', ['-p', String(pid), '-o', 'ppid='], options)).stdout.trim());
  const executable = (await run('/bin/ps', ['-p', String(pid), '-o', 'comm='], options)).stdout.trim();
  const args = (await run('/bin/ps', ['-p', String(pid), '-o', 'args='], options)).stdout.trim();
  const start = process.platform === 'darwin' ? 'darwin:' + (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options)).stdout.trim() : 'linux:' + (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)!.split(' ')[19];
  if (!Number.isSafeInteger(parent) || parent < 1 || !path.isAbsolute(executable) || !start) throw new Error('Unobservable process chain');
  return { parent, executable, arguments: args, start };
}
/** Never traverse arbitrary ancestors: ordinary tool/test children also descend from native hosts. */
async function nativeObservation(root: string, host: HostId, event: 'PreToolUse' | 'SessionStart', writerOwner: WriteOwnership, sessionId: string): Promise<{ observation: Observation; version: string }> {
  const self = await realpath(fileURLToPath(import.meta.url));
  const pluginRoot = process.env[host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT'];
  if (!pluginRoot || self !== path.join(await realpath(pluginRoot), 'runtime/hook.mjs')) throw new Error('Not the installed dedicated hook runtime');
  const hashes = await definition(host, pluginRoot);
  let pid = process.ppid; let row = await processRow(pid);
  if (['sh', 'bash', 'zsh'].includes(path.basename(row.executable))) {
    const expected = hooksConfig(host).hooks[event][0].hooks[0].command;
    if (row.arguments !== row.executable + ' -c ' + expected && row.arguments !== path.basename(row.executable) + ' -c ' + expected) throw new Error('Command shell does not match the exact configured hook');
    pid = row.parent; row = await processRow(pid);
  }
  if (path.basename(row.executable) !== host || /--dangerously-bypass-hook-trust|--disable(?:-hooks)?|hooks\s*=\s*false/.test(row.arguments)) throw new Error('Native parent/trust context is unsupported');
  const executable = await realpath(row.executable);
  const version = (await run(executable, ['--version'], { timeout: 1500, maxBuffer: 4096 })).stdout.trim();
  if (!(host === 'codex' ? /^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/ : /^\d+\.\d+\.\d+ \(Claude Code\)$/).test(version)) throw new Error('Unsupported native host version identity');
  const owner = { ...writerOwner, process: { ...writerOwner.process, pid, start_identity: row.start } };
  if (await probeOwnership(owner) !== 'alive') throw new Error('Native process identity changed');
  return { version, observation: { ...await currentBinding(root), host, owner, plugin_root: pluginRoot, ...hashes, session_hash: semanticHash(sessionId), checked_at: new Date().toISOString() } };
}
async function retainedObservation(root: string, host: HostId): Promise<boolean> {
  try {
    const observation = await readRecord<Observation>(root, 'planning/.runtime/adapters/' + host + '-probe.yaml');
    if (!isObject(observation) || observation.host !== host || typeof observation.plugin_root !== 'string' || typeof observation.checked_at !== 'string' || !Number.isFinite(Date.parse(observation.checked_at)) || Date.now() - Date.parse(observation.checked_at) > 300_000 || Date.parse(observation.checked_at) > Date.now() || !same({ project_id: observation.project_id, workspace_fingerprint: observation.workspace_fingerprint }, await currentBinding(root))) return false;
    const hashes = await definition(host, observation.plugin_root);
    return hashes.definition_hash === observation.definition_hash && hashes.runtime_hash === observation.runtime_hash && await probeOwnership(validateOwner(observation.owner)) === 'alive';
  } catch { return false; }
}
/** CLI/Studio cannot attest current in-memory hook enablement, so persisted active never grants their gate calls enforcement. */
export async function refreshHosts(root: string): Promise<HostCapability[]> {
  return withWriteLock(root, 'refresh adapter observations', async writer => {
    const hosts: HostCapability[] = [];
    for (const host of ['claude', 'codex'] as const) {
      const previous = await readHost(root, host); const current = await retainedObservation(root, host);
      const next: HostCapability = { ...previous, active: false, ...(!current && previous.probed.state === 'passed' ? { configured: false, trusted: null, probed: { state: 'blocked', checked_at: new Date().toISOString(), evidence: ['Native observation expired, changed, ended or unavailable; run a trusted native hook again.'] } } : {}) };
      if (!same(previous, next)) await putRecord(writer, 'planning/hosts/' + host + '.yaml', next, false);
      hosts.push(next);
    }
    return hosts;
  });
}
export async function observeHook(root: string, host: HostId, event: 'PreToolUse' | 'SessionStart', sessionId: string): Promise<HostCapability> {
  return withWriteLock(root, 'native adapter observation', async writer => {
    const previous = await readHost(root, host);
    let next: HostCapability;
    try {
      const actual = await nativeObservation(root, host, event, writer.owner, sessionId);
      await putRecord(writer, 'planning/.runtime/adapters/' + host + '-probe.yaml', actual.observation, false);
      next = { ...previous, configured: true, trusted: true, active: true, host_version: actual.version, coverage: coverage(host), probed: { state: 'passed', checked_at: actual.observation.checked_at, evidence: ['Observed exact native hook parent/start/boot identity and installed definition/runtime hashes.', 'Trust inferred from native execution with known bypass flags absent; no host trust hashes were edited.'] } };
    } catch {
      next = { ...previous, configured: false, active: false, trusted: null, coverage: coverage(host), probed: { state: 'blocked', checked_at: new Date().toISOString(), evidence: ['No supported exact native hook execution chain/definition observed. Stdin fixtures are not native proof.'] } };
    }
    if (!same(previous, next)) await putRecord(writer, 'planning/hosts/' + host + '.yaml', next, false);
    return next;
  });
}
export async function disableManagedHostObservations(root: string): Promise<void> {
  await withWriteLock(root, 'remove adapter observations', async writer => {
    for (const host of ['claude', 'codex'] as const) {
      const previous = await readHost(root, host);
      await putRecord(writer, 'planning/hosts/' + host + '.yaml', { ...previous, configured: false, trusted: null, active: false, probed: { state: 'not_run', checked_at: null, evidence: [] } }, false);
      const file = 'planning/.runtime/adapters/' + host + '-probe.yaml'; if (await optionalText(root, file) !== null) await writer.remove(file);
    }
  });
}


interface GateReceipt {
  ticket: string; request_hash: string; argv_hash: string; command_hash: string; session_hash: string;
  observation: Observation; cli_hash: string; issued_at: string;
}
export async function issueGateReceipt(root: string, gate: LiteralGate, sessionId: string): Promise<void> {
  await withWriteLock(root, 'native gate preflight receipt', async writer => {
    const capability = await readHost(root, gate.request.host);
    if (!capability.active || capability.trusted !== true || capability.probed.state !== 'passed' || !await retainedObservation(root, gate.request.host)) return;
    const observation = await readRecord<Observation>(root, 'planning/.runtime/adapters/' + gate.request.host + '-probe.yaml');
    if (observation.session_hash !== semanticHash(sessionId)) return;
    try { const actual = await nativeObservation(root, gate.request.host, 'PreToolUse', writer.owner, sessionId); if (!same(actual.observation.owner.process, observation.owner.process) || actual.observation.definition_hash !== observation.definition_hash || actual.observation.runtime_hash !== observation.runtime_hash || actual.version !== capability.host_version) return; } catch { return; }
    const cliHash = rawHash(await readFile(installedCliPath(), 'utf8'));
    const receipt: GateReceipt = { ticket: gate.ticket, request_hash: semanticHash(gate.request), argv_hash: gate.argv_hash, command_hash: gate.command_hash, session_hash: semanticHash(sessionId), observation, cli_hash: cliHash, issued_at: new Date().toISOString() };
    await putRecord(writer, 'planning/.runtime/adapters/gate-tickets/' + gate.ticket + '.yaml', receipt);
  });
}
/** Same immediate native process + literal one-use invocation correlation, not independently attested same-session identity. */
export async function consumeGateReceipt(root: string, request: GateRequest, ticket: string, argv: string[]): Promise<boolean> {
  hookTicket(ticket);
  return withWriteLock(root, 'consume native gate preflight', async writer => {
    const file = 'planning/.runtime/adapters/gate-tickets/' + ticket + '.yaml'; if (await optionalText(root, file) === null) return false;
    const receipt = await readRecord<GateReceipt>(root, file);
    // Consume before validation too: failed/mismatched receipts cannot be retried under another request.
    await writer.remove(file);
    try {
      const cli = await realpath(process.argv[1]);
      if (!await retainedObservation(root, request.host) || !same(receipt.observation, await readRecord<Observation>(root, 'planning/.runtime/adapters/' + request.host + '-probe.yaml')) || !receiptMatches(receipt, { ticket, request, argv_hash: actualArgvHash(cli, argv), cli_hash: rawHash(await readFile(cli, 'utf8')), session_hash: receipt.observation.session_hash, now: Date.now() }) || cli !== await realpath(installedCliPath()) || !same({ project_id: receipt.observation.project_id, workspace_fingerprint: receipt.observation.workspace_fingerprint }, await currentBinding(root)) || receipt.observation.host !== request.host) return false;
      const hashes = await definition(request.host, receipt.observation.plugin_root);
      if (hashes.definition_hash !== receipt.observation.definition_hash || hashes.runtime_hash !== receipt.observation.runtime_hash || await probeOwnership(validateOwner(receipt.observation.owner)) !== 'alive') return false;
      let pid = process.ppid; let row = await processRow(pid);
      if (['sh', 'bash', 'zsh'].includes(path.basename(row.executable))) {
        const prefix = [row.executable, path.basename(row.executable)].flatMap(executable => [' -c ', ' -lc '].map(flag => executable + flag)).find(value => row.arguments.startsWith(value));
        if (!prefix) return false; const command = row.arguments.slice(prefix.length); const words = literalWords(command);
        if (!words || words[0] !== 'node' || receipt.command_hash !== semanticHash(command) || receipt.argv_hash !== actualArgvHash(await realpath(words[1]), words.slice(2))) return false;
        pid = row.parent; row = await processRow(pid);
      }
      if (pid !== receipt.observation.owner.process.pid || row.start !== receipt.observation.owner.process.start_identity || path.basename(row.executable) !== request.host || /--dangerously-bypass-hook-trust|--disable(?:-hooks)?|hooks\s*=\s*false/.test(row.arguments)) return false;
      const capability = await readHost(root, request.host);
      if (capability.mode.type === 'advisory') return true;
      // A concurrent refresh can demote active; do not turn it back on from a cached receipt.
      return capability.active && capability.trusted === true && capability.probed.state === 'passed';
    } catch { return false; }
  });
}
