/** JSON-compatible YAML only; the parser enforces finite/safe numbers and limits. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Hash = string; // Validated lowercase SHA-256, never an approval token.
export type RecordId = string; // Engine-issued UUID/ULID; safe single path segment.
export type ObjectId = string;
export type RelativePath = string; // Validated POSIX path relative to the bound workspace.
export type Timestamp = string; // UTC ISO 8601.

export const DOCUMENT_KINDS = ['prd', 'actor', 'scenario', 'feature', 'ia', 'screen', 'entity', 'openapi', 'architecture'] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];
export type NativeDocumentKind = Exclude<DocumentKind, 'openapi'>;
export type RelationType = 'supports' | 'uses' | 'renders' | 'stores' | 'calls' | 'depends_on' | 'related_to';
export interface Relation { type: RelationType; target: ObjectId }
export interface TextElement { id: string; text: string }
export interface OpenQuestion extends TextElement { blocking: boolean }
export interface PlanningBase {
  schema_version: 1;
  id: ObjectId;
  kind: NativeDocumentKind;
  title: string;
  summary: string;
  aliases: string[];
  relations: Relation[];
  open_questions: OpenQuestion[];
}
export interface Prd extends PlanningBase {
  kind: 'prd'; purpose: string; goals: TextElement[];
  in_scope: string[]; out_of_scope: string[]; constraints: string[];
}
export interface Actor extends PlanningBase {
  kind: 'actor'; responsibilities: string[];
  permissions: { action: string; scope: string }[];
}
export interface Scenario extends PlanningBase {
  kind: 'scenario'; actors: ObjectId[]; preconditions: string[];
  steps: { id: string; actor: ObjectId; action: string; result: string }[];
  outcomes: string[];
}
export interface Feature extends PlanningBase {
  kind: 'feature'; actors: ObjectId[]; rules: TextElement[];
  acceptance_criteria: { id: string; given: string; when: string; then: string }[];
}
export interface InformationArchitecture extends PlanningBase {
  kind: 'ia'; nodes: { id: string; label: string; screen_id: ObjectId; parent_id: string | null }[];
}
export interface Screen extends PlanningBase {
  kind: 'screen';
  components: { id: string; type: string; label: string; actions: string[] }[];
  states: { id: string; description: string }[];
}
export interface Entity extends PlanningBase {
  kind: 'entity'; fields: { id: string; name: string; type: string; nullable: boolean }[];
  primary_key: string[]; constraints: string[];
}
export interface Architecture extends PlanningBase {
  kind: 'architecture';
  components: { id: string; title: string; responsibility: string }[];
  connections: { id: string; from: string; to: string; protocol: string }[];
  decisions: TextElement[];
}
export type PlanningObject = Prd | Actor | Scenario | Feature | InformationArchitecture | Screen | Entity | Architecture;

/** Stored directly as OpenAPI 3.1.1 YAML, with all standard/extension content retained. */
export interface OpenApiDocument {
  [key: string]: JsonValue;
  openapi: '3.1.1';
  info: JsonObject & { title: string; version: string; 'x-byeori-id': ObjectId };
}
/** Read-only adapter projection, never a wrapper written to source. */
export interface OpenApiProjection {
  id: ObjectId; kind: 'openapi'; title: string; summary: string;
  aliases: string[]; relations: Relation[]; open_questions: OpenQuestion[];
  operations: { operation_id: string; pointer: string; method: string; path: string; feature_ids: ObjectId[]; content: JsonObject }[];
  document: OpenApiDocument;
}
export type DocumentContent = PlanningObject | OpenApiDocument;
export type DocumentProjection = PlanningObject | OpenApiProjection;
export type QueryScope = { type: 'approved' } | { type: 'change'; change_id: RecordId } | { type: 'history'; change_id?: RecordId; round?: number };
export interface Revision {
  change_id: RecordId | null; round: number | null; manifest_hash: Hash;
  side: 'source' | 'before' | 'after';
}
export interface DocumentView {
  id: ObjectId; kind: DocumentKind; path: RelativePath; raw: string;
  content: DocumentContent; projection: DocumentProjection;
  semantic_hash: Hash; raw_hash: Hash; revision: Revision;
  provenance: 'approved' | 'review_snapshot' | 'draft';
}
/** Broken/incomplete drafts can be saved and displayed without claiming validity. */
export interface DraftDocument {
  object_id: ObjectId; kind: DocumentKind; path: RelativePath; raw: string;
  content: DocumentContent | null; valid: boolean;
}
