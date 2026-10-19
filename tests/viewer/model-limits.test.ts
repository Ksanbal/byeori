import assert from 'node:assert/strict';
import test from 'node:test';
import type { Architecture, InformationArchitecture, PlanningObject } from '../../src/contracts';
import type { ViewerDocument } from '../../src/viewer/types';
import { buildIaOutline, buildMap, fieldLabel, navigationHash, parseNavigation, MAX_MAP_NODES, MAX_MAP_DEPTH, MAX_MAP_EDGES, MAX_OUTLINE_NODES } from '../../src/viewer/ui/model';

function document(projection: PlanningObject): ViewerDocument {
  return { id: projection.id, kind: projection.kind, path: 'planning/source/test.yaml', title: projection.title, summary: projection.summary, content: projection, projection, raw: '', raw_hash: '0'.repeat(64), semantic_hash: '0'.repeat(64), provenance: 'source' };
}
const base = { schema_version: 1 as const, id: 'IA-LARGE-001', title: 'Large source document', summary: '', aliases: [], relations: [], open_questions: [] };

test('arbitrary source property names never resolve inherited labels', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) assert.equal(fieldLabel(key), key);
  assert.equal(fieldLabel('title'), '제목');
});

test('deep valid IA parent chains cannot overflow the model stack or unbound map rendering', () => {
  const ia: InformationArchitecture = { ...base, kind: 'ia', nodes: Array.from({ length: 6000 }, (_, index) => ({ id: `NODE-${index}`, label: `Node ${index}`, screen_id: 'SCREEN-ONE', parent_id: index ? `NODE-${index - 1}` : null })) };
  const layout = buildMap([document(ia)], 'ia');
  assert.ok(layout.nodes.length > 0 && layout.nodes.length <= MAX_MAP_NODES);
  assert.equal(layout.truncated, true);
  assert.ok(layout.width < 370 + (MAX_MAP_DEPTH + 2) * 330);
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  assert.ok(layout.edges.every(edge => layout.nodes.some(node => node.key === edge.from) && layout.nodes.some(node => node.key === edge.to)));
});

test('wide IA trees have bounded graph size while the original document retains every item', () => {
  const ia: InformationArchitecture = { ...base, kind: 'ia', nodes: Array.from({ length: 6000 }, (_, index) => ({ id: `NODE-${index}`, label: `Node ${index}`, screen_id: 'SCREEN-ONE', parent_id: null })) };
  const item = document(ia); const layout = buildMap([item], 'ia');
  assert.ok(layout.nodes.length <= MAX_MAP_NODES);
  assert.ok(layout.edges.length <= MAX_MAP_NODES);
  assert.equal(layout.truncated, true);
  assert.equal(ia.nodes.length, 6000, 'layout does not mutate source content');
});

test('architecture component and edge lists are bounded for large valid documents', () => {
  const architecture: Architecture = { ...base, id: 'ARCH-LARGE-001', kind: 'architecture', components: Array.from({ length: 6000 }, (_, index) => ({ id: `COMP-${index}`, title: `Component ${index}`, responsibility: 'Inspect only' })), connections: Array.from({ length: 5999 }, (_, index) => ({ id: `CONN-${index}`, from: `COMP-${index}`, to: `COMP-${index + 1}`, protocol: 'HTTP' })), decisions: [] };
  const layout = buildMap([document(architecture)], 'architecture');
  assert.ok(layout.nodes.length <= MAX_MAP_NODES);
  assert.ok(layout.edges.length <= MAX_MAP_NODES);
  assert.equal(layout.truncated, true);
  assert.equal(architecture.components.length, 6000);
});

test('navigation round-trips arbitrary text and never promotes an unknown kind', () => {
  const navigation = { kind: 'ia' as const, documentId: '<script>&#=data', elementId: 'node/#?' };
  assert.deepEqual(parseNavigation(navigationHash(navigation)), navigation);
  assert.equal(parseNavigation('#tab=__proto__&doc=anything').kind, 'all');
});

test('outline limits preserve late-ordered ancestors and never lose the root', () => {
  const nodes: InformationArchitecture['nodes'] = Array.from({ length: 250 }, (_, index) => ({ id: `CHILD-${index}`, label: `Child ${index}`, screen_id: 'SCREEN-ONE', parent_id: 'ROOT' }));
  nodes.push({ id: 'ROOT', label: 'Root stored last', screen_id: 'SCREEN-ONE', parent_id: null });
  const outline = buildIaOutline(nodes);
  assert.equal(outline.nodes.length, 1);
  assert.equal(outline.nodes[0].item.id, 'ROOT');
  assert.equal(outline.nodes[0].children.length, MAX_OUTLINE_NODES - 1);
  assert.equal(outline.truncated, true);
  assert.equal(nodes.length, 251);
});

test('small architecture graphs explicitly disclose truncated connection lists', () => {
  const architecture: Architecture = { ...base, id: 'ARCH-DENSE-001', kind: 'architecture', components: [{ id: 'A', title: 'A', responsibility: '' }, { id: 'B', title: 'B', responsibility: '' }], connections: Array.from({ length: MAX_MAP_EDGES + 1 }, (_, index) => ({ id: `C-${index}`, from: 'A', to: 'B', protocol: 'HTTP' })), decisions: [] };
  const layout = buildMap([document(architecture)], 'architecture');
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, MAX_MAP_EDGES);
  assert.equal(layout.truncated, true);
});
