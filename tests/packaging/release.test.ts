import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { ContinuityStatus, DoctorResult, Result, StudioRuntime } from '../../src/contracts';
import { createChange, currentBinding, putDraft } from '../../src/core/workspace';
import { prepareReview, roundBinding, saveReviewDraft, submitReview } from '../../src/core/review';
import { apply } from '../../src/core/apply';
import { parseDocument } from '../../src/core/documents';
import { stopOwnedStudio } from '../../src/server';
import metadata from '../../package.json';
const execute = promisify(execFile);
const source = new URL('../../plugins/', import.meta.url);
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
async function cli<T>(entry: string, root: string, args: string[], code = 0): Promise<Result<T>> {
  let output;
  try { output = await execute(process.execPath, [entry, ...args, '--root', root, '--json'], { cwd: root, env }); }
  catch (error) { output = error as { code: number; stdout: string; stderr: string }; assert.equal(output.code, code, output.stdout + output.stderr); }
  assert.ok(output.stdout.trim(), 'CLI cannot silently skip symlink entry'); assert.equal(output.stdout.trim().split('\n').length, 1);
  const result = JSON.parse(output.stdout) as Result<T>; assert.equal(result.ok, code === 0, output.stdout); assert.equal(result.meta.runtime_version, metadata.version); return result;
}
async function http(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const request = httpGet(url, { headers }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, text })); }); request.once('error', reject);
  });
}
async function hook(entry: string, root: string, host: string, event: unknown) {
  return new Promise<{ stdout: string; stderr: string; exit: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, host], { cwd: root, env: { ...env, [host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT']: path.dirname(path.dirname(entry)) }, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject); child.once('exit', exit => resolve({ stdout, stderr, exit })); child.stdin.end(typeof event === 'string' ? event : JSON.stringify(event));
  });
}
test('both real relocated plugin payloads execute schema/FTS5/Studio/hook contracts without developer resolution', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'Byeori clean payload 한글 ')); let active: string | null = null;
  try {
    for (const host of ['claude', 'codex']) {
      const plugin = path.join(directory, host + ' installed plugin'); await cp(new URL('byeori-' + host, source), plugin, { recursive: true });
      const root = path.join(directory, host + ' non-Node project'); await mkdir(root); await writeFile(path.join(root, 'AGENTS.md'), 'Preserve user instructions\n');
      const entry = path.join(plugin, 'runtime/cli.mjs'); const canonical = await realpath(entry), link = path.join(directory, host + ' symlink cli.mjs'); await symlink(entry, link);
      for (const variant of [entry, canonical, link]) { const help = await cli<{ commands: { command: string }[] }>(variant, root, ['--help']); assert.ok(help.ok && help.data.commands.some(item => item.command === 'gate check')); }
      const inert = await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', canonical], { cwd: root, env }); assert.equal(inert.stdout, '', 'Import must not autoexecute CLI');
      await cli(entry, root, ['init']); const doctor = await cli<DoctorResult>(entry, root, ['doctor']); assert.ok(doctor.ok && doctor.data.node.compatible && doctor.data.sqlite.fts5_probed); assert.equal(doctor.ok && doctor.data.schemas.runtime_version, metadata.version);
      const initial = await cli<ContinuityStatus>(entry, root, ['status']); assert.ok(initial.ok); if (!initial.ok) return;
      const binding = await currentBinding(root); let change = await createChange(root, { ...binding, metadata: { type: 'spec_change', title: 'Synthetic package smoke', request: 'Verify relocated schemas', reason: 'Synthetic test only', affected_object_ids: [], implementation_scope: { allowlist: [], related_object_ids: [], validation_plan: [] } } });
      for (const kind of ['prd', 'actor', 'scenario', 'feature', 'architecture', 'ia', 'screen', 'entity', 'openapi']) {
        const raw = await readFile(new URL('../fixtures/planning/' + kind + '.yaml', import.meta.url), 'utf8'); const document = parseDocument({ raw, path: 'planning/source/' + kind + '.yaml' });
        change = (await putDraft(root, { ...binding, change_id: change.change_id, expected_version: change.version, object_id: document.id, kind: document.kind, path: document.path, raw })).change;
      }
      await cli(entry, root, ['lint', '--scope', 'change:' + change.change_id]);
      // Synthetic human service calls create approved fixture state only; packaged CLI has no approval helper.
      const round = await prepareReview(root, { ...binding, change_id: change.change_id, expected_version: change.version }); const body = { ...roundBinding(round), items: round.manifest.items.map(item => ({ item_id: item.item_id, decision: 'approve' as const, comments: [] })), implementation_authorization: { allowed: false as const, scope_hash: null } };
      const saved = await saveReviewDraft(root, { ...body, expected_version: null }); await submitReview(root, { ...body, schema_version: 1, submission_id: 'synthetic-package-' + host, expected_feedback_version: saved.version, final_confirmation: true }); await apply(root, roundBinding(round));
      const search = await cli<{ hits: { id: string }[] }>(entry, root, ['search', '--query', 'FEAT-MSG-001']); assert.ok(search.ok && search.data.hits.some(hit => hit.id === 'FEAT-MSG-001')); await cli(entry, root, ['get', '--id', 'FEAT-MSG-001']); await cli(entry, root, ['impact', '--id', 'FEAT-MSG-001']); await cli(entry, root, ['index', 'rebuild']);
      const started = await cli<StudioRuntime>(entry, root, ['studio', '--action', 'start']); assert.ok(started.ok && started.data.url); if (!started.ok || !started.data.url) return; active = root;
      const page = await http(started.data.url, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }); assert.equal(page.status, 200); const html = page.text; const cookie = page.headers['set-cookie']![0].split(';')[0]; assert.match(html, /<div id="root"/);
      const assets = [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map(match => match[1]); assert.ok(assets.length >= 2);
      for (const asset of assets) { const assetResponse = await http(new URL(asset, started.data.url).href, { cookie }); assert.equal(assetResponse.status, 200); assert.ok(assetResponse.text.length > 100); }
      await cli(entry, root, ['studio', '--action', 'status']); await cli(entry, root, ['studio', '--action', 'stop']); active = null;
      const event = { session_id: 'synthetic-no-native', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/unauthorized.ts'), content: 'No approval' }, tool_use_id: 'synthetic-1' };
      const denied = await hook(path.join(plugin, 'runtime/hook.mjs'), root, host, event); assert.equal(denied.exit, 0); assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
      const resumed = await hook(path.join(plugin, 'runtime/hook.mjs'), root, host, { session_id: 'synthetic-resume', cwd: root, hook_event_name: 'SessionStart', source: 'compact' }); assert.equal(resumed.exit, 0); assert.match(JSON.parse(resumed.stdout).hookSpecificOutput.additionalContext, /read AGENTS|Read project guidance/);
      const malformed = await hook(path.join(plugin, 'runtime/hook.mjs'), root, host, '{invalid'); assert.equal(malformed.exit, 0); assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal((await hook(path.join(plugin, 'runtime/hook.mjs'), root, host, 'x'.repeat(1_048_577))).exit, 2);
      const fresh = await cli<ContinuityStatus>(entry, root, ['status']); assert.ok(fresh.ok && fresh.data.implementation_authorization.state === 'none');
      assert.ok((await readFile(path.join(root, 'AGENTS.md'), 'utf8')).startsWith('Preserve user instructions')); await assert.rejects(readFile(path.join(root, 'package.json'))); await assert.rejects(readFile(path.join(plugin, 'node_modules/package.json')));
      console.log(JSON.stringify({ host, relocated_runtime: true, schemas: 9, minimum_node: process.version, synthetic_human_fixture: true, native_activation_claim: false, hook_compact_simulation_only: true }));
    }
  } finally { if (active) await stopOwnedStudio(active); await rm(directory, { recursive: true, force: true }); }
});
