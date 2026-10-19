import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { GateRequest } from '../../src/contracts';
import { CoreError } from '../../src/core/errors';
import { apply } from '../../src/core/apply';
import { prepareReview, readReceipt, reviewResults, roundBinding } from '../../src/core/review';
import { createChange, currentBinding, initializeWorkspace, loadChange, putDraft, updateChange } from '../../src/core/workspace';
import { gateCheck, selectAdvisory, status } from '../../src/core/state';
import { normalizeTool } from '../../src/adapters/normalize';
import { reviewInTerminal, terminalText, type ReviewTerminal } from '../../src/terminal/review';
import { validateTerminalChain, type TerminalProcess } from '../../src/terminal/trust';

const run = promisify(execFile);
const terminal = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const fact = (pid: number, parent: number, executable: string, tty = 'ttys001'): TerminalProcess => ({pid, parent, executable, tty, uid: 501});
const denied = (action: () => unknown, code: string) => assert.throws(action, error => error instanceof CoreError && error.diagnostics[0].code === code);
const rejected = (action: () => Promise<unknown>, code: string) => assert.rejects(action, error => error instanceof CoreError && error.diagnostics[0].code === code);

test('terminal ancestry rejects agent PTYs, wrappers, incomplete identity and different TTYs', () => {
  const direct = [fact(9, 8, '/opt/node'), fact(8, 7, '/bin/zsh'), fact(7, 1, terminal, '??')];
  validateTerminalChain(direct, 501);
  for (const executable of ['/Users/test/.local/share/claude/versions/2.1.303', '/usr/local/bin/codex', '/Applications/Codex.app/Contents/MacOS/Codex']) denied(() => validateTerminalChain([direct[0], fact(8, 7, executable), direct[2]], 501), 'AUTH_REQUIRED');
  denied(() => validateTerminalChain([direct[0], fact(8, 7, '/usr/bin/node'), direct[2]], 501), 'AUTH_REQUIRED');
  denied(() => validateTerminalChain([direct[0], fact(8, 1, '/bin/zsh')], 501), 'AUTH_REQUIRED');
  denied(() => validateTerminalChain([direct[0], fact(8, 7, '/bin/zsh', 'ttys002'), direct[2]], 501), 'AUTH_REQUIRED');
  denied(() => validateTerminalChain([direct[0], direct[1], fact(7, 3, terminal)], 501), 'AUTH_REQUIRED');
  denied(() => validateTerminalChain([direct[0], direct[1], direct[2]], 502), 'AUTH_REQUIRED');
});

test('real reviewer entry rejects noninteractive input and approval flags; both agent tool paths remain unknown', async () => {
  const entry = new URL('../../src/terminal/entry.ts', import.meta.url);
  const child = (args: string[]) => run(process.execPath, ['--import', 'tsx', entry.pathname, ...args]);
  await assert.rejects(child(['--root', os.tmpdir()]), /AUTH_REQUIRED/);
  await assert.rejects(child(['--root', os.tmpdir(), '--approve', 'true']), /VALIDATION_FAILED/);
  const help = await child(['--help']); assert.match(help.stdout, /human terminal review/);
  for (const host of ['claude', 'codex'] as const) {
    const input = {cwd: os.tmpdir(), session_id: 'synthetic-human-entry-denial', hook_event_name: 'PreToolUse' as const, tool_name: host === 'claude' ? 'Bash' : 'exec_command', tool_input: {command: `node '${entry.pathname}' --root '${os.tmpdir()}'`}};
    assert.equal(normalizeTool(os.tmpdir(), host, input).operation, 'unknown');
  }
});

