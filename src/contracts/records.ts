import type { Hash, RecordId, ObjectId, RelativePath, Timestamp, TextElement, OpenQuestion, DocumentKind } from './documents';

export interface ContractVersions { schema_version: 1; policy_version: string; canonicalization_version: string }
export interface WorkspaceIdentity {
  canonical_root: string;
  git: { common_dir: string; worktree_git_dir: string; branch_ref: string | null; detached_head: string | null } | null;
}
export interface WorkspaceBinding { project_id: RecordId; workspace_fingerprint: Hash }
export interface SourceEntry { path: RelativePath; id: ObjectId; kind: DocumentKind; content_hash: Hash }
export interface SourceManifest extends ContractVersions { project_id: RecordId; entries: SourceEntry[] }
export interface ProjectConfig extends ContractVersions {
  project_id: RecordId; name: string; created_at: Timestamp;
  workspace_identity: WorkspaceIdentity;
  genesis_manifest: SourceManifest; genesis_hash: Hash;
}
/** Exact paths or directory subtrees; never globs or an implicit whole workspace. */
export interface ScopeEntry { path: RelativePath; match: 'file' | 'directory' }
export interface ImplementationScope {
  allowlist: ScopeEntry[]; related_object_ids: ObjectId[]; validation_plan: string[];
}
export interface ChangeMetadata {
  type: 'spec_change' | 'implementation_only'; title: string; request: string; reason: string;
  affected_object_ids: ObjectId[]; implementation_scope: ImplementationScope;
}
export interface ChangeRecord extends WorkspaceBinding, ContractVersions {
  change_id: RecordId; created_at: Timestamp; display_name: string | null;
  metadata: ChangeMetadata; version: Hash;
}
export interface SnapshotFile extends SourceEntry { snapshot_path: RelativePath; raw_hash: Hash }
export type DocumentDelta =
  | { operation: 'add'; object_id: ObjectId; before: null; after: SnapshotFile }
  | { operation: 'delete'; object_id: ObjectId; before: SnapshotFile; after: null }
  | { operation: 'modify' | 'move' | 'unchanged'; object_id: ObjectId; before: SnapshotFile; after: SnapshotFile };
export type ReviewItem =
  | { item_id: string; type: 'document'; object_id: ObjectId; required: boolean }
  | { item_id: 'scope:implementation'; type: 'implementation_scope'; required: true };
