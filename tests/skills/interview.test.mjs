import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'skills-src');
const read = file => readFile(file, 'utf8');
const protocol = await read(path.join(source, 'references/interview.md'));
const examples = Object.fromEntries([...protocol.matchAll(/```json tool=(\w+)\n([^`]+)```/g)].map(match => [match[1], JSON.parse(match[2])]));
const string = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const options = maximum => ({ type: 'array', minItems: 2, maxItems: maximum, items: object({ label: string, description: string }) });
const envelope = question => object({ questions: { type: 'array', minItems: 1, maxItems: 3, items: question } });
const header = { ...string, maxLength: 12 };
// Pinned host contracts for documented examples, not an implementation of host tools.
const schemas = {
  AskUserQuestion: envelope(object({ question: string, header, options: options(4), multiSelect: { type: 'boolean' } })),
  request_user_input: envelope(object({ id: { ...string, pattern: '^[a-z][a-z0-9_]*$' }, question: string, header, options: options(3) })),
  request_user_input_async: envelope({ type: 'object', properties: { title: string, options: { type: 'array', minItems: 1, items: string } }, required: ['title'], additionalProperties: false }),
};

test('interview examples fit the distinct exposed tool shapes and reject cross-host fields', () => {
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(schemas).sort());
  const ajv = new Ajv();
  for (const [tool, schema] of Object.entries(schemas)) {
    const validate = ajv.compile(schema);
    assert.ok(validate(examples[tool]), JSON.stringify(validate.errors));
    const crossed = structuredClone(examples[tool]);
    crossed.questions[0][tool === 'AskUserQuestion' ? 'id' : 'multiSelect'] = tool === 'AskUserQuestion' ? 'scope' : false;
    assert.equal(validate(crossed), false, tool + ' must not borrow another host schema');
    const missing = structuredClone(examples[tool]);
    delete missing.questions[0][tool === 'request_user_input_async' ? 'title' : 'options'];
    assert.equal(validate(missing), false);
    const tooMany = { questions: Array.from({ length: 4 }, () => examples[tool].questions[0]) };
    assert.equal(validate(tooMany), false, 'Byeori batches at most three');
  }
  for (const tool of ['AskUserQuestion', 'request_user_input']) {
    assert.ok(examples[tool].questions[0].options.every(option => !/^other$/i.test(option.label)));
  }
  assert.match(examples.request_user_input.questions[0].options[0].label, /\(Recommended\)$/);
});

async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkLinks(file);
    else if (file.endsWith('.md')) for (const match of (await read(file)).matchAll(/\]\(([^)]+\.md)\)/g)) {
      if (!match[1].includes('://')) assert.ok((await read(path.resolve(directory, match[1]))).length, file + ' → ' + match[1]);
    }
  }
}

test('all eight shipped entrypoints and nine topic guides reach the same current interview protocol', async () => {
  const guides = await readdir(path.join(source, 'references/interviews'));
  assert.equal(guides.length, 9);
  for (const guide of guides) assert.match(await read(path.join(source, 'references/interviews', guide)), /\[interview protocol\]\(\.\.\/interview\.md\)/);
  assert.match(await read(path.join(source, 'references/continuity.md')), /\[interview protocol\]\(interview\.md\)/);
  for (const host of ['claude', 'codex']) for (const name of ['init', 'start', 'change', 'review']) {
    const skillName = host === 'claude' ? name : 'byeori-' + name;
    const directory = path.join(root, 'plugins/byeori-' + host, 'skills', skillName);
    const template = await read(path.join(source, name + '.md'));
    const shipped = await read(path.join(directory, 'SKILL.md'));
    assert.match(shipped, /\[interview protocol\]\(references\/interview\.md\)/);
    assert.equal(shipped, template.replace('{{SKILL_NAME}}', skillName), 'regenerate entrypoint ' + skillName);
    assert.equal(await read(path.join(directory, 'references/interview.md')), protocol, 'regenerate protocol ' + skillName);
    for (const guide of guides) assert.equal(await read(path.join(directory, 'references/interviews', guide)), await read(path.join(source, 'references/interviews', guide)));
    assert.equal(await read(path.join(directory, 'references/continuity.md')), await read(path.join(source, 'references/continuity.md')));
    await checkLinks(directory);
  }
});

test('interview instruction contract retains waiting, mode, cancellation and human-review boundaries', () => {
  // These are static instruction guards. They do not simulate model/tool execution.
  for (const required of [
    /printing JSON or a question in prose is not a tool call/,
    /Some hosts expose it only in Plan mode; others enable it in Default mode/,
    /Do not .*switch modes automatically/,
    /immediate tool return is only delivery acknowledgment/,
    /preselected choice is not a submitted answer/,
    /empty\/missing\/whitespace-only answers/,
    /present the same question and numbered choices in chat/,
    /end the turn awaiting the user's reply/,
    /Do not immediately reopen the same question through a fallback/,
    /record only the explicit answers and keep the remaining IDs pending/,
    /If the active mode prohibits writes/,
    /re-read and merge instead of overwriting another answer/,
    /Interview answers, including “yes,” do not approve a frozen review/,
  ]) assert.match(protocol, required);
  assert.doesNotMatch(protocol, /```json tool=AskTool/);
});

