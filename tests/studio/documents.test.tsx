import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import type {DocumentView, JsonValue} from '../../src/contracts';
import {parseDocument} from '../../src/core/documents';
import {DocumentBody, ValueTree} from '../../src/studio/documents';
import {diagramData, sketchOffset} from '../../src/studio/visualizations/DataDiagram';

const directory = new URL('../fixtures/planning/', import.meta.url);
function leaves(value: JsonValue, keys = true): string[] {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return value.flatMap(item => leaves(item, keys));
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [...(keys ? [key] : []), ...leaves(item, keys)]);
  return [String(value)];
}
const escape = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#x27;');
for (const name of readdirSync(directory).filter(name => name.endsWith('.yaml'))) test(`full structured ${name} retains every content value without raw YAML`, () => {
  const parsed = parseDocument({path: 'planning/source/' + name, raw: readFileSync(new URL(name,directory),'utf8')});
  const view: DocumentView = {id: parsed.id, kind: parsed.kind, path: parsed.path, raw: 'RAW_NOT_RENDERED', content: parsed.content, projection: parsed.projection, semantic_hash: parsed.content_hash, raw_hash: parsed.raw_hash, provenance: 'review_snapshot', revision: {change_id:'synthetic', round:1, manifest_hash:parsed.content_hash, side:'after'}};
  const html = renderToStaticMarkup(createElement(DocumentBody, {view, onNavigate: ()=>{}, knownIds:[]}));
  assert.ok(!html.includes('RAW_NOT_RENDERED'));
  // Native field labels are Korean; assert all leaf values, not English property keys.
  const values = parsed.kind === 'openapi' ? leaves(parsed.content as JsonValue) : leaves(parsed.content as JsonValue, false);
  for (const value of values) if(value && !['true','false','null'].includes(value)) assert.ok(html.includes(escape(value)), `Missing ${name}: ${value}`);
});
test('nested OpenAPI values remain text with empty values and no active remote refs', () => {
 const value = {extensions: {html: '<img src=x onerror=alert(1)>', '$ref':'https://example.invalid/schema', flag:false, nil:null, object:{}, list:[]}};
 const html = renderToStaticMarkup(createElement(ValueTree, {value}));
 assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href='));
 for(const text of ['false','null','{}','[]','https://example.invalid/schema']) assert.ok(html.includes(text));
});
test('diagram nodes/edges and sketch offsets are deterministic from document data', () => {
 const parsed = parseDocument({path:'planning/source/scenario.yaml',raw:readFileSync(new URL('scenario.yaml',directory),'utf8')});
 assert.equal(parsed.projection.kind,'scenario'); if(parsed.projection.kind!=='scenario') return;
 const data=diagramData(parsed.projection); assert.equal(data.nodes.length,parsed.projection.steps.length); assert.equal(data.edges[0].from,parsed.projection.steps[0].id);
 assert.deepEqual(diagramData(parsed.projection), data); assert.equal(sketchOffset(JSON.stringify(parsed.projection)),sketchOffset(JSON.stringify(parsed.projection)));
});
