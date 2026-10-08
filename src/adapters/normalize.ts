import path from 'node:path';
import type { GateRequest, HostId } from '../contracts';
import { isObject } from '../core/documents';
import { reject } from '../core/errors';
import { relativePath } from '../core/paths';
import { parseYaml } from '../core/yaml';
import { installedCliPath } from './config';

export interface HookInput {
  cwd: string; session_id: string; hook_event_name: 'PreToolUse' | 'SessionStart';
  source?: string; tool_name?: string; tool_input?: Record<string, unknown>;
}
export function parseHookInput(raw: string): HookInput {
  try { JSON.parse(raw); } catch { reject('VALIDATION_FAILED', 'Hook stdin must be one JSON object.'); }
  const value = parseYaml(raw);
  if (!isObject(value) || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || typeof value.session_id !== 'string' || !value.session_id || !['PreToolUse', 'SessionStart'].includes(value.hook_event_name as string)) reject('VALIDATION_FAILED', 'Invalid hook event/cwd/session.');
  if (value.hook_event_name === 'PreToolUse' && (typeof value.tool_name !== 'string' || !value.tool_name || !isObject(value.tool_input))) reject('VALIDATION_FAILED', 'Invalid PreToolUse tool input.');
  if (value.hook_event_name === 'SessionStart' && !['startup', 'resume', 'compact'].includes(value.source as string)) reject('VALIDATION_FAILED', 'Unsupported SessionStart source.');
  return value as unknown as HookInput;
}
function filePath(root: string, value: unknown, absolute = false, cwd = root, aliasRoot = root): string {
  if (typeof value !== 'string' || !value || absolute && !path.isAbsolute(value)) reject('PATH_DENIED', 'Expected a documented file path.');
  // Check raw segments before resolving so traversal cannot disappear during normalization.
  if (value.split('/').some(segment => segment === '..' || segment === '.')) reject('PATH_DENIED', 'Dot path segments are not supported.');
  const candidate = path.isAbsolute(value) ? (value.startsWith(aliasRoot + '/') ? path.join(root, path.relative(aliasRoot, value)) : value) : path.join(cwd, value);
  const relative = path.relative(root, candidate);
  return relativePath(relative);
}
function patchPaths(root: string, command: unknown, cwd: string, aliasRoot: string): string[] {
  if (typeof command !== 'string') reject('VALIDATION_FAILED', 'apply_patch requires command text.');
  const lines = command.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') reject('VALIDATION_FAILED', 'Unsupported patch envelope.');
  const paths: string[] = []; let operation = ''; let body = false;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) { if (operation === 'Add' && !body) reject('VALIDATION_FAILED', 'Empty patch addition.'); paths.push(filePath(root, header[2], false, cwd, aliasRoot)); operation = header[1]; body = false; continue; }
    if (line.startsWith('*** Move to: ') && operation === 'Update' && !body) { paths.push(filePath(root, line.slice(13), false, cwd, aliasRoot)); continue; }
    if (!operation || operation === 'Delete' || line.startsWith('***') && line !== '*** End of File' || operation === 'Add' && !line.startsWith('+') || operation === 'Update' && !/^(?:@@|[ +-]|\*\*\* End of File)/.test(line)) reject('VALIDATION_FAILED', 'Unsupported/malformed patch instruction.');
    body = true;
  }
  if (!paths.length || operation === 'Add' && !body) reject('VALIDATION_FAILED', 'Patch requires file operations.');
  return [...new Set(paths)];
}
// ponytail: intentionally a literal-command subset; extend only with a documented operation and boundary tests.
export function literalWords(command: string): string[] | null {
  if (command.includes('\0') || /[\n\r`$;&|<>()\\]/.test(command)) return null;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g);
  if (!tokens || tokens.join(' ').replaceAll(/\s+/g, ' ') !== command.trim().replaceAll(/\s+/g, ' ')) return null;
  return tokens.map(token => /^["']/.test(token) ? token.slice(1, -1) : token);
}
export function normalizeTool(root: string, host: HostId, input: HookInput, canonicalCwd = root): Pick<GateRequest, 'tool' | 'operation' | 'paths'> {
  const aliasRoot = path.resolve(input.cwd, path.relative(canonicalCwd, root));
  const tool = input.tool_name!; const args = input.tool_input!; let paths: string[];
  if (host === 'claude' && ['Write', 'Edit'].includes(tool)) {
    if (tool === 'Write' && typeof args.content !== 'string' || tool === 'Edit' && (typeof args.old_string !== 'string' || typeof args.new_string !== 'string')) reject('VALIDATION_FAILED', 'Invalid typed file write.');
    paths = [filePath(root, args.file_path, true, canonicalCwd, aliasRoot)];
  } else if (host === 'codex' && tool === 'apply_patch') paths = patchPaths(root, args.command, canonicalCwd, aliasRoot);
  else if (tool === 'Read') return { tool, operation: 'read', paths: [filePath(root, args.file_path, true, canonicalCwd, aliasRoot)] };
  else if (['Grep', 'Glob'].includes(tool)) return { tool, operation: 'read', paths: args.path === undefined || args.path === root ? [] : [filePath(root, args.path, true, canonicalCwd, aliasRoot)] };
  else if (['Bash', 'exec_command'].includes(tool)) {
    if (Object.hasOwn(args, 'workdir') || Object.hasOwn(args, 'cwd')) return { tool, operation: 'unknown', paths: [] };
    if (typeof args.command !== 'string') reject('VALIDATION_FAILED', 'Shell input requires documented command.');
    if (args.command === `node -e "console.log(require('node:crypto').randomUUID())"`) return { tool, operation: 'read', paths: [] };
    const tokens = literalWords(args.command); if (!tokens) return { tool, operation: 'unknown', paths: [] };
    if (tokens.length === 1 && tokens[0] === 'pwd') return { tool, operation: 'read', paths: [] };
    if (tokens[0] === 'node' && tokens[1] === installedCliPath() && tokens.length > 2) return { tool, operation: 'read', paths: [] };
    if (!['cat', 'touch', 'mkdir', 'rm'].includes(tokens[0]) || tokens[1] !== '--' || tokens.length < 3 || tokens.slice(2).some(token => token.startsWith('-') || [...token].some(character => '*?[]{}~'.includes(character)))) return { tool, operation: 'unknown', paths: [] };
    paths = tokens.slice(2).map(token => filePath(root, token, false, canonicalCwd, aliasRoot));
    if (tokens[0] === 'cat') return { tool, operation: 'read', paths };
  } else return { tool, operation: 'unknown', paths: [] };
  return { tool, operation: paths.every(file => /^planning\/changes\/[^/]+\/(?:draft\/|change\.yaml$)/.test(file)) ? 'planning_draft_write' : 'implementation_write', paths };
}
