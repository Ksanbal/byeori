import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { GateRequest, HostId } from '../contracts';
import { isObject } from '../core/documents';
import { reject } from '../core/errors';
import { parseYaml, semanticHash } from '../core/yaml';
import { installedCliPath } from './config';
import { literalWords, type HookInput } from './normalize';

export const TICKET_COMMAND = `node -e "console.log(require('node:crypto').randomUUID())"`;
export function hookTicket(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) reject('VALIDATION_FAILED', 'Hook ticket must be a fresh literal crypto.randomUUID() value.');
  return value;
}
export interface LiteralGate { ticket: string; request: GateRequest; argv_hash: string; command_hash: string }
export async function literalGate(root: string, host: HostId, input: HookInput): Promise<LiteralGate | null> {
  if (!['Bash', 'exec_command'].includes(input.tool_name ?? '') || typeof input.tool_input?.command !== 'string' || Object.hasOwn(input.tool_input, 'workdir') || Object.hasOwn(input.tool_input, 'cwd')) return null;
  const command = input.tool_input.command; const words = literalWords(command);
  if (!words || words.length !== 11 || words[0] !== 'node' || words[2] !== 'gate' || words[3] !== 'check' || words[4] !== '--root' || words[6] !== '--json' || words[7] !== '--hook-ticket' || words[9] !== '--input') return null;
  try {
    const cli = await realpath(words[1]); if (cli !== await realpath(installedCliPath()) || await realpath(words[5]) !== root) return null;
    const ticket = hookTicket(words[8]); JSON.parse(words[10]); const value = parseYaml(words[10]); const fields = ['project_id', 'workspace_fingerprint', 'host', 'tool', 'operation', 'paths'];
    if (!isObject(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || value.host !== host || typeof value.project_id !== 'string' || typeof value.workspace_fingerprint !== 'string' || typeof value.tool !== 'string' || value.operation !== 'implementation_write' || !Array.isArray(value.paths) || value.paths.some(file => typeof file !== 'string')) return null;
    return { ticket, request: value as unknown as GateRequest, argv_hash: semanticHash([cli, ...words.slice(2)]), command_hash: semanticHash(command) };
  } catch { return null; }
}
export function actualArgvHash(cli: string, argv: string[]): string { return semanticHash([path.resolve(cli), ...argv]); }

export interface ReceiptHashes { ticket: string; request_hash: string; argv_hash: string; command_hash: string; session_hash: string; cli_hash: string; issued_at: string }
export function receiptMatches(receipt: ReceiptHashes, expected: { ticket: string; request: GateRequest; argv_hash: string; session_hash: string; cli_hash: string; now: number }): boolean {
  const age = expected.now - Date.parse(receipt.issued_at);
  return Number.isFinite(age) && age >= 0 && age <= 2000 && receipt.ticket === expected.ticket && receipt.request_hash === semanticHash(expected.request) && receipt.argv_hash === expected.argv_hash && receipt.cli_hash === expected.cli_hash && receipt.session_hash === expected.session_hash && /^[a-f0-9]{64}$/.test(receipt.session_hash) && /^[a-f0-9]{64}$/.test(receipt.command_hash);
}
