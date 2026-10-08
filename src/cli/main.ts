#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoreApi, QueryScope, Result } from '../contracts';
import { DIAGNOSTIC_EXIT_CODES, DOCUMENT_KINDS } from '../contracts';
import { doctor, lint } from '../core/diagnostics';
import { isObject } from '../core/documents';
import { CoreError, reject } from '../core/errors';
import { createReviewCore, result } from '../core/services';
import { impact, rebuildIndex, search } from '../core/search';
import { parseYaml, PROFILE } from '../core/yaml';
import { studio } from './studio';

const complex = {
  'change create': ['createChange', ['project_id', 'workspace_fingerprint', 'metadata'], ['display_name']],
  'change update': ['updateChange', ['project_id', 'workspace_fingerprint', 'change_id', 'expected_version', 'metadata'], []],
  'change put': ['putDraft', ['project_id', 'workspace_fingerprint', 'change_id', 'expected_version', 'object_id', 'kind', 'path', 'raw'], []],
  'change delete': ['deleteDraft', ['project_id', 'workspace_fingerprint', 'change_id', 'expected_version', 'object_id'], []],
  'change move': ['moveDraft', ['project_id', 'workspace_fingerprint', 'change_id', 'expected_version', 'object_id', 'path'], []],
  'change cancel': ['cancelChange', ['project_id', 'workspace_fingerprint', 'change_id', 'expected_version', 'reason'], []],
  'review prepare': ['prepareReview', ['project_id', 'workspace_fingerprint', 'change_id', 'expected_version'], []],
  'review results': ['reviewResults', ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash'], []],
  'review respond': ['respond', ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash', 'submission_id', 'response_id', 'expected_change_version', 'comments'], []],
  'workflow write': ['writeWorkflow', ['project_id', 'workspace_fingerprint', 'expected_version', 'workflow'], []],
  apply: ['apply', ['project_id', 'workspace_fingerprint', 'change_id', 'round', 'manifest_hash'], []],
  recover: ['recover', ['project_id', 'workspace_fingerprint', 'change_id', 'action'], []],
  'gate check': ['gateCheck', ['project_id', 'workspace_fingerprint', 'host', 'tool', 'operation', 'paths'], []],
} as const;
const simpleHelp = {
  help: '--help is an alias; no initialized workspace required',
  init: '[--name <name>]', doctor: '', status: '',
  search: '--query <text> [--scope <scope>] [--limit <1..25>] [--kinds <comma-separated-kinds>]',
  get: '--id <id> [--scope <scope>] OR --input <JSON GetRequest: object_id, optional scope/revision>',
  impact: '--id <id> [--scope <scope>] [--depth <1..5>] [--limit <1..100>]',
  history: '[--id <id>] [--change <id>] [--limit <1..100>] [--cursor <offset>]',
  lint: '[--scope <scope>] [--stage structural|review_ready|implementation_ready]',
  'index rebuild': '[--scope <scope>]',
  studio: '--action start|status|stop; start only: [--assets <trusted-build-directory>] [--port <0..65535>]',
} as const;
function help() {
  return {
    executable: 'byeori', global_flags: ['--root <workspace>', '--json'],
    commands: [
      ...Object.entries(simpleHelp).map(([command, flags]) => ({ command, flags })),
      ...Object.entries(complex).map(([command, [, required, optional]]) => ({ command, flags: '--input <JSON object>', required_fields: required, optional_fields: optional })),
    ],
    scopes: ['approved', 'change:<id>', 'history', 'history:<id>', 'history:<id>:<round>'],
    document_kinds: DOCUMENT_KINDS,
    input: 'One literal JSON object, maximum 1 MiB and OS argv limits; duplicate/unknown/missing fields fail. Command words precede flags; flags cannot repeat.',
    authorization: 'Supply binding/CAS from status/review results. CLI has no human approval or advisory submission command.',
    output: 'One Result JSON object on stdout; runtime diagnostics on stderr; diagnostic-specific exit codes.',
  };
}
function jsonInput(raw: string, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (Buffer.byteLength(raw) > PROFILE.max_bytes) reject('VALIDATION_FAILED', 'JSON input exceeds 1 MiB.');
  try { JSON.parse(raw); } catch { reject('VALIDATION_FAILED', 'Input must be one JSON object.'); }
  const value = parseYaml(raw); if (!isObject(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) reject('VALIDATION_FAILED', 'Input has missing/unknown fields.');
  for (const [key, item] of Object.entries(value)) {
    if (['metadata', 'workflow', 'scope', 'revision'].includes(key)) { if (!isObject(item)) reject('VALIDATION_FAILED', 'Expected object field: ' + key); }
    else if (['comments', 'paths'].includes(key)) { if (!Array.isArray(item)) reject('VALIDATION_FAILED', 'Expected array field: ' + key); }
    else if (['round', 'limit', 'depth'].includes(key)) { if (!Number.isSafeInteger(item)) reject('VALIDATION_FAILED', 'Expected integer field: ' + key); }
    else if (typeof item !== 'string') reject('VALIDATION_FAILED', 'Expected string field: ' + key);
  }
  return value;
}
function scope(value: string | undefined): QueryScope | undefined {
  if (value === undefined) return undefined; if (value === 'approved') return { type: 'approved' }; if (value === 'history') return { type: 'history' };
  const parts = value.split(':'); if (parts[0] === 'change' && parts.length === 2) return { type: 'change', change_id: parts[1] };
  if (parts[0] === 'history' && [2, 3].includes(parts.length)) return { type: 'history', change_id: parts[1], ...(parts.length === 3 ? { round: number(parts[2]) } : {}) };
  reject('VALIDATION_FAILED', 'Scope must be approved, change:<id>, history or history:<id>[:round].');
}
function number(value: string | undefined): number | undefined { if (value === undefined) return undefined; if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) reject('VALIDATION_FAILED', 'Expected nonnegative integer flag.'); return Number(value); }
export async function execute(argv: string[]): Promise<Result<unknown>> {
  return result(async () => {
    const words: string[] = []; const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index];
      if (!argument.startsWith('--')) { if (flags.size) reject('VALIDATION_FAILED', 'Command words must precede flags.'); words.push(argument); continue; }
      if (flags.has(argument)) reject('VALIDATION_FAILED', 'Duplicate flag: ' + argument);
      if (argument === '--json' || argument === '--help') flags.set(argument, 'true');
      else { const value = argv[++index]; if (value === undefined || value.startsWith('--')) reject('VALIDATION_FAILED', 'Missing flag value.'); flags.set(argument, value); }
    }
    const command = words.join(' '); const root = path.resolve(flags.get('--root') ?? process.cwd());
    const allow = (...keys: string[]) => { for (const key of flags.keys()) if (!['--root', '--json', ...keys].includes(key)) reject('VALIDATION_FAILED', 'Unknown flag: ' + key); };
    const requireFlag = (key: string): string => { const value = flags.get(key); if (value === undefined) reject('VALIDATION_FAILED', 'Missing flag: ' + key); return value; };
    if (command === 'help' || !command && flags.has('--help')) { allow('--help'); return help(); }
    const core: CoreApi = { ...createReviewCore(root), doctor: () => result(() => doctor(root)), lint: input => result(() => lint(root, input)), search: input => result(() => search(root, input)), impact: input => result(() => impact(root, input)), rebuildIndex: input => result(() => rebuildIndex(root, input.scope)), studio: input => studio(root, input.action) };
    let response: Result<unknown>;
    if (Object.hasOwn(complex, command)) {
      allow('--input'); const [method, required, optional] = complex[command as keyof typeof complex]; const input = jsonInput(requireFlag('--input'), required, optional);
      response = await (core[method] as unknown as (value: Record<string, unknown>) => Promise<Result<unknown>>)(input);
    } else switch (command) {
      case 'init': allow('--name'); response = await core.init({ root, name: flags.get('--name') }); break;
      case 'doctor': allow(); response = await core.doctor(); break;
      case 'status': allow(); response = await core.status(); break;
      case 'search': { allow('--query', '--scope', '--limit', '--kinds'); const kinds = flags.get('--kinds')?.split(','); if (kinds?.some(kind => !DOCUMENT_KINDS.includes(kind as typeof DOCUMENT_KINDS[number]))) reject('VALIDATION_FAILED', 'Unknown search kind.'); response = await core.search({ query: requireFlag('--query'), scope: scope(flags.get('--scope')), limit: number(flags.get('--limit')), kinds: kinds as typeof DOCUMENT_KINDS[number][] | undefined }); break; }
      case 'get': allow('--id', '--scope', '--input'); response = flags.has('--input') ? (allow('--input'), await core.get(jsonInput(requireFlag('--input'), ['object_id'], ['scope', 'revision']) as unknown as Parameters<CoreApi['get']>[0])) : await core.get({ object_id: requireFlag('--id'), scope: scope(flags.get('--scope')) }); break;
      case 'impact': allow('--id', '--scope', '--depth', '--limit'); response = await core.impact({ object_id: requireFlag('--id'), scope: scope(flags.get('--scope')), depth: number(flags.get('--depth')), limit: number(flags.get('--limit')) }); break;
      case 'history': allow('--id', '--change', '--limit', '--cursor'); response = await core.history({ object_id: flags.get('--id'), change_id: flags.get('--change'), limit: number(flags.get('--limit')), cursor: flags.get('--cursor') }); break;
      case 'lint': { allow('--scope', '--stage'); const stage = flags.get('--stage'); if (stage && !['structural', 'review_ready', 'implementation_ready'].includes(stage)) reject('VALIDATION_FAILED', 'Unknown lint stage.'); response = await core.lint({ scope: scope(flags.get('--scope')), stage: stage as Parameters<CoreApi['lint']>[0]['stage'] }); break; }
      case 'index rebuild': allow('--scope'); response = await core.rebuildIndex({ scope: scope(flags.get('--scope')) }); break;
      case 'studio': { allow('--action', '--assets', '--port'); const action = requireFlag('--action'); if (!['start', 'status', 'stop'].includes(action)) reject('VALIDATION_FAILED', 'Unknown Studio action.'); if (action !== 'start' && (flags.has('--assets') || flags.has('--port'))) reject('VALIDATION_FAILED', 'Assets/port are launch-only flags.'); response = await studio(root, action as 'start' | 'status' | 'stop', { assetsRoot: flags.get('--assets'), port: number(flags.get('--port')) }); break; }
      default: { const error = new CoreError('VALIDATION_FAILED', 'Unknown command.'); error.diagnostics[0].suggested_action = 'Run byeori --help --json for command and flag usage.'; throw error; }
    }
    // Unwrap once so parsing and real Core failures share the one output envelope.
    if (!response.ok) { const { CoreError } = await import('../core/errors'); const diagnostic = response.diagnostics[0]; throw new CoreError(diagnostic.code, diagnostic.message, diagnostic.path, diagnostic.field); }
    return response.data;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const response = await execute(process.argv.slice(2)); process.stdout.write(JSON.stringify(response) + '\n'); process.exitCode = response.ok ? 0 : DIAGNOSTIC_EXIT_CODES[response.diagnostics[0].code];
}
