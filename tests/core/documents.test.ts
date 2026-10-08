import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { stringify } from 'yaml';
import { CoreError } from '../../src/core/errors';
import { canonicalJson, parseYaml, PROFILE, semanticHash } from '../../src/core/yaml';
import { parseDocument, projectSource, sourceManifest, validateSource } from '../../src/core/documents';

const fixtureDirectory = new URL('../fixtures/planning/', import.meta.url);
const inputs = readdirSync(fixtureDirectory).filter(name => name.endsWith('.yaml')).map(name => ({ path: 'planning/source/' + name, raw: readFileSync(new URL(name, fixtureDirectory), 'utf8') }));
function bad(action: () => unknown, code = 'VALIDATION_FAILED'): void { assert.throws(action, error => error instanceof CoreError && error.diagnostics[0].code === code); }
function edit(name: string, change: (value: Record<string, unknown>) => void) {
  return inputs.map(input => {
    if (!input.path.endsWith('/' + name)) return input;
    const value = parseYaml(input.raw) as Record<string, unknown>; change(value);
    return { ...input, raw: stringify(value) };
  });
}

test('YAML JSON profile rejects unsafe syntax, scalars and resource excess', () => {
  for (const raw of ['a: 1\na: 2\n', 'a: &x 1\nb: *x', 'a: !evil hi', 'a: {<<: {x: 1}}', 'a: 1\n---\nb: 2', 'true: value', '? [a,b]\n: value', 'a: .inf', 'a: .nan', 'a: 9007199254740993', 'a: 1e100', '%YAML 1.1\n---\na: yes']) bad(() => parseYaml(raw));
  bad(() => parseYaml('['.repeat(65) + '0' + ']'.repeat(65)));
  bad(() => parseYaml('a: ' + 'x'.repeat(PROFILE.max_bytes)));
  bad(() => parseYaml('[' + 'null,'.repeat(PROFILE.max_nodes + 1) + ']'));
  assert.equal((parseYaml('integer: 9007199254740991\nlarge: "9007199254740993"\ntruth: true\ntext: yes') as Record<string, unknown>).text, 'yes');
});

test('canonicalization preserves arbitrary keys/string semantics and array ordering', () => {
  const value = parseYaml('"__proto__": {polluted: true}\nconstructor: 4\n"10": ten\n"2": two');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(canonicalJson(value), '{"10":"ten","2":"two","__proto__":{"polluted":true},"constructor":4}');
  assert.equal(semanticHash(parseYaml('a: 1\nb: [x,y]')), semanticHash(parseYaml('#style\nb: [x, y]\na: 1.0')));
  assert.notEqual(semanticHash(parseYaml('b: [x,y]')), semanticHash(parseYaml('b: [y,x]')));
  bad(() => canonicalJson({ value: NaN }));
  const circular: Record<string, unknown> = {}; circular.self = circular; bad(() => canonicalJson(circular));
});

test('all nine full synthetic documents and complete source references validate offline', () => {
  const documents = validateSource(inputs);
  assert.equal(documents.length, 9);
  assert.equal(new Set(documents.map(document => document.kind)).size, 9);
  const api = documents.find(document => document.kind === 'openapi')!;
  assert.equal(api.projection.kind === 'openapi' && api.projection.operations[0].operation_id, 'sendMessage');
  assert.equal(sourceManifest('project-1', documents).entries.length, 9);
  assert.equal(parseDocument(inputs[0]).raw, inputs[0].raw);
});

test('complete projection rejects deletes, duplicate IDs/paths, typed refs and dependency cycles', () => {
  bad(() => projectSource(inputs, [{ operation: 'delete', object_id: 'ACT-WORKER-001' }]));
  bad(() => projectSource(inputs, [{ operation: 'move', object_id: 'ACT-WORKER-001', path: 'planning/source/FEATURE.yaml' }]));
  bad(() => validateSource([...inputs, { ...inputs[0], path: 'planning/source/copy.yaml' }]));
  bad(() => validateSource(edit('scenario.yaml', value => { value.actors = ['SCR-MSG-001']; })));
  bad(() => validateSource(edit('feature.yaml', value => { value.rules = [{ id: 'duplicate', text: 'One' }, { id: 'duplicate', text: 'Two' }]; })));
  bad(() => validateSource(edit('entity.yaml', value => { value.primary_key = ['missing']; })));
  bad(() => validateSource(edit('entity.yaml', value => { value.fields = [{ id: 'same', name: 'other', type: 'string', nullable: false }, { id: 'different', name: 'same', type: 'string', nullable: false }]; value.primary_key = ['same']; })));
  bad(() => validateSource(edit('ia.yaml', value => { value.nodes = [{ id: 'n1', parent_id: 'n2', screen_id: 'SCR-MSG-001', label: 'One' }, { id: 'n2', parent_id: 'n1', screen_id: 'SCR-MSG-001', label: 'Two' }]; })));
  const cyclic = edit('feature.yaml', value => { value.relations = [{ type: 'depends_on', target: 'SCN-MSG-001' }]; }).map(input => {
    if (!input.path.endsWith('/scenario.yaml')) return input;
    const value = parseYaml(input.raw) as Record<string, unknown>; value.relations = [{ type: 'depends_on', target: 'FEAT-MSG-001' }]; return { ...input, raw: stringify(value) };
  });
  bad(() => validateSource(cyclic));
  assert.equal(validateSource(cyclic.map(input => ({ ...input, raw: input.raw.replaceAll('depends_on', 'related_to') }))).length, 9);
});

