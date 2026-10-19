import assert from 'node:assert/strict';
import test from 'node:test';
import type { InformationArchitecture } from '../../src/contracts';
import { parseDocument } from '../../src/core/documents';
import { CoreError } from '../../src/core/errors';
import { PROFILE } from '../../src/core/yaml';

type IaNode = InformationArchitecture['nodes'][number];
const sourcePath = 'planning/source/ia-performance.yaml';
function node(id: string, parent: string | null): IaNode {
  return { id, parent_id: parent, label: id, screen_id: 'SCR-PERFORMANCE-001' };
}
function input(nodes: IaNode[]) {
  const document: InformationArchitecture = { schema_version: 1, id: 'IA-PERFORMANCE-001', kind: 'ia', title: 'IA validation regression', summary: 'Synthetic bounded hierarchy', aliases: [], relations: [], open_questions: [], nodes };
  return { path: sourcePath, raw: JSON.stringify(document) };
}
function invalid(nodes: IaNode[]): void {
  assert.throws(() => parseDocument(input(nodes)), error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.message, 'IA parent is missing or cyclic.');
    assert.equal(error.diagnostics[0].code, 'VALIDATION_FAILED');
    assert.equal(error.diagnostics[0].path, sourcePath);
    assert.equal(error.diagnostics[0].field, 'nodes');
    return true;
  });
}

test('IA validation preserves missing-parent and cycle errors in every source order', () => {
  for (const nodes of [
    [node('A', 'MISSING')],
    [node('A', 'B'), node('B', 'MISSING')],
    [node('A', 'A')],
    [node('A', 'B'), node('B', 'A')],
    [node('ROOT', null), node('VALID', 'ROOT'), node('A', 'B'), node('B', 'C'), node('C', 'B')],
  ]) {
    invalid(nodes);
    invalid([...nodes].reverse());
  }
});

test('IA validation accepts wide forests and source order with children before parents', () => {
  const nodes = [node('ROOT-A', null), node('ROOT-B', null), ...Array.from({ length: 2000 }, (_, index) => node('CHILD-' + index, index % 2 ? 'ROOT-A' : 'ROOT-B'))];
  for (const ordered of [nodes, [...nodes].reverse()]) {
    const document = parseDocument(input(ordered));
    assert.equal(document.projection.kind, 'ia');
    if (document.projection.kind === 'ia') assert.deepEqual(document.projection.nodes.map(item => ({ ...item })), ordered);
  }
});

test('IA parent traversal is linear for deep chains in both source orders', () => {
  const count = 8000;
  const prefix = 'IA-PERF-';
  const nodes = Array.from({ length: count }, (_, index) => node(prefix + index, index ? prefix + (index - 1) : null));
  for (const ordered of [nodes, [...nodes].reverse()]) {
    const source = input(ordered);
    assert.ok(Buffer.byteLength(source.raw) < PROFILE.max_bytes, 'The regression must remain within the actual YAML input budget');
    let parentReads = 0;
    const get = Map.prototype.get;
    // Count parent-map reads rather than elapsed time: slow CI stays reliable,
    // while rewalking every ancestor would require count * (count + 1) / 2 reads.
    Map.prototype.get = function (key: unknown) {
      if (this.size === count && typeof key === 'string' && key.startsWith(prefix)) parentReads++;
      return get.call(this, key);
    };
    try {
      const document = parseDocument(source);
      assert.equal(document.projection.kind, 'ia');
      if (document.projection.kind === 'ia') assert.deepEqual(document.projection.nodes.map(item => ({ ...item })), ordered);
    } finally { Map.prototype.get = get; }
    assert.ok(parentReads >= count, 'Instrumentation must observe the complete parent traversal');
    assert.ok(parentReads <= count * 2, `Expected linear parent traversal; observed ${parentReads} reads for ${count} nodes`);
  }
});
