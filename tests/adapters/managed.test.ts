import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli/main';
import { manageInstructions } from '../../src/adapters/managed';
import { initializeWorkspace } from '../../src/core/workspace';
import { CoreError } from '../../src/core/errors';

async function temp(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'Byeori nonNode 한글 ')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('CLI init/remove preserves exact unrelated guidance, ignore, config/hooks, legacy planning and source', async () => temp(async root => {
  const agents = '# Original\r\n한글 instruction without newline'; const claude = 'Original CLAUDE\n';
  await writeFile(path.join(root, 'AGENTS.md'), agents); await writeFile(path.join(root, 'CLAUDE.md'), claude); await writeFile(path.join(root, '.gitignore'), '# Other\nold-pattern\n');
  await mkdir(path.join(root, '.claude')); const config = '{\n  "hooks": { "PreToolUse": [] },\n  "permissions": { "allow": ["Read"] }\n}\n'; await writeFile(path.join(root, '.claude/settings.json'), config); await mkdir(path.join(root, '.plan')); await writeFile(path.join(root, '.plan/keep.yaml'), 'old');
  const first = await execute(['init', '--root', root]); assert.ok(first.ok); const after = await readFile(path.join(root, 'AGENTS.md'), 'utf8'); assert.ok(after.startsWith(agents)); assert.match(after, /byeori:begin/); assert.match(after, /planning\/workflow.yaml/); assert.ok(!after.includes('.delivery'));
  assert.equal(JSON.stringify(await execute(['init', '--root', root])), JSON.stringify(first)); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), after);
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8'); const planning = await readFile(path.join(root, 'planning/config.yaml'), 'utf8');
  assert.ok((await execute(['host', 'remove', '--root', root])).ok); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), agents); assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), claude); assert.equal(await readFile(path.join(root, '.claude/settings.json'), 'utf8'), config); assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), ignore); assert.equal(await readFile(path.join(root, 'planning/config.yaml'), 'utf8'), planning); assert.equal(await readFile(path.join(root, '.plan/keep.yaml'), 'utf8'), 'old'); assert.ok((await execute(['host', 'remove', '--root', root])).ok);
  assert.ok((await execute(['init', '--root', root])).ok); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), after);
}));
test('malformed markers or config, symlinks and collisions fail before overwriting any guidance', async () => temp(async root => {
  for (const bad of ['<!-- byeori:begin -->', '<!-- byeori:end --><!-- byeori:begin -->', '<!-- byeori:begin --><!-- byeori:end --><!-- byeori:begin --><!-- byeori:end -->']) {
    await writeFile(path.join(root, 'AGENTS.md'), 'first untouched'); await writeFile(path.join(root, 'CLAUDE.md'), bad); const result = await execute(['init', '--root', root]); assert.equal(result.ok, false); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'first untouched'); assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), bad);
  }
  await rm(path.join(root, 'CLAUDE.md')); await symlink('/tmp', path.join(root, 'CLAUDE.md')); assert.equal((await execute(['init', '--root', root])).ok, false); await rm(path.join(root, 'CLAUDE.md'));
  await rm(path.join(root, 'AGENTS.md')); await writeFile(path.join(root, 'agents.md'), 'case collision'); assert.equal((await execute(['init', '--root', root])).ok, false); assert.equal(await readFile(path.join(root, 'agents.md'), 'utf8'), 'case collision');
}));
test('Core lock rejects concurrent managed writer; CAS preserves external edits and partial install retries without rollback', async () => temp(async root => {
  await initializeWorkspace(root); await writeFile(path.join(root, 'AGENTS.md'), 'Original'); await writeFile(path.join(root, 'CLAUDE.md'), 'Claude');
  let competing = false;
  await assert.rejects(() => manageInstructions(root, 'install', { afterBoundary: async boundary => { if (!boundary.startsWith('write:planning/.runtime/adapters/')) return; competing = true; await assert.rejects(() => manageInstructions(root, 'remove'), error => error instanceof CoreError && error.diagnostics[0].code === 'APPLY_RECOVERY_REQUIRED'); await writeFile(path.join(root, 'AGENTS.md'), 'External edit preserved'); } }), error => error instanceof CoreError && error.diagnostics[0].code === 'CONFLICT');
  assert.equal(competing, true); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'External edit preserved'); assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), 'Claude');
  await manageInstructions(root, 'install'); await manageInstructions(root, 'remove'); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'External edit preserved');
  let writes = 0;
  await assert.rejects(() => manageInstructions(root, 'install', { afterBoundary: async boundary => { if (boundary.startsWith('write:planning/.runtime/adapters/') && ++writes === 2) throw new Error('Synthetic IO failure after first file'); } }), /Synthetic IO/);
  const first = await readFile(path.join(root, 'AGENTS.md'), 'utf8'); assert.match(first, /byeori:begin/); assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), 'Claude'); await manageInstructions(root, 'install'); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), first); await manageInstructions(root, 'remove'); assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'External edit preserved'); assert.equal(await readFile(path.join(root, 'CLAUDE.md'), 'utf8'), 'Claude');
}));
