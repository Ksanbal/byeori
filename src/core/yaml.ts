import { createHash } from 'node:crypto';
import { CST, Lexer, isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { JsonValue } from '../contracts';
import { reject } from './errors';

export const PROFILE = { max_bytes: 1_048_576, max_depth: 64, max_nodes: 100_000 } as const;
export const VERSIONS = { schema_version: 1, policy_version: '1', canonicalization_version: 'json-sorted-v1' } as const;
export function rawHash(raw: string): string { return createHash('sha256').update(raw, 'utf8').digest('hex'); }
export function checkRaw(raw: string): void {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > PROFILE.max_bytes) reject('VALIDATION_FAILED', 'YAML exceeds the 1 MiB document limit.');
  if (Buffer.from(raw, 'utf8').toString('utf8') !== raw) reject('VALIDATION_FAILED', 'Raw text must be losslessly representable as UTF-8.');
}
/** Walk the AST ourselves: no alias expansion, prototype mutation or lossy integer conversion. */
export function parseYaml(raw: string): JsonValue {
  checkRaw(raw);
  let flowDepth = 0;
  for (const token of new Lexer().lex(raw)) {
    const type = CST.tokenType(token);
    if (type === 'anchor' || type === 'alias' || type === 'tag') reject('VALIDATION_FAILED', 'Anchors, aliases and explicit tags are outside the YAML profile.');
    if (type === 'flow-map-start' || type === 'flow-seq-start') {
      if (++flowDepth > PROFILE.max_depth) reject('VALIDATION_FAILED', 'YAML nesting exceeds depth 64.');
    } else if (type === 'flow-map-end' || type === 'flow-seq-end') flowDepth--;
    if (token.startsWith('%') && type === 'directive-line') reject('VALIDATION_FAILED', 'YAML directives are outside the fixed 1.2 profile.');
  }
  try {
    const documents = parseAllDocuments(raw, { version: '1.2', schema: 'core', intAsBigInt: true, uniqueKeys: true, strict: true });
    if (documents.length !== 1) reject('VALIDATION_FAILED', 'Exactly one YAML document is required.');
    const document = documents[0];
    if (document.errors.length || document.warnings.length) reject('VALIDATION_FAILED', [...document.errors, ...document.warnings].map(error => error.message).join('; '));
    let nodes = 0;
    const convert = (node: unknown, depth: number): JsonValue => {
      if (depth > PROFILE.max_depth || ++nodes > PROFILE.max_nodes) reject('VALIDATION_FAILED', 'YAML depth/node limit exceeded.');
      if (node === null) return null;
      if (!isNode(node)) reject('VALIDATION_FAILED', 'Unsupported YAML node.');
      if (isAlias(node) || ('anchor' in node && node.anchor) || ('tag' in node && node.tag)) reject('VALIDATION_FAILED', 'Tagged/anchored/alias nodes are not permitted.');
      if (isScalar(node)) {
        const value: unknown = node.value;
        if (typeof value === 'bigint') {
          if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) reject('VALIDATION_FAILED', 'Unsafe integers must be strings.');
          return Number(value);
        }
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
        reject('VALIDATION_FAILED', 'Only finite JSON-compatible scalars and safe integers are permitted.');
      }
      if (isSeq(node)) return node.items.map(item => convert(item, depth + 1));
      if (isMap(node)) {
        const result = Object.create(null) as Record<string, JsonValue>;
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') reject('VALIDATION_FAILED', 'Map keys must be strings.');
          const key = pair.key.value;
          if (key === '<<') reject('VALIDATION_FAILED', 'Merge keys are not permitted.');
          if (Object.hasOwn(result, key)) reject('VALIDATION_FAILED', `Duplicate key: ${key}`);
          if (++nodes > PROFILE.max_nodes) reject('VALIDATION_FAILED', 'YAML node limit exceeded.');
          result[key] = convert(pair.value, depth + 1);
        }
        return result;
      }
      reject('VALIDATION_FAILED', 'Unsupported YAML node.');
    };
    return convert(document.contents, 0);
  } catch (error) {
    if (error instanceof Error && error.name === 'CoreError') throw error;
    reject('VALIDATION_FAILED', `YAML parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Explicit serialization keeps numeric-looking and prototype-looking keys in ordinal order. */
export function canonicalJson(value: unknown): string {
  let count = 0;
  const ancestors = new Set<object>();
  const encode = (item: unknown, depth: number): string => {
    if (++count > PROFILE.max_nodes || depth > PROFILE.max_depth) reject('VALIDATION_FAILED', 'Canonical value exceeds depth/node limits.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item)) reject('VALIDATION_FAILED', 'Canonicalization requires acyclic JSON values.');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== null && prototype !== Object.prototype) reject('VALIDATION_FAILED', 'Canonicalization rejects non-JSON objects.');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = '[' + Array.from(item, child => encode(child, depth + 1)).join(',') + ']';
    } else {
      const object = item as Record<string, unknown>;
      result = '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + encode(object[key], depth + 1)).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  };
  return encode(value, 0);
}
export function semanticHash(value: unknown): string { return rawHash(canonicalJson(value)); }
