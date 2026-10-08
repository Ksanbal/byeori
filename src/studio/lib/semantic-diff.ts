import type { JsonValue } from '../../contracts';
import { stable } from './review-session';
export interface SemanticChange { path: string; operation: 'add' | 'delete' | 'modify' | 'unchanged'; before: JsonValue | undefined; after: JsonValue | undefined }
const token = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
function object(value: JsonValue | undefined): value is {[key: string]: JsonValue} { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keyed(value: JsonValue | undefined): value is ({id: string} & {[key: string]: JsonValue})[] { return Array.isArray(value) && value.length > 0 && value.every(item => object(item) && typeof item.id === 'string') && new Set(value.map(item => (item as {id: string}).id)).size === value.length; }
export function semanticDiff(before: JsonValue | undefined, after: JsonValue | undefined, path = ''): SemanticChange[] {
  if ((object(before) || before === undefined) && (object(after) || after === undefined) && (object(before) || object(after))) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
    if (keys.length) return keys.flatMap(key => semanticDiff(before && Object.hasOwn(before, key) ? before[key] : undefined, after && Object.hasOwn(after, key) ? after[key] : undefined, path + '/' + token(key)));
  }
  if (keyed(before) && keyed(after)) {
    const prior = new Map(before.map(item => [item.id, item])); const next = new Map(after.map(item => [item.id, item]));
    const entries = [...new Set([...prior.keys(), ...next.keys()])].flatMap(id => semanticDiff(prior.get(id), next.get(id), path + '/@' + token(id)));
    if (stable(before.map(item => item.id)) !== stable(after.map(item => item.id))) entries.unshift({path: path + '/순서', operation: 'modify', before: before.map(item => item.id), after: after.map(item => item.id)});
    return entries;
  }
  return [{path: path || '/', operation: before === undefined ? 'add' : after === undefined ? 'delete' : stable(before) === stable(after) ? 'unchanged' : 'modify', before, after}];
}
