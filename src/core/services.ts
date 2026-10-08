import { RUNTIME_VERSION } from '../version';
import type { CoreApi, HumanReviewApi, Result } from '../contracts';
import { CoreError } from './errors';
import { apply, recover, type ApplyDependencies } from './apply';
import { cancelChange, prepareReview, respond, reviewResults, saveReviewDraft, submitReview } from './review';
import { gateCheck, get, history, selectAdvisory, status, studioState } from './state';
import { createChange, deleteDraft, initializeWorkspace, moveDraft, putDraft, updateChange, writeWorkflow } from './workspace';
import { VERSIONS } from './yaml';

export async function result<T>(action: () => Promise<T>): Promise<Result<T>> {
  const meta = { ...VERSIONS, runtime_version: RUNTIME_VERSION };
  try { return { ok: true, data: await action(), diagnostics: [], meta }; }
  catch (error) { const diagnostics = error instanceof CoreError ? error.diagnostics : [{ code: 'UNEXPECTED' as const, severity: 'error' as const, path: null, object_id: null, field: null, message: error instanceof Error ? error.message : 'Unexpected Core error.', suggested_action: 'Inspect the operation and retry only after resolving the reported failure.' }]; return { ok: false, data: null, diagnostics, meta }; }
}
export type ReviewCoreApi = Pick<CoreApi, 'init' | 'status' | 'get' | 'history' | 'createChange' | 'updateChange' | 'putDraft' | 'deleteDraft' | 'moveDraft' | 'cancelChange' | 'prepareReview' | 'reviewResults' | 'respond' | 'writeWorkflow' | 'apply' | 'recover' | 'gateCheck'>;
/** Genuine B04 services; B05/B06 supply search/index/doctor/Studio lifecycle separately. */
export function createReviewCore(root: string, dependencies: ApplyDependencies = {}): ReviewCoreApi {
  return {
    init: input => result(() => initializeWorkspace(input.root, input.name)), status: () => result(() => status(root)), get: input => result(() => get(root, input)), history: input => result(() => history(root, input)),
    createChange: input => result(() => createChange(root, input)), updateChange: input => result(() => updateChange(root, input)), putDraft: input => result(() => putDraft(root, input)), deleteDraft: input => result(() => deleteDraft(root, input)), moveDraft: input => result(() => moveDraft(root, input)),
    cancelChange: input => result(async () => { await cancelChange(root, input); return status(root); }), prepareReview: input => result(() => prepareReview(root, input)), reviewResults: input => result(() => reviewResults(root, input)), respond: input => result(() => respond(root, input)), writeWorkflow: input => result(() => writeWorkflow(root, input)), apply: input => result(() => apply(root, input, dependencies)), recover: input => result(() => recover(root, input, dependencies)), gateCheck: input => result(() => gateCheck(root, input)),
  };
}
/** Keep this factory out of agent CLI/hooks; authenticated human transport owns reachability. */
export function createHumanReview(root: string): HumanReviewApi { return { studioState: () => result(() => studioState(root)), saveReviewDraft: input => result(() => saveReviewDraft(root, input)), submitReview: input => result(() => submitReview(root, input)), selectAdvisory: input => result(() => selectAdvisory(root, input)) }; }