export interface ReviewManifest extends WorkspaceBinding, ContractVersions {
  change_id: RecordId; round: number;
  workspace_identity: WorkspaceIdentity;
  metadata: ChangeMetadata; metadata_hash: Hash; scope_hash: Hash;
  base_applied_change_id: RecordId | null;
  base_source: SourceManifest; base_source_hash: Hash;
  target_source: SourceManifest; target_source_hash: Hash;
  deltas: DocumentDelta[]; items: ReviewItem[];
  snapshot_tree_hash: Hash;
}
export interface ReviewRound { manifest: ReviewManifest; manifest_hash: Hash; prepared_at: Timestamp }
export type CommentKind = 'change_request' | 'question' | 'note';
export interface CommentTarget {
  object_id: ObjectId; element_id: string | null; field: string | null;
  operation_id: string | null; pointer: string | null;
}
export interface ReviewComment { id: RecordId; kind: CommentKind; body: string; blocking: boolean; target: CommentTarget }
export interface ReviewDecision { item_id: string; decision: 'approve' | 'request_changes' | 'pending'; comments: ReviewComment[] }
export type ImplementationAuthorization = { allowed: true; scope_hash: Hash } | { allowed: false; scope_hash: null };
export interface ReviewFeedback { items: ReviewDecision[]; implementation_authorization: ImplementationAuthorization }
export interface ReviewBinding extends WorkspaceBinding { change_id: RecordId; round: number; manifest_hash: Hash }
export interface ReviewSubmission extends ReviewBinding, ReviewFeedback {
  schema_version: 1; submission_id: RecordId; expected_feedback_version: Hash; final_confirmation: true;
}
/** Produced by Core only after the authenticated Studio explicit-submit route succeeds. */
export interface SubmittedReview {
  submission: ReviewSubmission; payload_hash: Hash; submitted_at: Timestamp;
  provenance: 'studio_human_submit';
}
/** Autosave is durable but does not participate in approval derivation. */
export interface ReviewDraft extends ReviewBinding, ReviewFeedback { schema_version: 1; version: Hash; saved_at: Timestamp }
export interface FeedbackResponse extends ReviewBinding {
  response_id: RecordId; submission_id: RecordId; version: Hash; created_at: Timestamp;
  comments: { comment_id: RecordId; result: 'proposed' | 'addressed_in_draft' | 'needs_clarification' | 'not_applied'; changed_paths: RelativePath[]; rationale: string }[];
}
export interface CancellationRecord extends WorkspaceBinding { change_id: RecordId; cancelled_at: Timestamp; reason: string }
/** Persisted outside disposable cache; original anchor and recovery claim have unique nonces. */
export interface WriteOwnership {
  schema_version: 1; anchor_nonce: RecordId; owner_nonce: RecordId;
  process: { pid: number; start_identity: string; boot_identity: string };
  operation: string; acquired_at: Timestamp;
}
export interface ApplyTransaction extends ReviewBinding, ContractVersions {
  transaction_id: RecordId; submission_id: RecordId; payload_hash: Hash;
  owner: WriteOwnership;
  base_applied_change_id: RecordId | null;
  base_source_hash: Hash; target_source_hash: Hash;
  before_source: SourceManifest; after_source: SourceManifest;
  files: DocumentDelta[]; prepared_at: Timestamp;
  phase: 'prepared' | 'writing' | 'verifying' | 'completed';
  completed_paths: RelativePath[];
}
export interface AppliedRecord extends ReviewBinding, ContractVersions {
  transaction_id: RecordId; submission_id: RecordId; payload_hash: Hash;
  base_applied_change_id: RecordId | null;
  base_source_hash: Hash; result_source_hash: Hash; snapshot_tree_hash: Hash;
  metadata_hash: Hash; scope_hash: Hash; applied_at: Timestamp;
}
export interface ImplementationRecord extends ReviewBinding {
  implementation_id: RecordId; recorded_at: Timestamp; scope_hash: Hash;
  status: 'unverified' | 'verified' | 'failed';
  evidence: { description: string; command: string | null; exit_code: number | null; artifact_path: RelativePath | null }[];
  git_commit: string | null;
}
export interface WorkflowRecord {
  schema_version: 1; project_id: RecordId; version: Hash; updated_at: Timestamp;
  focus: { kind: DocumentKind | null; object_id: ObjectId | null; change_id: RecordId | null };
  facts: TextElement[]; assumptions: TextElement[]; open_questions: OpenQuestion[];
  next_action: string | null;
  feedback_progress: { submission_id: RecordId; comment_id: RecordId; response_id: RecordId | null }[];
  correction_attempts: { change_id: RecordId; ordinary: number; escalation: number }[];
}
export type ChangeState = 'draft' | 'in_review' | 'needs_revision' | 'approved' | 'applied' | 'cancelled';
export type SourceIntegrity =
  | { state: 'valid'; manifest_hash: Hash; applied_change_id: RecordId | null }
  | { state: 'drift' | 'invalid' | 'recovery_required'; expected_hash: Hash | null; actual_hash: Hash | null };
export type ApplyState =
  | { state: 'idle' }
  | { state: 'in_progress' | 'recovery_required'; change_id: RecordId; transaction_id: RecordId }
  | { state: 'applied'; change_id: RecordId; result_source_hash: Hash };
export interface ActiveChange { change_id: RecordId; state: Exclude<ChangeState, 'applied' | 'cancelled'>; metadata: ChangeMetadata }
export interface AuthorizationStatus {
  state: 'none' | 'authorized' | 'stale'; change_id: RecordId | null;
  manifest_hash: Hash | null; scope_hash: Hash | null; scope: ImplementationScope | null;
}
export interface ContinuityStatus extends WorkspaceBinding {
  source_integrity: SourceIntegrity; workflow: WorkflowRecord;
  active_change: ActiveChange | null; current_round: number | null; manifest_hash: Hash | null;
  pending_submissions: RecordId[]; processed_comment_ids: RecordId[];
  apply_state: ApplyState; implementation_authorization: AuthorizationStatus;
  implementation_status: 'unverified' | 'verified' | 'failed';
}
