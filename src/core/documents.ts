import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import planningSchema from '../../schemas/planning-object.schema.json';
import openapiSchema from '../../schemas/openapi-structure.schema.json';
import oasMeta from '../../schemas/vendor/openapi/oas-3.1-meta-2024-11-10.json';
import oasDialect from '../../schemas/vendor/openapi/oas-3.1-dialect-2024-11-10.json';
import type { DocumentContent, DocumentKind, DocumentProjection, JsonObject, JsonValue, OpenApiDocument, OpenApiProjection, PlanningObject, SourceManifest } from '../contracts';
import { CoreError, reject } from './errors';
import { sourcePath, relativePath } from './paths';
import { parseYaml, rawHash, semanticHash, VERSIONS } from './yaml';

const ajv = new Ajv2020({ strict: false, allErrors: true, ownProperties: true });
addFormats(ajv);
ajv.addFormat('media-range', /^(?:[!#$%&'*+.^_`|~\w-]+|\*)\/(?:[!#$%&'*+.^_`|~\w-]+|\*)(?:\s*;\s*[!#$%&'*+.^_`|~\w-]+=(?:[!#$%&'*+.^_`|~\w-]+|"[^"\r\n]*"))*$/);
ajv.addMetaSchema(oasMeta);
ajv.addMetaSchema(oasDialect);
const nativeValidator = ajv.compile<PlanningObject>(planningSchema);
const apiValidator = ajv.compile<OpenApiDocument>(openapiSchema);
const supportedDialects = new Set([oasDialect.$id, 'https://json-schema.org/draft/2020-12/schema']);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const objectIdPattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
export interface RawDocument { path: string; raw: string }
export interface ParsedDocument extends RawDocument {
  id: string; kind: DocumentKind; content: DocumentContent; projection: DocumentProjection;
  content_hash: string; raw_hash: string;
}
export type DraftEdit =
  | { operation: 'put'; object_id: string; kind: DocumentKind; path: string; raw: string }
  | { operation: 'delete'; object_id: string }
  | { operation: 'move'; object_id: string; path: string };
export function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function unique(values: string[], label: string, location: string): void {
  if (values.some(value => typeof value !== 'string' || !value.length) || new Set(values).size !== values.length) reject('VALIDATION_FAILED', `Duplicate/empty ${label}.`, location);
}
function escapePointer(segment: string): string { return segment.replaceAll('~', '~0').replaceAll('/', '~1'); }
function forJson(value: JsonValue, visit: (object: JsonObject, pointer: string) => void, pointer = '', skipData = false, propertyBag = false): void {
  if (Array.isArray(value)) value.forEach((child, index) => forJson(child, visit, pointer + '/' + index, skipData));
  else if (isObject(value)) {
    if (!propertyBag) visit(value, pointer);
    for (const [key, child] of Object.entries(value)) {
      if (skipData && !propertyBag && (['example', 'default', 'const', 'enum', 'examples', 'value'].includes(key) || key.startsWith('x-'))) continue;
      forJson(child, visit, pointer + '/' + escapePointer(key), skipData, !propertyBag && schemaMaps.has(key));
    }
  }
}
function schemaRoots(document: JsonObject): { value: JsonValue; pointer: string }[] {
  const roots: { value: JsonValue; pointer: string }[] = [];
  const walk = (value: JsonValue, pointer: string): void => {
    if (Array.isArray(value)) value.forEach((child, index) => walk(child, pointer + '/' + index));
    else if (isObject(value)) for (const [key, child] of Object.entries(value)) {
      const childPointer = pointer + '/' + escapePointer(key);
      if (key === 'schema') roots.push({ value: child, pointer: childPointer });
      else if (childPointer === '/components/schemas' && isObject(child)) for (const [name, schema] of Object.entries(child)) roots.push({ value: schema, pointer: childPointer + '/' + escapePointer(name) });
      else if (!['example', 'value'].includes(key) && !key.startsWith('x-')) walk(child, childPointer);
    }
  };
  walk(document, '');
  return roots;
}
function validateSchemaObject(value: JsonValue, dialect: string, location: string, pointer: string): void {
  if (typeof value === 'boolean') return;
  if (!isObject(value)) reject('VALIDATION_FAILED', 'Schema Object must be object/boolean.', location, pointer);
  const selected = value.$schema ?? dialect;
  if (typeof selected !== 'string' || !supportedDialects.has(selected)) reject('VALIDATION_FAILED', 'Unsupported offline Schema Object dialect.', location, pointer);
  if (!ajv.validateSchema({ ...value, $schema: selected })) reject('VALIDATION_FAILED', ajv.errorsText(ajv.errors), location, pointer);
  forJson(value, object => {
    if (Object.hasOwn(object, 'pattern')) {
      try { new RegExp(object.pattern as string, 'u'); } catch { reject('VALIDATION_FAILED', 'Invalid Schema Object regular expression.', location, pointer); }
    }
    if (Object.hasOwn(object, '$schema') && (typeof object.$schema !== 'string' || !supportedDialects.has(object.$schema))) reject('VALIDATION_FAILED', 'Unsupported nested schema dialect.', location, pointer);
  }, '', true);
}
function projectOpenApi(document: OpenApiDocument, location: string): OpenApiProjection {
  if (document.openapi !== '3.1.1') reject('VALIDATION_FAILED', 'Byeori requires OpenAPI 3.1.1.', location);
  const id = document.info['x-byeori-id'];
  if (typeof id !== 'string' || !objectIdPattern.test(id)) reject('VALIDATION_FAILED', 'info.x-byeori-id must be a valid planning object ID.', location);
  const dialect = document.jsonSchemaDialect ?? oasDialect.$id;
  if (typeof dialect !== 'string' || !supportedDialects.has(dialect)) reject('VALIDATION_FAILED', 'Unsupported jsonSchemaDialect.', location);
  for (const schema of schemaRoots(document)) validateSchemaObject(schema.value, dialect, location, schema.pointer);
  const operations: OpenApiProjection['operations'] = [];
  const pathItem = (object: JsonValue, pointer: string, name: string): void => {
    if (!isObject(object)) return;
    for (const [method, value] of Object.entries(object)) {
      if (!methods.has(method) || !isObject(value)) continue;
      if (typeof value.operationId !== 'string' || !value.operationId) reject('VALIDATION_FAILED', 'Every reviewable API operation requires operationId.', location, pointer);
      const features = value['x-byeori-features'] ?? [];
      if (!Array.isArray(features) || features.some(feature => typeof feature !== 'string' || !objectIdPattern.test(feature))) reject('VALIDATION_FAILED', 'x-byeori-features must contain planning feature IDs.', location, pointer);
      unique(features as string[], 'operation feature IDs', location);
      operations.push({ operation_id: value.operationId, pointer: pointer + '/' + method, method, path: name, feature_ids: features as string[], content: value });
      if (isObject(value.callbacks)) for (const [callbackName, callback] of Object.entries(value.callbacks)) if (isObject(callback)) for (const [expression, item] of Object.entries(callback)) if (!expression.startsWith('x-') && expression !== '$ref') pathItem(item, pointer + '/' + method + '/callbacks/' + escapePointer(callbackName) + '/' + escapePointer(expression), expression);
    }
  };
  for (const group of ['paths', 'webhooks'] as const) if (isObject(document[group])) for (const [name, item] of Object.entries(document[group])) if (!name.startsWith('x-')) pathItem(item, '/' + group + '/' + escapePointer(name), name);
  if (isObject(document.components) && isObject(document.components.pathItems)) for (const [name, item] of Object.entries(document.components.pathItems)) pathItem(item, '/components/pathItems/' + escapePointer(name), name);
  unique(operations.map(operation => operation.operation_id), 'operationIds', location);
  return { id, kind: 'openapi', title: document.info.title, summary: typeof document.info.summary === 'string' ? document.info.summary : typeof document.info.description === 'string' ? document.info.description : document.info.title, aliases: [], relations: operations.flatMap(operation => operation.feature_ids.map(target => ({ type: 'calls' as const, target }))), open_questions: [], operations, document };
}
function validateElements(document: PlanningObject, location: string): void {
  const elements: string[] = [];
  for (const value of Object.values(document)) if (Array.isArray(value)) for (const child of value) if (isObject(child) && typeof child.id === 'string') elements.push(child.id);
  unique(elements, 'stable element IDs', location);
  if (document.kind === 'entity') {
    unique(document.fields.map(field => field.name), 'entity field names', location);
    unique(document.primary_key, 'primary key references', location);
    for (const key of document.primary_key) {
      const fields = document.fields.filter(field => field.id === key || field.name === key);
      if (fields.length !== 1) reject('VALIDATION_FAILED', 'Primary key must unambiguously identify an entity field name or stable ID.', location, 'primary_key');
    }
  }
  if (document.kind === 'architecture') for (const connection of document.connections) {
    if (![connection.from, connection.to].every(id => document.components.some(component => component.id === id))) reject('VALIDATION_FAILED', 'Architecture connection references a missing component.', location, 'connections');
  }
  if (document.kind === 'ia') {
    const parents = new Map(document.nodes.map(node => [node.id, node.parent_id]));
    for (const node of document.nodes) {
      const seen = new Set<string>();
      let current: string | null = node.id;
      while (current !== null) {
        if (seen.has(current) || !parents.has(current)) reject('VALIDATION_FAILED', 'IA parent is missing or cyclic.', location, 'nodes');
        seen.add(current); current = parents.get(current)!;
      }
    }
  }
}
export function parseDocument(input: RawDocument): ParsedDocument {
  sourcePath(input.path);
  const value = parseYaml(input.raw);
  if (!isObject(value)) reject('VALIDATION_FAILED', 'Planning document must be an object.', input.path);
  let content: DocumentContent; let projection: DocumentProjection;
  if (Object.hasOwn(value, 'openapi')) {
    if (!apiValidator(value)) reject('VALIDATION_FAILED', ajv.errorsText(apiValidator.errors), input.path);
    content = value; projection = projectOpenApi(value, input.path);
  } else {
    if (!nativeValidator(value)) reject('VALIDATION_FAILED', ajv.errorsText(nativeValidator.errors), input.path);
    content = value; projection = value; validateElements(value, input.path);
  }
  return { ...input, id: projection.id, kind: projection.kind, content, projection, content_hash: semanticHash(content), raw_hash: rawHash(input.raw) };
}
function pointerValue(root: JsonValue, fragment: string, location: string): JsonValue {
  let decoded: string;
  try { decoded = decodeURIComponent(fragment); } catch { reject('VALIDATION_FAILED', 'Malformed reference fragment.', location); }
  if (decoded === '') return root;
  if (!decoded.startsWith('/')) {
    const matches: JsonValue[] = [];
    const anchors = (value: JsonValue, pointer = '', propertyBag = false): void => {
      if (Array.isArray(value)) value.forEach((child, index) => anchors(child, pointer + '/' + index));
      else if (isObject(value)) {
        if (!propertyBag && value !== root && typeof value.$id === 'string') return;
        if (!propertyBag && (value.$anchor === decoded || value.$dynamicAnchor === decoded)) matches.push(value);
        for (const [key, child] of Object.entries(value)) if (propertyBag || (!['example', 'examples', 'default', 'const', 'enum', 'value'].includes(key) && !key.startsWith('x-'))) {
          const childPointer = pointer + '/' + escapePointer(key);
          anchors(child, childPointer, childPointer === '/components/schemas' || (!propertyBag && schemaMaps.has(key)));
        }
      }
    };
    anchors(root);
    if (matches.length !== 1) reject('VALIDATION_FAILED', 'Reference anchor is missing or ambiguous.', location);
    return matches[0];
  }
  let current = root;
  for (const token of decoded.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(token)) reject('VALIDATION_FAILED', 'Invalid JSON Pointer escape.', location);
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || !Object.hasOwn(current, key)) reject('VALIDATION_FAILED', 'Missing array reference target.', location);
      current = current[Number(key)];
    } else if (isObject(current) && Object.hasOwn(current, key)) current = current[key];
    else reject('VALIDATION_FAILED', 'Missing local reference target.', location);
  }
  return current;
}
function validateApiReferences(document: ParsedDocument, byPath: Map<string, ParsedDocument>): void {
  const apiRoot = document.content as unknown as JsonObject;
  const schemas = schemaRoots(apiRoot);
  const schemaPointers = new Set(schemas.map(schema => schema.pointer));
  const resolve = (ref: string, owner: ParsedDocument, resource: JsonValue, resourcePath: string): { value: JsonValue; document: ParsedDocument } => {
    const [file, ...fragments] = ref.split('#');
    if (fragments.length > 1) reject('VALIDATION_FAILED', 'Invalid reference URI.', owner.path);
    let targetRoot = resource; let targetDocument = owner;
    if (file) {
      relativePath(file); relativePath(resourcePath);
      const targetPath = sourcePath(path.posix.join(path.posix.dirname(resourcePath), file));
      const target = byPath.get(targetPath);
      if (!target) reject('VALIDATION_FAILED', 'Local reference document is missing.', owner.path);
      targetRoot = target.content as unknown as JsonValue; targetDocument = target;
    }
    return { value: pointerValue(targetRoot, fragments[0] ?? '', owner.path), document: targetDocument };
  };
  const definitions: [RegExp, string][] = [[/\/responses\/[^/]+$/, 'response'], [/\/parameters\/[^/]+$/, 'parameter'], [/\/requestBody$|\/requestBodies\/[^/]+$/, 'request-body'], [/\/headers\/[^/]+$/, 'header'], [/\/securitySchemes\/[^/]+$/, 'security-scheme'], [/\/examples\/[^/]+$/, 'example'], [/\/links\/[^/]+$/, 'link'], [/\/callbacks\/[^/]+$/, 'callback'], [/\/(?:paths|webhooks|pathItems)\/[^/]+$/, 'path-item']];
  const visit = (value: JsonValue, pointer: string, resource: JsonValue, resourcePath: string, propertyBag = false): void => {
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, pointer + '/' + index, resource, resourcePath));
    else if (isObject(value)) {
      const withinSchema = schemas.some(schema => pointer === schema.pointer || pointer.startsWith(schema.pointer + '/'));
      if (withinSchema && !propertyBag && typeof value.$id === 'string') {
        resource = value;
        resourcePath = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value.$id) ? value.$id : path.posix.join(path.posix.dirname(resourcePath), relativePath(value.$id));
      }
      for (const key of ['$ref', '$dynamicRef']) if (!propertyBag && Object.hasOwn(value, key)) {
        const ref = value[key];
        if (typeof ref !== 'string') reject('VALIDATION_FAILED', 'Reference must be a string.', document.path, pointer);
        let target = resolve(ref, document, resource, resourcePath);
        if (withinSchema) validateSchemaObject(target.value, (document.content as OpenApiDocument).jsonSchemaDialect as string ?? oasDialect.$id, document.path, pointer);
        else {
          const seen = new Set<string>();
          while (isObject(target.value) && typeof target.value.$ref === 'string') {
            const next = target.value.$ref; const identity = target.document.path + '#' + next;
            if (seen.has(identity) || seen.size >= 64) reject('VALIDATION_FAILED', 'Cyclic/excessive OpenAPI reference-object chain.', document.path, pointer);
            seen.add(identity); target = resolve(next, target.document, target.document.content as unknown as JsonValue, target.document.path);
          }
          if (!isObject(target.value)) reject('VALIDATION_FAILED', 'OpenAPI reference target must be an object.', document.path, pointer);
          const definition = definitions.find(([pattern]) => pattern.test(pointer))?.[1];
          if (definition) {
            const validator = ajv.getSchema(openapiSchema.$id + '#/$defs/' + definition)!;
            if (!validator(target.value)) reject('VALIDATION_FAILED', 'Wrong OpenAPI reference target: ' + ajv.errorsText(validator.errors), document.path, pointer);
          }
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (!propertyBag && (['example', 'value'].includes(key) || (withinSchema && ['default', 'const', 'enum', 'examples'].includes(key)) || key.startsWith('x-'))) continue;
        const childPointer = pointer + '/' + escapePointer(key);
        visit(child, childPointer, schemaPointers.has(childPointer) ? apiRoot : resource, schemaPointers.has(childPointer) ? document.path : resourcePath, childPointer === '/components/schemas' || (withinSchema && !propertyBag && schemaMaps.has(key)));
      }
    }
  };
  visit(apiRoot, '', apiRoot, document.path);
}
export function validateSource(inputs: RawDocument[], stage: 'review_ready' | 'implementation_ready' = 'review_ready'): ParsedDocument[] {
  const documents = inputs.map(parseDocument);
  unique(documents.map(document => document.id), 'document IDs', 'planning/source');
  unique(documents.map(document => document.path.normalize('NFC').toLowerCase()), 'source paths (including case/Unicode collisions)', 'planning/source');
  const byId = new Map(documents.map(document => [document.id, document]));
  const byPath = new Map(documents.map(document => [document.path, document]));
  const requireRef = (id: string, owner: ParsedDocument, kind?: DocumentKind): void => {
    const target = byId.get(id);
    if (!target || (kind && target.kind !== kind)) reject('VALIDATION_FAILED', `Missing/wrong-kind reference: ${id}`, owner.path);
  };
  for (const document of documents) {
    for (const relation of document.projection.relations) requireRef(relation.target, document);
    if (stage === 'implementation_ready' && document.projection.open_questions.some(question => question.blocking)) reject('REVIEW_REQUIRED', 'Blocking implementation question is unresolved.', document.path);
    const content = document.content;
    if (document.kind === 'openapi') {
      for (const operation of (document.projection as OpenApiProjection).operations) for (const id of operation.feature_ids) requireRef(id, document, 'feature');
      validateApiReferences(document, byPath);
    } else {
      const native = content as PlanningObject;
      if (native.kind === 'scenario' || native.kind === 'feature') for (const id of native.actors) requireRef(id, document, 'actor');
      if (native.kind === 'scenario') for (const step of native.steps) {
        requireRef(step.actor, document, 'actor');
        if (!native.actors.includes(step.actor)) reject('VALIDATION_FAILED', 'Scenario step actor must be declared in actors.', document.path);
      }
      if (native.kind === 'ia') for (const node of native.nodes) requireRef(node.screen_id, document, 'screen');
    }
  }
  const complete = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) reject('VALIDATION_FAILED', 'depends_on cycle.', byId.get(id)!.path);
    if (complete.has(id)) return;
    visiting.add(id);
    for (const relation of byId.get(id)!.projection.relations) if (relation.type === 'depends_on') visit(relation.target);
    visiting.delete(id); complete.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return documents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1);
}
export function projectSource(base: RawDocument[], edits: DraftEdit[], stage: 'review_ready' | 'implementation_ready' = 'review_ready'): ParsedDocument[] {
  const current = new Map(validateSource(base).map(document => [document.id, { path: document.path, raw: document.raw }]));
  unique(edits.map(edit => edit.object_id), 'edit object IDs', 'planning/changes');
  for (const edit of edits) {
    if (edit.operation === 'put') {
      const parsed = parseDocument(edit);
      if (parsed.id !== edit.object_id || parsed.kind !== edit.kind) reject('VALIDATION_FAILED', 'Draft ID/kind does not match its manifest.', edit.path);
      current.set(edit.object_id, { path: edit.path, raw: edit.raw });
    } else {
      const previous = current.get(edit.object_id);
      if (!previous) reject('VALIDATION_FAILED', 'Cannot delete/move a nonexistent source object.');
      if (edit.operation === 'delete') current.delete(edit.object_id);
      else current.set(edit.object_id, { ...previous, path: sourcePath(edit.path) });
    }
  }
  return validateSource([...current.values()], stage);
}
export function sourceManifest(projectId: string, documents: ParsedDocument[]): SourceManifest {
  return { ...VERSIONS, project_id: projectId, entries: documents.map(document => ({ path: document.path, id: document.id, kind: document.kind, content_hash: document.content_hash })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1) };
}
export function draftDiagnostics(input: RawDocument): CoreError['diagnostics'] {
  try { parseDocument(input); return []; } catch (error) { if (error instanceof CoreError) return error.diagnostics; throw error; }
}
