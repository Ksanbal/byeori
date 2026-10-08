import type { ReviewBinding, ReviewDraft, ReviewFeedback, ReviewResults, ReviewSubmission, SubmissionReceipt } from '../../contracts';
import { ApiError, post } from './api';

export function reviewBinding(review: ReviewResults): ReviewBinding {
  const manifest = review.round.manifest;
  return {project_id: manifest.project_id, workspace_fingerprint: manifest.workspace_fingerprint, change_id: manifest.change_id, round: manifest.round, manifest_hash: review.round.manifest_hash};
}
export function bindingKey(binding: ReviewBinding): string { return JSON.stringify(binding); }
export function feedbackOf(review: ReviewResults): ReviewFeedback {
  const saved = review.accepted_submission?.submission ?? review.draft;
  return structuredClone(saved ? {items: saved.items, implementation_authorization: saved.implementation_authorization} : {items: review.round.manifest.items.map(item => ({item_id: item.item_id, decision: 'pending' as const, comments: []})), implementation_authorization: {allowed: false, scope_hash: null}});
}
export function stable(value: unknown): string {
  return JSON.stringify(value, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
export function staleReview(review: ReviewResults): boolean {
  return review.approval.blockers.some(item => ['STALE_REVIEW', 'STALE_BASE', 'WORKSPACE_MISMATCH', 'POLICY_MISMATCH', 'SOURCE_DRIFT', 'APPLY_RECOVERY_REQUIRED'].includes(item.code));
}
export interface ReviewSessionState {
  review: ReviewResults; feedback: ReviewFeedback;
  version: string | null; dirty: boolean;
  phase: 'saved' | 'dirty' | 'saving' | 'error' | 'submitting' | 'uncertain' | 'final';
  error: unknown; previousCopy: string | null;
}
/** One bound round and one CAS writer. Inputs are never replaced by an in-flight save response. */
export class ReviewSession {
  private state: ReviewSessionState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private submitting: Promise<void> | null = null;
  private pendingSubmission: ReviewSubmission | null = null;
  private revision = 0;
  constructor(review: ReviewResults) {
    this.state = {review, feedback: feedbackOf(review), version: review.draft?.version ?? null, dirty: false, phase: review.accepted_submission ? 'final' : 'saved', error: null, previousCopy: null};
  }
  getSnapshot = (): ReviewSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; };
  private set(update: Partial<ReviewSessionState>) { this.state = {...this.state, ...update}; this.listeners.forEach(listener => listener()); }
  editable(): boolean { return !this.state.review.accepted_submission && !staleReview(this.state.review) && !this.pendingSubmission && !this.submitting; }
  edit(feedback: ReviewFeedback) {
    if (!this.editable()) return;
    this.revision++; this.set({feedback: structuredClone(feedback), dirty: true, phase: this.state.error ? 'error' : 'dirty'});
    clearTimeout(this.timer);
    if (!this.state.error) this.timer = setTimeout(() => {void this.flush().catch(() => {});}, 400);
  }
  dispose() { clearTimeout(this.timer); }
  observe(review: ReviewResults) {
    if (bindingKey(reviewBinding(review)) !== bindingKey(reviewBinding(this.state.review))) return;
    if (review.accepted_submission) { this.accept(review); return; }
    if (this.saving || this.submitting) return;
    if ((review.draft?.version ?? null) !== this.state.version) this.set({review, phase: 'error', error: new Error('다른 저장본이 확인되었습니다. 입력을 보존하고 저장본을 다시 불러와 주세요.')});
    else this.set({review});
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    if (this.state.review.accepted_submission || this.pendingSubmission) return;
    this.saving = this.save();
    try { await this.saving; } finally { this.saving = null; }
  }
  private async save() {
    while (this.state.dirty || this.state.version === null) {
      const revision = this.revision; const feedback = structuredClone(this.state.feedback);
      this.set({phase: this.submitting ? 'submitting' : 'saving', error: null});
      try {
        const saved = await post<ReviewDraft>('/api/review/draft', {...reviewBinding(this.state.review), ...feedback, expected_version: this.state.version});
        this.set({version: saved.version, dirty: this.revision !== revision, phase: this.submitting ? 'submitting' : this.revision === revision ? 'saved' : 'dirty'});
      } catch (error) { this.set({phase: 'error', error}); throw error; }
    }
  }
  async reload(): Promise<void> {
    if (this.pendingSubmission || this.submitting) return this.verifySubmission();
    if (this.saving) await this.saving.catch(() => {});
    const review = await post<ReviewResults>('/api/review/results', reviewBinding(this.state.review));
    const copy = this.state.dirty || this.state.error ? stable({...reviewBinding(this.state.review), ...this.state.feedback}) : this.state.previousCopy;
    this.revision++; clearTimeout(this.timer);
    this.set({review, feedback: feedbackOf(review), version: review.draft?.version ?? null, dirty: false, phase: review.accepted_submission ? 'final' : 'saved', error: null, previousCopy: copy});
  }
  async loadRound(review: ReviewResults): Promise<void> {
    if (this.submitting || this.pendingSubmission) throw new Error('제출 결과를 먼저 확인해 주세요.');
    if (this.saving) await this.saving.catch(() => {});
    clearTimeout(this.timer); this.revision++;
    const previousCopy = stable({...reviewBinding(this.state.review), ...this.state.feedback});
    this.set({review, feedback: feedbackOf(review), version: review.draft?.version ?? null, dirty: false, phase: review.accepted_submission ? 'final' : 'saved', error: null, previousCopy});
  }
  async submit(): Promise<void> {
    if (this.submitting) return this.submitting;
    if (this.state.review.accepted_submission) return;
    this.submitting = this.performSubmit();
    try { await this.submitting; } finally { this.submitting = null; }
  }
  private async performSubmit() {
    this.set({phase: 'submitting', error: null});
    if (!this.pendingSubmission) {
      try {
        await this.flush();
        const review = await post<ReviewResults>('/api/review/results', reviewBinding(this.state.review));
        this.set({review});
        if (review.accepted_submission) { this.accept(review); return; }
        if (staleReview(review)) throw new Error('검토본이 변경되었습니다. 입력 사본을 보존하고 최신 리뷰를 열어 주세요.');
        if (!this.state.version) throw new Error('저장된 판단을 확인하지 못했습니다.');
        this.pendingSubmission = {...reviewBinding(review), ...structuredClone(this.state.feedback), schema_version: 1, submission_id: crypto.randomUUID(), expected_feedback_version: this.state.version, final_confirmation: true};
      } catch (error) { this.set({phase: 'error', error}); throw error; }
    } else {
      const resolved = await this.readSubmission();
      if (resolved) return;
    }
    let acknowledged = false;
    try {
      await post<SubmissionReceipt>('/api/review/submit', this.pendingSubmission);
      acknowledged = true;
      // The receipt is durable; refresh derived results rather than manufacturing approval.
      await this.verifySubmission();
    } catch (error) {
      this.set({phase: 'uncertain', error});
      try {
        const accepted = await this.readSubmission();
        if (!accepted && !acknowledged && error instanceof ApiError) { this.pendingSubmission = null; this.set({phase: 'error', error}); }
      } catch { /* Keep the exact pending submission frozen until durable readback is possible. */ }
      if (this.state.phase !== 'final') throw error;
    }
  }
  private accept(review: ReviewResults) {
    const accepted = review.accepted_submission!;
    const different = stable(this.state.feedback) !== stable({items: accepted.submission.items, implementation_authorization: accepted.submission.implementation_authorization});
    this.pendingSubmission = null;
    this.set({review, feedback: feedbackOf(review), dirty: false, phase: 'final', error: null, previousCopy: different ? stable({...reviewBinding(this.state.review), ...this.state.feedback}) : this.state.previousCopy});
  }
  private async readSubmission(): Promise<boolean> {
    const review = await post<ReviewResults>('/api/review/results', reviewBinding(this.state.review));
    if (review.accepted_submission) { this.accept(review); return true; }
    this.set({review}); return false;
  }
  async verifySubmission(): Promise<void> {
    try {
      if (await this.readSubmission()) return;
      this.set({phase: this.pendingSubmission ? 'uncertain' : 'error', error: new Error('최종 기록을 아직 확인하지 못했습니다. 결과 확인 후 같은 제출을 다시 시도할 수 있습니다.')});
    } catch (error) { this.set({phase: this.pendingSubmission ? 'uncertain' : 'error', error}); throw error; }
  }
}