async function fixture(action: (root: string, round: Awaited<ReturnType<typeof prepareReview>>) => Promise<void>, blocking = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byeori terminal synthetic '));
  try {
    await initializeWorkspace(root); const binding = await currentBinding(root);
    let change = await createChange(root, {...binding, metadata: {type: 'spec_change', title: 'Synthetic terminal review', request: 'Test review without real human or host claims', reason: 'Synthetic fixture only', affected_object_ids: [], implementation_scope: {allowlist: [{path: 'counter.js', match: 'file'}], related_object_ids: ['PRD-DEMO-001'], validation_plan: ['Run synthetic assertions']}}});
    let raw = await readFile(new URL('../fixtures/planning/prd.yaml', import.meta.url), 'utf8');
    if (blocking) raw = raw.replace('open_questions: []', 'open_questions:\n- id: QUESTION-001\n  text: Synthetic unresolved input\n  blocking: true');
    change = (await putDraft(root, {...binding, change_id: change.change_id, expected_version: change.version, object_id: 'PRD-DEMO-001', kind: 'prd', path: 'planning/source/prd.yaml', raw})).change;
    const round = await prepareReview(root, {...binding, change_id: change.change_id, expected_version: change.version});
    await action(root, round);
  } finally { await rm(root, {recursive: true, force: true}); }
}
function syntheticInput(answers: string[]): ReviewTerminal & {output: string[]} {
  return {output: [], write(text) {this.output.push(text);}, async question() {assert.ok(answers.length, 'Synthetic I/O exhausted'); return answers.shift()!;}, async verifyHuman() { /* synthetic service test, not native human transport evidence */ }};
}
const accepted = (hash: string, permission: string) => ['approve', '', 'approve', '', permission, 'SUBMIT ' + hash.slice(0, 12)];

test('synthetic terminal planning-only vs explicit scope permission preserve Core gates', () => fixture(async (root, round) => {
  const before = await status(root); const gate: GateRequest = {project_id: before.project_id, workspace_fingerprint: before.workspace_fingerprint, host: 'codex', tool: 'apply_patch', operation: 'implementation_write', paths: ['counter.js']};
  await selectAdvisory(root, {host: 'codex', reason: 'Synthetic Core coverage test; not native enforcement'});
  await rejected(() => gateCheck(root, gate), 'REVIEW_REQUIRED');
  const result = await reviewInTerminal(root, syntheticInput(accepted(round.manifest_hash, 'planning-only')));
  assert.equal(result.approval.documents_approved, true); assert.equal(result.approval.implementation_allowed, false);
  assert.equal(result.accepted_submission!.provenance, 'terminal_human_submit');
  await apply(root, roundBinding(round));
  await rejected(() => gateCheck(root, gate), 'REVIEW_REQUIRED');
  await rejected(() => reviewInTerminal(root, syntheticInput([])), 'REVIEW_REQUIRED');
}));

test('synthetic explicit implementation permission allows only the frozen file, not a sentinel', () => fixture(async (root, round) => {
  const result = await reviewInTerminal(root, syntheticInput(accepted(round.manifest_hash, 'allow-implementation')));
  assert.equal(result.approval.implementation_allowed, true); assert.equal(result.accepted_submission!.submission.implementation_authorization.scope_hash, round.manifest.scope_hash);
  await apply(root, roundBinding(round)); await selectAdvisory(root, {host: 'codex', reason: 'Synthetic scope check, not native enforcement'});
  const request: GateRequest = {...await currentBinding(root), host: 'codex', tool: 'apply_patch', operation: 'implementation_write', paths: ['counter.js']};
  assert.equal((await gateCheck(root, request)).allowed, true);
  await rejected(() => gateCheck(root, {...request, paths: ['outside.txt']}), 'SCOPE_DENIED');
}));

test('rejected/pending terminal judgments never grant implementation or become whole approval', () => fixture(async (root, round) => {
  const result = await reviewInTerminal(root, syntheticInput(['request_changes', 'Revise the synthetic purpose', 'pending', '', 'SUBMIT ' + round.manifest_hash.slice(0, 12)]));
  assert.equal(result.approval.documents_approved, false); assert.equal(result.approval.implementation_allowed, false);
  assert.equal(result.accepted_submission!.submission.items[0].comments[0].blocking, true);
  await rejected(() => apply(root, roundBinding(round)), 'REVIEW_REQUIRED');
}));