test('official OAS structure and embedded JSON Schema dialect reject independent invalid cases', () => {
  const apiInput = inputs.find(input => input.path.endsWith('/openapi.yaml'))!;
  const api = parseYaml(apiInput.raw) as Record<string, unknown>;
  for (const schema of [{ type: 'invalid' }, { type: 'object', properties: { nested: { type: 42 } } }, { required: 'not-array' }, { type: 'string', discriminator: { propertyName: 42 } }, { type: 'string', pattern: '[' }]) {
    const value = structuredClone(api) as Record<string, unknown>; value.components = { schemas: { Test: schema } }; bad(() => parseDocument({ ...apiInput, raw: stringify(value) }));
  }
  bad(() => parseDocument({ ...apiInput, raw: stringify({ openapi: '3.1.1', info: api.info, paths: { '/x': { get: { operationId: 'read', responses: { '200': {} } } } } }) }));
  bad(() => parseDocument({ ...apiInput, raw: stringify({ ...api, jsonSchemaDialect: 'https://example.invalid/schema' }) }));
  const propertyNamedGet = { ...api, components: { schemas: { Test: { type: 'object', properties: { get: { type: 'string' }, value: { type: 'number' } } } } } };
  assert.equal(parseDocument({ ...apiInput, raw: stringify(propertyNamedGet) }).kind, 'openapi');
  const keywordNames = parseYaml(apiInput.raw) as Record<string, unknown>;
  keywordNames.components = { schemas: { Test: { type: 'object', properties: { $ref: { type: 'string' }, pattern: { type: 'number' }, $schema: { type: 'boolean' }, properties: { type: 'object', properties: { value: { type: 'string' } } } } } } };
  assert.equal(validateSource(inputs.map(input => input === apiInput ? { ...input, raw: stringify(keywordNames) } : input)).length, 9);
});

test('OpenAPI resolves bounded local refs, escaped pointers and anchors without network access', () => {
  const apiInput = inputs.find(input => input.path.endsWith('/openapi.yaml'))!;
  const value = parseYaml(apiInput.raw) as Record<string, unknown>;
  value.components = { schemas: { Fields: { type: 'object', properties: { 'a/b~c': { type: 'string', $anchor: 'shared' } } }, Test: { $ref: '#/components/schemas/Fields/properties/a~1b~0c' }, Anchored: { $ref: '#shared' } } };
  const withApi = (api: Record<string, unknown>) => inputs.map(input => input === apiInput ? { ...input, raw: stringify(api) } : input);
  assert.equal(validateSource(withApi(value)).length, 9);
  for (const ref of ['https://example.invalid/no.yaml', '../outside.yaml#/x', '/etc/passwd', 'other.yaml#/x', '#/missing', '#/components/schemas/a~2b', '#missing']) {
    const invalid = structuredClone(value); invalid.components = { schemas: { Test: { $ref: ref } } };
    assert.throws(() => validateSource(withApi(invalid)), CoreError);
  }
  value.components = { schemas: { Test: { type: 'object', properties: { value: { $ref: 'https://example.invalid/remote' } } } } };
  assert.throws(() => validateSource(withApi(value)), CoreError);
  value.components = { schemas: { One: { $ref: 'definitions.yaml#/components/schemas/Two' } } };
  const other = { path: 'planning/source/definitions.yaml', raw: stringify({ openapi: '3.1.1', info: { title: 'Definitions', version: '1', 'x-byeori-id': 'API-DEFINITIONS' }, components: { schemas: { Two: { type: 'string' } } } }) };
  assert.equal(validateSource([...withApi(value), other]).length, 10);
  value.components = { schemas: { Test: { type: 'object', properties: { value: { type: 'string', $anchor: 'named-value' } } }, Ref: { $ref: '#named-value' } } };
  assert.equal(validateSource(withApi(value)).length, 9);
  value.components = { schemas: { Resource: { $id: 'https://example.invalid/resource', $defs: { Self: { type: 'string' } }, $ref: '#/$defs/Self' } } };
  assert.equal(validateSource(withApi(value)).length, 9);
  const referenced = parseYaml(apiInput.raw) as Record<string, unknown>;
  referenced.components = { responses: { Final: { description: 'Success' }, Chain: { $ref: '#/components/responses/Final' } } };
  const paths = referenced.paths as Record<string, Record<string, Record<string, unknown>>>;
  paths['/messages'].post.responses = { '200': { $ref: '#/components/responses/Chain' } };
  assert.equal(validateSource(withApi(referenced)).length, 9);
  referenced.components = { schemas: { Wrong: { type: 'string' } } };
  paths['/messages'].post.responses = { '200': { $ref: '#/components/schemas/Wrong' } };
  bad(() => validateSource(withApi(referenced)));
});
