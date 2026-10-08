import type { Hash, RecordId, ObjectId, RelativePath, Timestamp, DocumentKind, DocumentView, DraftDocument, QueryScope, Revision, RelationType } from './documents';
import type { WorkspaceBinding, ProjectConfig, ChangeRecord, ChangeMetadata, ReviewBinding, ReviewRound, ReviewDraft, ReviewFeedback, ReviewSubmission, SubmittedReview, FeedbackResponse, AppliedRecord, ApplyTransaction, ImplementationRecord, WorkflowRecord, ContinuityStatus } from './records';

export type DiagnosticCode =
  | 'VALIDATION_FAILED' | 'REVIEW_REQUIRED' | 'STALE_BASE' | 'STALE_REVIEW' | 'CONFLICT'
  | 'SOURCE_DRIFT' | 'UNPROCESSED_FEEDBACK' | 'APPLY_RECOVERY_REQUIRED' | 'HOOK_NOT_ACTIVE'
  | 'SCOPE_DENIED' | 'CAPABILITY_UNAVAILABLE' | 'WORKSPACE_MISMATCH' | 'POLICY_MISMATCH'
  | 'PATH_DENIED' | 'AUTH_REQUIRED' | 'UNEXPECTED';
export interface Diagnostic {
  code: DiagnosticCode; severity: 'error' | 'warning' | 'info';
  path: RelativePath | null; object_id: ObjectId | null; field: string | null;
  message: string; suggested_action: string;
}
export interface ResultMeta { schema_version: 1; runtime_version: string; policy_version: string; canonicalization_version: string }
export type Result<T> =
  | { ok: true; data: T; diagnostics: Diagnostic[]; meta: ResultMeta }
  | { ok: false; data: null; diagnostics: Diagnostic[]; meta: ResultMeta };
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const DIAGNOSTIC_EXIT_CODES = {
  VALIDATION_FAILED: 2, REVIEW_REQUIRED: 3, STALE_BASE: 4, STALE_REVIEW: 4, CONFLICT: 4,
  SOURCE_DRIFT: 4, UNPROCESSED_FEEDBACK: 3, APPLY_RECOVERY_REQUIRED: 5, HOOK_NOT_ACTIVE: 6,
  SCOPE_DENIED: 3, CAPABILITY_UNAVAILABLE: 6, WORKSPACE_MISMATCH: 4, POLICY_MISMATCH: 4,
  PATH_DENIED: 2, AUTH_REQUIRED: 3, UNEXPECTED: 1,
} as const satisfies Record<DiagnosticCode, ExitCode>;

export interface SearchRequest { query: string; scope?: QueryScope; limit?: number; kinds?: DocumentKind[] }
export interface SearchHit {
  id: ObjectId; kind: DocumentKind; title: string; excerpt: string; path: RelativePath;
  revision: Revision; match_reason: 'id_exact' | 'title_exact' | 'alias_exact' | 'fts' | 'substring';
  score: number; score_meaning: 'exact_priority' | 'bm25_rank' | 'substring_rank';
}
export interface SearchResult { scope: QueryScope; hits: SearchHit[]; score_is_probability: false; truncated: boolean }
export interface GetRequest { object_id: ObjectId; scope?: QueryScope; revision?: Revision }
export interface ImpactRequest { object_id: ObjectId; scope?: QueryScope; depth?: number; limit?: number }
export interface ImpactResult {
  objects: { id: ObjectId; kind: DocumentKind; title: string }[];
  relations: { from: ObjectId; to: ObjectId; type: RelationType; direction: 'owned' | 'inverse' }[];
  coverage: { depth: number; visited: number; truncated: boolean; code_impact: 'not_investigated' };
}
export interface HistoryRequest { object_id?: ObjectId; change_id?: RecordId; limit?: number; cursor?: string }
export type HistoryEntry =
  | { type: 'change'; record: ChangeRecord }
  | { type: 'review'; record: ReviewRound }
  | { type: 'submission'; record: SubmittedReview }
  | { type: 'response'; record: FeedbackResponse }
  | { type: 'applied'; record: AppliedRecord }
  | { type: 'implementation'; record: ImplementationRecord }
  | { type: 'cancelled'; change_id: RecordId; reason: string; cancelled_at: Timestamp };
export interface HistoryResult { entries: HistoryEntry[]; next_cursor: string | null }
export interface IndexResult { indexed_objects: number; source_hash: Hash; indexer_version: string; scope: QueryScope }
export interface ValidationRequest { scope?: QueryScope; stage?: 'structural' | 'review_ready' | 'implementation_ready' }
export interface ValidationResult { valid: boolean; checked_object_ids: ObjectId[]; source_hash: Hash | null }

export interface CreateChangeRequest extends WorkspaceBinding { metadata: ChangeMetadata; display_name?: string }
export interface ChangeMutation extends WorkspaceBinding { change_id: RecordId; expected_version: Hash }
export interface PutDraftRequest extends ChangeMutation { object_id: ObjectId; kind: DocumentKind; path: RelativePath; raw: string }
export interface DeleteDraftRequest extends ChangeMutation { object_id: ObjectId }
export interface MoveDraftRequest extends ChangeMutation { object_id: ObjectId; path: RelativePath }
export interface UpdateChangeRequest extends ChangeMutation { metadata: ChangeMetadata }
export interface DraftWriteResult { change: ChangeRecord; draft: DraftDocument | null; diagnostics: Diagnostic[] }
export type PrepareReviewRequest = ChangeMutation;
export interface ReviewResults {
  round: ReviewRound; draft: ReviewDraft | null; accepted_submission: SubmittedReview | null;
  responses: FeedbackResponse[]; processed_comment_ids: RecordId[];
  approval: { documents_approved: boolean; implementation_allowed: boolean; blockers: Diagnostic[] };
}
export interface SaveReviewDraftRequest extends ReviewBinding, ReviewFeedback { expected_version: Hash | null }
export interface SubmissionReceipt { submission_id: RecordId; payload_hash: Hash; submitted_at: Timestamp; replayed: boolean }
export interface RespondRequest extends ReviewBinding {
  submission_id: RecordId; response_id: RecordId; expected_change_version: Hash;
  comments: FeedbackResponse['comments'];
}
export interface RecoverRequest extends WorkspaceBinding { change_id: RecordId; action: 'inspect' | 'resume' }
export interface RecoveryResult { transaction: ApplyTransaction | null; applied: AppliedRecord | null; conflicts: RelativePath[] }

