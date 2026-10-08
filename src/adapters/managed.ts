import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { reject } from '../core/errors';
import { withWriteLock, type MutationHooks, type Writer } from '../core/ownership';
import { safePath } from '../core/paths';
import { optionalText, readProjectConfig, workspaceIdentity } from '../core/workspace';
import { installedCliPath, shellQuote } from './config';

const BEGIN = '<!-- byeori:begin -->'; const END = '<!-- byeori:end -->';
const FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
function managed(raw: string, content: string | null): string {
  const starts = raw.split(BEGIN).length - 1; const ends = raw.split(END).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && raw.indexOf(END) < raw.indexOf(BEGIN)) reject('VALIDATION_FAILED', 'Malformed/duplicate Byeori instruction markers; existing files preserved.');
  if (!starts) return content === null ? raw : raw + BEGIN + '\n' + content + '\n' + END;
  const begin = raw.indexOf(BEGIN); const end = raw.indexOf(END) + END.length;
  if (content !== null) return raw.slice(0, begin) + BEGIN + '\n' + content + '\n' + END + raw.slice(end);
  return raw.slice(0, begin) + raw.slice(end);
}
function guidance(file: typeof FILES[number]): string {
  if (file === 'CLAUDE.md') return '@AGENTS.md\nByeori: read the managed AGENTS.md guidance before planning or implementation.';
  const cli = shellQuote(installedCliPath());
  return `## Byeori planning\nAt startup, resume or compact, re-read project instructions and planning/workflow.yaml; run node ${cli} status --root <this-workspace> --json. Confirm project_id/workspace_fingerprint, source_integrity, apply_state, active_change and current review before editing.\nWrite planning drafts through change put and workflow write with current CAS; never write source, review decisions or authorization records directly. User review is submitted in Studio. Read review results after the user returns; do not poll or manufacture approval.\nImplement only after normally completed apply, fresh explicit human implementation authorization and the exact frozen paths pass the Core gate. Document approval alone is not implementation permission or completion. Run doctor for configured/trusted/probed/active and coverage; installed hook files alone do not establish protection. Unknown shell/MCP/write_stdin paths are outside bounded coverage. Advisory requires an explicit human choice in Studio.\nAfter response loss/restart, read status, review results and history before repeating mutations or apply; inspect recovery diagnostics rather than deleting locks. Keep only needed nonsecret workflow context, not full conversations. Stop when user decisions are required.`;
}
async function replace(writer: Writer, file: string, before: string | null, after: string): Promise<void> {
  const temporary = 'planning/.runtime/adapters/' + randomUUID() + '.tmp';
  const mode = before === null ? 0o644 : (await lstat(await safePath(writer.root, file))).mode & 0o777;
  await writer.write(temporary, after, true);
  try {
    await writer.assert();
    if (await optionalText(writer.root, file) !== before) reject('CONFLICT', 'Instruction file changed before replacement.', file);
    await chmod(await safePath(writer.root, temporary), mode);
    const target = await safePath(writer.root, file); await writer.assert();
    if (before === null) { try { await link(await safePath(writer.root, temporary), target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') reject('CONFLICT', 'Instruction file was created concurrently.', file); throw error; } }
    else await rename(await safePath(writer.root, temporary), target);
    const directory = await open(path.dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); }
    await writer.assert();
  } finally { if (await optionalText(writer.root, temporary) !== null) await writer.remove(temporary); }
}
export async function preflightInstructions(inputRoot: string): Promise<void> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  for (const file of FILES) managed(await optionalText(root, file) ?? '', guidance(file));
}
export async function manageInstructions(inputRoot: string, action: 'install' | 'remove', hooks: MutationHooks = {}): Promise<{ instruction_paths: string[] }> {
  const root = (await workspaceIdentity(inputRoot)).canonical_root;
  return withWriteLock(root, 'adapter guidance ' + action, async writer => {
    await readProjectConfig(root);
    const changes = await Promise.all(FILES.map(async file => { const before = await optionalText(root, file); return { file, before, after: managed(before ?? '', action === 'install' ? guidance(file) : null) }; }));
    // Preflight every destination before the first mutation; partial IO failure is retried idempotently, never rolled back over user edits.
    for (const change of changes) if (change.before !== change.after && !(change.before === null && change.after === '')) await replace(writer, change.file, change.before, change.after);
    return { instruction_paths: (await Promise.all(FILES.map(async file => await optionalText(root, file) !== null ? file : null))).filter((file): file is typeof FILES[number] => file !== null) };
  }, hooks);
}