test('pause and a new service invocation resume saved judgments without default or duplicate approval', () => fixture(async (root, round) => {
  await rejected(() => reviewInTerminal(root, syntheticInput(['approve', '', 'quit'])), 'REVIEW_REQUIRED');
  let saved = await reviewResults(root, roundBinding(round)); assert.equal(saved.accepted_submission, null); assert.equal(saved.draft!.items[0].decision, 'approve');
  await rejected(() => reviewInTerminal(root, syntheticInput(['keep', '', 'approve', '', 'allow-implementation', 'wrong confirmation'])), 'REVIEW_REQUIRED');
  saved = await reviewResults(root, roundBinding(round)); assert.equal(saved.accepted_submission, null);
  const result = await reviewInTerminal(root, syntheticInput(['keep', '', 'keep', '', 'planning-only', 'SUBMIT ' + round.manifest_hash.slice(0, 12)]));
  assert.equal(result.approval.documents_approved, true); assert.equal(result.approval.implementation_allowed, false);
  await rejected(() => reviewInTerminal(root, syntheticInput([])), 'CONFLICT');
}));

test('failed human transport check writes no feedback; terminal controls cannot repaint prompts', () => fixture(async (root, round) => {
  const io = syntheticInput([]); io.verifyHuman = async () => {throw new CoreError('AUTH_REQUIRED', 'Synthetic unavailable transport');};
  await rejected(() => reviewInTerminal(root, io), 'AUTH_REQUIRED');
  assert.equal((await reviewResults(root, roundBinding(round))).draft, null);
  assert.equal(terminalText('\u001b[2Jfake\r\b\ntext'), 'fake\ntext');
}));

test('legacy immutable receipt provenance remains readable without promoting planning-only permission', () => fixture(async (root, round) => {
  const result = await reviewInTerminal(root, syntheticInput(accepted(round.manifest_hash, 'planning-only')));
  const receipt = result.accepted_submission!; const file = path.join(root, 'planning/reviews/submissions', receipt.submission.submission_id + '.yaml');
  // Synthetic historical record in a temporary fixture, never a real user receipt.
  await writeFile(file, JSON.stringify({...receipt, provenance: 'studio_human_submit'}));
  const legacy = await readReceipt(root, receipt.submission.submission_id);
  assert.equal(legacy!.submission.implementation_authorization.allowed, false);
  assert.equal((await reviewResults(root, roundBinding(round))).approval.implementation_allowed, false);
  await writeFile(file, JSON.stringify({...receipt, provenance: 'untrusted_agent_submit'}));
  await rejected(() => readReceipt(root, receipt.submission.submission_id), 'VALIDATION_FAILED');
}));

test('a draft changed while the human is reading cannot receive the old final confirmation', () => fixture(async (root, round) => {
  const io = syntheticInput(accepted(round.manifest_hash, 'allow-implementation')); const original = io.question;
  io.question = async prompt => {
    if (prompt.startsWith('Type SUBMIT')) {
      const current = (await loadChange(root, round.manifest.change_id)).change;
      await updateChange(root, {...await currentBinding(root), change_id: current.change_id, expected_version: current.version, metadata: {...current.metadata, reason: 'Synthetic concurrent revision'}});
    }
    return original.call(io, prompt);
  };
  await rejected(() => reviewInTerminal(root, io), 'STALE_REVIEW');
  assert.equal((await reviewResults(root, roundBinding(round))).accepted_submission, null);
}));

test('unresolved blocking planning questions cannot receive implementation consent', () => fixture(async (root, round) => {
  const io = syntheticInput(['approve', '', 'approve', '', 'SUBMIT ' + round.manifest_hash.slice(0, 12)]);
  const result = await reviewInTerminal(root, io);
  assert.equal(result.approval.documents_approved, true); assert.equal(result.approval.implementation_allowed, false);
  assert.ok(io.output.some(line => line.includes('Implementation readiness:')));
  assert.ok(io.output.some(line => line.startsWith('| schema_version:')));
}, true));
