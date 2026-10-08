import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticDiff } from '../../src/studio/lib/semantic-diff';

test('stable element diff survives order changes and preserves added/deleted/unchanged values', () => {
  const rows = semanticDiff({steps: [{id: 'A', text: 'old'}, {id: 'B', text: 'kept'}]}, {steps: [{id: 'B', text: 'kept'}, {id: 'A', text: 'new'}, {id: 'C', text: 'added'}]});
  assert.ok(rows.some(row => row.path === '/steps/@A/text' && row.operation === 'modify' && row.before === 'old' && row.after === 'new'));
  assert.ok(rows.some(row => row.path === '/steps/@B/text' && row.operation === 'unchanged'));
  assert.ok(rows.some(row => row.path === '/steps/@C/text' && row.operation === 'add' && row.after === 'added'));
  assert.ok(rows.some(row => row.path === '/steps/순서'));
  assert.deepEqual(semanticDiff({removed: false}, {added: null}).map(row => [row.path, row.operation]), [['/added', 'add'], ['/removed', 'delete']]);
});

test('prototype-looking own fields and empty/false/null content remain semantic data', () => {
  const before = JSON.parse('{"constructor":false,"__proto__":null,"empty":{}}');
  const after = JSON.parse('{"constructor":true,"empty":{},"permissions":[{"action":"read","scope":"all"}]}');
  const rows = semanticDiff(before, after);
  assert.ok(rows.some(row => row.path === '/__proto__' && row.operation === 'delete' && row.before === null && row.after === undefined));
  assert.ok(rows.some(row => row.path === '/constructor' && row.operation === 'modify' && row.before === false));
  assert.ok(rows.some(row => row.path === '/empty' && row.operation === 'unchanged'));
  assert.ok(semanticDiff(undefined, after).some(row => row.path === '/permissions' && row.operation === 'add'));
});
