import type { DocumentContent, DocumentKind, DocumentProjection } from '../contracts';

/** A source inspection is never an approval, review, or implementation authorization. */
export interface ViewerDocument {
  id: string;
  kind: DocumentKind;
  /** Logical planning/source target, including for a draft put. */
  path: string;
  /** Actual inspected file. Draft chunks are never confused with applied source. */
  storage_path?: string;
  title: string;
  summary: string;
  raw: string;
  content: DocumentContent;
  projection: DocumentProjection;
  semantic_hash: string;
  raw_hash: string;
  provenance: 'source' | 'draft';
}
export interface ViewerIssue {
  code: string;
  path: string | null;
  message: string;
}
/** Invalid persisted draft puts remain inspectable without inventing a projection. */
export interface ViewerInvalidDocument {
  id: string;
  kind: DocumentKind;
  path: string;
  storage_path: string;
  raw: string;
  raw_hash: string;
  provenance: 'draft';
  issues: ViewerIssue[];
}
/** Recorded status is descriptive only; approval and source integrity are not derived. */
export interface ViewerSource {
  id: string;
  kind: 'source' | 'draft';
  change_id: string | null;
  label: string;
  path: string;
  status: 'source' | 'draft' | 'review-recorded' | 'applied-recorded' | 'cancelled-recorded' | 'invalid';
  version: string | null;
}
export interface ViewerDraftEdit {
  operation: 'put' | 'move' | 'delete';
  object_id: string;
  kind: DocumentKind | null;
  path: string | null;
  storage_path: string | null;
}
/** Every edge originates in an explicit source field; no inferred hierarchy edges. */
export interface ViewerRelation {
  source: string;
  target: string;
  type: string;
  field: string;
  resolved: boolean;
}
export interface Catalog {
  schema_version: 1;
  workspace: { name: string; source_path: 'planning/source' };
  mode: 'read-only';
  provenance: 'source' | 'draft';
  sources: ViewerSource[];
  selected_source: ViewerSource;
  loaded_at: string;
  kinds: { kind: DocumentKind; label: string; count: number }[];
  documents: ViewerDocument[];
  invalid_documents: ViewerInvalidDocument[];
  draft_edits: ViewerDraftEdit[];
  relations: ViewerRelation[];
  issues: ViewerIssue[];
  truncated: boolean;
}