export type HostId = 'claude' | 'codex';
export interface HostCapability {
  host: HostId; host_version: string | null;
  configured: boolean; trusted: boolean | null; active: boolean;
  probed: { state: 'not_run' | 'passed' | 'failed' | 'blocked'; checked_at: Timestamp | null; evidence: string[] };
  coverage: { protected_tools: string[]; uncovered_tools: string[]; limitations: string[] };
  mode: { type: 'enforced' } | { type: 'advisory'; selected_by: 'human'; selected_at: Timestamp; reason: string };
}
export interface DoctorResult {
  node: { version: string; compatible: boolean };
  sqlite: { available: boolean; fts5_probed: boolean; extension_loading: false };
  schemas: { runtime_version: string; schema_version: number; compatible: boolean };
  writable: boolean; instruction_paths: string[]; hosts: HostCapability[];
  status: ContinuityStatus | null;
}
export interface GateRequest extends WorkspaceBinding {
  host: HostId; tool: string;
  operation: 'read' | 'planning_draft_write' | 'implementation_write' | 'unknown';
  paths: RelativePath[];
}
export interface GateResult {
  allowed: boolean; protection: 'enforced' | 'advisory' | 'unavailable';
  checked_paths: RelativePath[]; authorization_manifest_hash: Hash | null;
}
export interface StudioState {
  project: Pick<ProjectConfig, 'project_id' | 'name'>; branch: string | null;
  status: ContinuityStatus; documents: { id: ObjectId; kind: DocumentKind; title: string; path: RelativePath }[];
  review: ReviewResults | null;
}
export interface StudioRuntime { state: 'running' | 'stopped'; url: string | null; pid: number | null }
export interface WorkflowWriteRequest extends WorkspaceBinding { expected_version: Hash; workflow: WorkflowRecord }

/** Shared Core surface. CLI/server/adapters delegate here; no alternate state machine. */
export interface CoreApi {
  init(input: { root: string; name?: string }): Promise<Result<ProjectConfig>>;
  doctor(): Promise<Result<DoctorResult>>;
  status(): Promise<Result<ContinuityStatus>>;
  search(input: SearchRequest): Promise<Result<SearchResult>>;
  get(input: GetRequest): Promise<Result<DocumentView>>;
  impact(input: ImpactRequest): Promise<Result<ImpactResult>>;
  history(input: HistoryRequest): Promise<Result<HistoryResult>>;
  createChange(input: CreateChangeRequest): Promise<Result<ChangeRecord>>;
  updateChange(input: UpdateChangeRequest): Promise<Result<ChangeRecord>>;
  putDraft(input: PutDraftRequest): Promise<Result<DraftWriteResult>>;
  deleteDraft(input: DeleteDraftRequest): Promise<Result<ChangeRecord>>;
  moveDraft(input: MoveDraftRequest): Promise<Result<ChangeRecord>>;
  cancelChange(input: ChangeMutation & { reason: string }): Promise<Result<ContinuityStatus>>;
  prepareReview(input: PrepareReviewRequest): Promise<Result<ReviewRound>>;
  reviewResults(input: ReviewBinding): Promise<Result<ReviewResults>>;
  respond(input: RespondRequest): Promise<Result<FeedbackResponse>>;
  writeWorkflow(input: WorkflowWriteRequest): Promise<Result<WorkflowRecord>>;
  lint(input: ValidationRequest): Promise<Result<ValidationResult>>;
  apply(input: ReviewBinding): Promise<Result<AppliedRecord>>;
  recover(input: RecoverRequest): Promise<Result<RecoveryResult>>;
  gateCheck(input: GateRequest): Promise<Result<GateResult>>;
  rebuildIndex(input: { scope?: QueryScope }): Promise<Result<IndexResult>>;
  studio(input: { action: 'start' | 'status' | 'stop' }): Promise<Result<StudioRuntime>>;
}
/** Reachable only from the authenticated human Studio route, never agent CLI/hooks. */
export interface HumanReviewApi {
  studioState(): Promise<Result<StudioState>>;
  saveReviewDraft(input: SaveReviewDraftRequest): Promise<Result<ReviewDraft>>;
  submitReview(input: ReviewSubmission): Promise<Result<SubmissionReceipt>>;
  selectAdvisory(input: { host: HostId; reason: string }): Promise<Result<HostCapability>>;
}
export const CLI_COMMANDS = [
  'init', 'doctor', 'status', 'search', 'get', 'impact', 'history', 'change create', 'change put',
  'change cancel', 'change update', 'change delete', 'change move', 'workflow write', 'review prepare', 'review results', 'review respond', 'lint', 'apply', 'recover',
  'gate check', 'index rebuild', 'studio', 'host remove',
] as const;
export type CliCommand = typeof CLI_COMMANDS[number];