const execute = promisify(execFile);
test('real CLI preserves pending, paused and partially answered interview checkpoints without authorization', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'byeori-interview-'));
  async function cli(command, input, expected = 0) {
    let output;
    const args = [path.join(root, 'plugins/byeori-codex/runtime/cli.mjs'), ...command, '--root', project, '--json', ...(input ? ['--input', JSON.stringify(input)] : [])];
    try { output = await execute(process.execPath, args, { cwd: project }); assert.equal(expected, 0); }
    catch (error) { assert.equal(error.code, expected, error.stdout || error.message); output = error; }
    const result = JSON.parse(output.stdout);
    assert.equal(result.ok, expected === 0, output.stdout);
    return result.ok ? result.data : result;
  }
  try {
    await cli(['init']);
    let status = await cli(['status']);
    const facts = [{ id: 'existing', text: 'Synthetic confirmed product scope' }];
    const pending = [{ id: 'version_channel', text: 'Which channel belongs in the first version?', blocking: true }, { id: 'retention', text: 'How long should files remain?', blocking: true }];
    const assumptions = [{ id: 'traffic', text: 'Synthetic traffic is still unconfirmed' }];
    const write = (workflow, version = status.workflow.version) => cli(['workflow', 'write'], { project_id: status.project_id, workspace_fingerprint: status.workspace_fingerprint, expected_version: version, workflow });
    const workflow = { ...status.workflow, facts, assumptions, open_questions: pending, focus: { kind: 'prd', object_id: null, change_id: null }, next_action: 'Awaiting user input: version_channel' };
    await write(workflow);
    status = await cli(['status']);
    const beforePause = structuredClone(status.workflow);
    // Synthetic checkpoints prescribed by the skill; no fabricated host-response executor.
    for (const next_action of ['Awaiting user input: version_channel (tool unavailable; chat fallback)', 'Paused: version_channel (question cancelled)', 'Awaiting user input: version_channel (empty response)', 'Paused: version_channel (user skipped blocking question)']) {
      await write({ ...status.workflow, next_action });
      status = await cli(['status']); // Fresh process, as on resume.
      assert.deepEqual(status.workflow.open_questions, pending);
      assert.deepEqual(status.workflow.facts, facts);
      assert.deepEqual(status.workflow.assumptions, assumptions);
      assert.equal(status.workflow.next_action, next_action);
      assert.equal(status.active_change, null);
      assert.equal(status.implementation_authorization.state, 'none');
    }
    const answer = { id: 'version_channel', text: 'Synthetic explicit custom answer: voice notes only' };
    await write({ ...status.workflow, facts: [...facts, answer], open_questions: [pending[1]], next_action: 'Awaiting user input: retention' });
    status = await cli(['status']);
    assert.deepEqual(status.workflow.facts, [...facts, answer]);
    assert.deepEqual(status.workflow.open_questions, [pending[1]]);
    // A stale resume must not silently discard the custom answer or restore old questions.
    const stale = await cli(['workflow', 'write'], { project_id: status.project_id, workspace_fingerprint: status.workspace_fingerprint, expected_version: beforePause.version, workflow: beforePause }, 4);
    assert.equal(stale.ok, false);
    assert.equal(stale.diagnostics[0].code, 'CONFLICT');
    const resumed = await cli(['status']);
    assert.deepEqual(resumed.workflow, status.workflow);
    assert.equal(resumed.implementation_authorization.state, 'none');
  } finally { await rm(project, { recursive: true, force: true }); }
});
