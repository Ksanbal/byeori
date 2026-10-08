import { stringify } from 'yaml';
import type { ContractVersions, JsonObject, ReviewBinding } from '../contracts';
import { isObject } from './documents';
import { reject } from './errors';
import { listFiles, readText, recordId } from './paths';
import { canonicalJson, parseYaml, VERSIONS } from './yaml';
import type { Writer } from './ownership';

export function exactRecord(value: unknown, keys: string[], label: string): asserts value is JsonObject {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) reject('VALIDATION_FAILED', 'Invalid ' + label + ' record fields.');
}
export function hashValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) reject('VALIDATION_FAILED', 'Invalid SHA-256 hash.');
}
export function stringValue(value: unknown): asserts value is string { if (typeof value !== 'string' || !value) reject('VALIDATION_FAILED', 'Expected a nonempty record string.'); }
export function versions(value: ContractVersions): void {
  for (const [key, expected] of Object.entries(VERSIONS)) if (value[key as keyof ContractVersions] !== expected) reject('POLICY_MISMATCH', 'Unsupported record policy/schema/canonicalization version.');
}
export function binding(value: ReviewBinding): void {
  recordId(value.project_id); recordId(value.change_id); hashValue(value.workspace_fingerprint); hashValue(value.manifest_hash);
  if (!Number.isSafeInteger(value.round) || value.round < 1) reject('VALIDATION_FAILED', 'Invalid round number.');
}
export function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
export async function readRecord<T>(root: string, file: string): Promise<T> { return parseYaml(await readText(root, file)) as unknown as T; }
export async function putRecord(writer: Writer, file: string, value: unknown, createOnly = true): Promise<void> { await writer.write(file, stringify(value), createOnly); }
export async function recordFiles(root: string, suffix: string): Promise<string[]> { return (await listFiles(root, 'planning/changes')).filter(file => file.endsWith('/' + suffix)); }
