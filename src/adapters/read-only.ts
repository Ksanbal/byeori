import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from '../contracts';
import { isObject } from '../core/documents';
import { reject } from '../core/errors';
import { relativePath, safePath } from '../core/paths';
import { parseYaml } from '../core/yaml';
import { literalWords, type HookInput } from './normalize';

// Resolve only this release's bundled skill documentation, never another plugin/cache.
export function bundledReferenceRoot(): string {
  return import.meta.url.endsWith('.mjs') ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills') : fileURLToPath(new URL('../../skills-src', import.meta.url));
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const number = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function reference(value: unknown): boolean {
  if (!text(value)) return false;
  if (/^turn[\w-]+$/.test(value)) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function webRead(host: HostId, tool: string, args: Record<string, unknown>): boolean {
  if (host === 'claude' && tool === 'WebSearch') return keys(args, ['query', 'allowed_domains', 'blocked_domains']) && text(args.query) && ['allowed_domains', 'blocked_domains'].every(key => args[key] === undefined || Array.isArray(args[key]) && args[key].every(text));
  // Claude Code 2.1.290+ paginates long pages with a character offset.
  if (host === 'claude' && tool === 'WebFetch') return keys(args, ['url', 'prompt', 'offset']) && reference(args.url) && text(args.prompt) && (args.offset === undefined || number(args.offset));
  // `webrun` is the actual Codex Desktop PreToolUse name, not the orchestration alias.
  if (host !== 'codex' || tool !== 'webrun' || !keys(args, ['search_query', 'open', 'find', 'click', 'response_length'])) return false;
  if (args.response_length !== undefined && !['short', 'medium', 'long'].includes(args.response_length as string)) return false;
  const validators: Record<string, (item: unknown) => boolean> = {
    search_query: item => keys(item, ['q', 'domains', 'recency']) && text(item.q) && (item.domains === undefined || Array.isArray(item.domains) && item.domains.every(text)) && (item.recency === undefined || number(item.recency)),
    open: item => keys(item, ['ref_id', 'lineno']) && reference(item.ref_id) && (item.lineno === undefined || number(item.lineno)),
    find: item => keys(item, ['ref_id', 'pattern']) && reference(item.ref_id) && text(item.pattern),
    click: item => keys(item, ['ref_id', 'id']) && reference(item.ref_id) && number(item.id),
  };
  let count = 0;
  for (const [key, validate] of Object.entries(validators)) {
    if (args[key] === undefined) continue;
    if (!Array.isArray(args[key]) || !(args[key] as unknown[]).every(validate)) return false;
    count += (args[key] as unknown[]).length;
  }
  return count > 0;
}
async function localRead(root: string, cwd: string, aliasCwd: string, value: unknown): Promise<void> {
  if (!text(value) || value.split('/').some(segment => segment === '.' || segment === '..')) reject('PATH_DENIED', 'Read requires an explicit path without traversal.');
  const aliasRoot = path.resolve(aliasCwd, path.relative(cwd, root));
  const candidate = path.isAbsolute(value) ? value.startsWith(aliasRoot + '/') ? path.join(root, path.relative(aliasRoot, value)) : value : path.join(cwd, value);
  const inside = path.relative(root, candidate);
  let target: string;
  if (inside && !inside.startsWith('../') && !path.isAbsolute(inside)) {
    relativePath(inside);
    // Do not expand ordinary document reading to credential/config stores.
    if (inside.split('/').some(segment => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.codex|\.claude|\.netrc|\.npmrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(segment))) reject('PATH_DENIED', 'Credential and host configuration reads are outside document coverage.');
    target = await safePath(root, inside);
  } else {
    const references = bundledReferenceRoot(); const relative = path.relative(references, candidate);
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || !relative.endsWith('.md')) reject('PATH_DENIED', 'External reads are limited to this installed release\'s skill Markdown.');
    // Include the skills directory in the symlink/collision check, not as a trusted realpath root.
    target = await safePath(path.dirname(references), path.basename(references) + '/' + relativePath(relative));
  }
  if (!(await lstat(target)).isFile()) reject('PATH_DENIED', 'Document reads require a regular file.');
}
/** Narrow pass-through; never returns a host permission override or grants implementation authority. */
export async function isReadOnlyTool(root: string, host: HostId, input: HookInput, cwd: string): Promise<boolean> {
  const tool = input.tool_name!; const args = input.tool_input!;
  // Load only these native definitions; their later calls still get their own gates.
  if (host === 'claude' && tool === 'ToolSearch') return keys(args, ['query', 'max_results']) &&
    ['select:Read', 'select:WebFetch', 'select:WebSearch', 'select:AskUserQuestion', 'select:Skill'].includes(args.query as string) &&
    (args.max_results === undefined || number(args.max_results) && (args.max_results as number) > 0);
  if (host === 'claude' && tool === 'Skill') {
    if (!keys(args, ['skill', 'args']) || !['byeori:init', 'byeori:start', 'byeori:change', 'byeori:review'].includes(args.skill as string) || args.args !== undefined && typeof args.args !== 'string') return false;
    const name = (args.skill as string).slice('byeori:'.length); const packaged = import.meta.url.endsWith('.mjs');
    const file = path.join(bundledReferenceRoot(), packaged ? name + '/SKILL.md' : name + '.md');
    await localRead(root, cwd, input.cwd, file);
    const raw = await readFile(file, 'utf8'); const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
    if (!header || raw.includes('!`')) return false;
    const fields = parseYaml(header[1]);
    // No allowed-tools, hooks, dynamic shell context, or forked execution grants.
    return keys(fields, ['name', 'description']) && fields.name === name && text(fields.description);
  }
  if (webRead(host, tool, args)) return true;
  if (tool === 'Read') { await localRead(root, cwd, input.cwd, args.file_path); return true; }
  if (!['Bash', 'exec_command'].includes(tool) || Object.hasOwn(args, 'workdir') || Object.hasOwn(args, 'cwd') || typeof args.command !== 'string') return false;
  const words = literalWords(args.command); if (!words) return false;
  if (words.length === 1 && words[0] === 'pwd') return true;
  if (words[0] !== 'cat') return false;
  const paths = words.slice(words[1] === '--' ? 2 : 1);
  if (!paths.length || paths.some(file => file.startsWith('-'))) return false;
  for (const file of paths) await localRead(root, cwd, input.cwd, file);
  return true;
}
