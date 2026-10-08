import { useEffect, useState, type ReactNode } from 'react';
import type { DocumentView, GetRequest, HistoryEntry, HistoryResult, JsonValue, ReviewRound, StudioState } from '../contracts';
import { ApiError, post } from '@/lib/api';
import { DocumentBody, kindNames, Rows, ValueTree } from '@/documents';
import { Button } from '@/components/ui/button';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export type Load<T> = { key: string; data?: T; error?: unknown };
export function diagnosticLabel(code: string): string {
  const labels: Record<string, string> = {VALIDATION_FAILED: '문서나 요청이 유효하지 않습니다. 내용을 확인해 주세요.', REVIEW_REQUIRED: '최종 리뷰와 승인이 필요합니다.', STALE_BASE: '원본이 변경되었습니다. 최신 내용으로 다시 확인해 주세요.', STALE_REVIEW: '검토본이 오래되었습니다. 입력을 보존하고 최신 리뷰를 확인해 주세요.', CONFLICT: '다른 작업과 충돌했습니다. 입력을 보존하고 저장본을 확인해 주세요.', SOURCE_DRIFT: '원본과 승인 기록이 다릅니다. 원본 상태를 먼저 확인해 주세요.', UNPROCESSED_FEEDBACK: '아직 처리되지 않은 피드백이 있습니다.', APPLY_RECOVERY_REQUIRED: '다른 작업이 진행 중이거나 반영 복구가 필요합니다. 잠시 후 다시 확인해 주세요.', HOOK_NOT_ACTIVE: '호스트 보호 기능이 활성화되지 않았습니다.', SCOPE_DENIED: '요청한 내용이 허용 범위를 벗어났습니다.', CAPABILITY_UNAVAILABLE: '필요한 실행 기능을 사용할 수 없습니다.', WORKSPACE_MISMATCH: '프로젝트 작업 공간이 변경되었습니다.', POLICY_MISMATCH: '프로젝트 정책을 다시 확인해야 합니다.', PATH_DENIED: '이 경로에 접근할 수 없습니다.', AUTH_REQUIRED: '세션이 만료되었거나 인증되지 않았습니다. 페이지를 새로고침해 주세요.', UNEXPECTED: '서버에서 요청을 완료하지 못했습니다.'};
  return labels[code] ?? '요청 상태를 다시 확인해 주세요.';
}
export function ErrorText({error}: {error: unknown}) {
  return error instanceof ApiError ? <>{error.diagnostics.map((item, index) => <p key={index}>{diagnosticLabel(item.code)}</p>)}</> : <p>{error instanceof Error && !/fetch|network|JSON|Unexpected/i.test(error.message) ? error.message : '서버 연결을 확인한 뒤 다시 시도해 주세요. 입력은 유지됩니다.'}</p>;
}
export function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>내용을 불러오지 못했습니다</AlertTitle><AlertDescription><ErrorText error={error} /><Button variant="outline" onClick={retry}>다시 시도</Button></AlertDescription></Alert>;
}
export function Blank({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}
export function DetailSheet({label, children}: {label: string; children: ReactNode}) {
  return <Sheet><SheetTrigger asChild><Button variant="outline" size="sm">{label}</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>{label}</SheetTitle><SheetDescription>선택한 문서와 프로젝트의 실제 기록입니다.</SheetDescription></SheetHeader><div className="overflow-auto px-4 pb-6">{children}</div></SheetContent></Sheet>;
}
export function Details({view, state}: {view?: DocumentView; state: StudioState}) {
  return <DetailSheet label="자세히"><ValueTree value={{project: state.project, branch: state.branch, revision: view?.revision ?? null, path: view?.path ?? null, semantic_hash: view?.semantic_hash ?? null, raw_hash: view?.raw_hash ?? null, status: state.status, review_blockers: state.review?.approval.blockers ?? []} as unknown as JsonValue} /></DetailSheet>;
}
export function DocumentPanel({view, error, retry, selectedId, state, navigate, onSnapshot, knownIds}: {view?: DocumentView; error?: unknown; retry: () => void; selectedId: string; state: StudioState; navigate: (id: string) => void; onSnapshot: (request: GetRequest, round?: ReviewRound) => void; knownIds?: string[]}) {
  return <div className="flex min-w-0 flex-col gap-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{view?.projection.title ?? selectedId}</h1>{view && <p className="mt-2 text-sm text-muted-foreground">{kindNames[view.kind]} · {view.provenance === 'approved' ? '현재 승인본' : view.provenance === 'draft' ? '변경 초안' : `고정본 · ${view.revision.round}차 · ${view.revision.side === 'before' ? '변경 전' : '변경 후'}`}</p>}</div><div className="flex gap-2"><History key={selectedId} objectId={selectedId} onSnapshot={onSnapshot} /><Details view={view} state={state} /></div></div><Separator />{error ? <Failure error={error} retry={retry} /> : view ? <DocumentBody view={view} onNavigate={navigate} knownIds={knownIds ?? [...state.documents.map(item => item.id), ...state.review?.round.manifest.target_source.entries.map(item => item.id) ?? []]} /> : <p role="status">문서를 불러오는 중입니다.</p>}</div>;
}
const historyNames = {change: '변경 요청', review: '고정 리뷰', submission: '최종 판단', response: '피드백 처리', applied: '원본 반영', implementation: '구현 근거', cancelled: '변경 취소'};
function HistoryBody({entry}: {entry: HistoryEntry}) {
  switch (entry.type) {
    case 'change': return <><p>{entry.record.metadata.title}</p><p>요청: {entry.record.metadata.request || '미기록'}</p><p>이유: {entry.record.metadata.reason || '미기록'}</p></>;
    case 'review': return <><p>{entry.record.manifest.round}차 · {entry.record.manifest.metadata.title}</p><p>검토 이유: {entry.record.manifest.metadata.reason || '미기록'}</p></>;
    case 'submission': return <><p>{entry.record.submitted_at}</p><Rows headings={['항목', '판단', '댓글']} rows={entry.record.submission.items.map(item => [item.item_id, {approve: '승인', pending: '미검토', request_changes: '수정 요청'}[item.decision], item.comments.map(comment => <p key={comment.id}>{comment.body} · {comment.blocking ? '차단' : '비차단'}</p>)])} /><p>{entry.record.submission.implementation_authorization.allowed ? '표시한 범위의 구현 허용을 제출함' : '구현 허용하지 않음'}</p><p>원본 반영이나 구현 완료를 뜻하지 않습니다.</p></>;
    case 'response': return <>{entry.record.comments.map(comment => <div key={comment.comment_id}><p>{comment.comment_id} · {{proposed: '변경 제안', addressed_in_draft: '초안에 반영', needs_clarification: '추가 확인 필요', not_applied: '반영하지 않음'}[comment.result]}</p><p>이유: {comment.rationale || '미기록'}</p><p>변경 경로: {comment.changed_paths.join(', ') || '미기록'}</p></div>)}</>;
    case 'applied': return <><p>{entry.record.applied_at}</p><p>승인된 고정본을 원본에 반영했습니다. 구현 완료는 별도 기록입니다.</p><p>추가 반영 이유: 미기록</p></>;
    case 'implementation': return <><p>{entry.record.recorded_at} · {{unverified: '미검증', verified: '검증됨', failed: '검증 실패'}[entry.record.status]}</p>{entry.record.evidence.length ? entry.record.evidence.map((item, index) => <div key={index}><p>{item.description || '미기록'}</p><p>검사: {item.command ?? '미기록'} · 종료값 {item.exit_code ?? '미기록'}</p><p>근거: {item.artifact_path ?? '미기록'}</p></div>) : <p>구현 근거: 미기록</p>}</>;
    case 'cancelled': return <><p>{entry.cancelled_at}</p><p>취소 이유: {entry.reason || '미기록'}</p></>;
  }
}
export function History({objectId, changeId, onSnapshot}: {objectId?: string; changeId?: string; onSnapshot: (request: GetRequest, round?: ReviewRound) => void}) {
  const [opened, setOpened] = useState(false); const [cursor, setCursor] = useState<string | undefined>(); const [page, setPage] = useState(0); const [loaded, setLoaded] = useState<Load<HistoryResult>>({key: ''});
  const key = JSON.stringify([objectId, changeId, cursor, page]);
  useEffect(() => { if (!opened) return; const abort = new AbortController(); post<HistoryResult>('/api/history', {object_id: objectId, change_id: changeId, limit: 25, cursor}, abort.signal).then(data => setLoaded({key, data})).catch(error => {if (!abort.signal.aborted) setLoaded({key, error});}); return () => abort.abort(); }, [opened, objectId, changeId, cursor, key]);
  const data = loaded.key === key ? loaded.data : undefined;
  const snapshot = (round: ReviewRound, id: string, side: 'before' | 'after') => {onSnapshot({object_id: id, revision: {change_id: round.manifest.change_id, round: round.manifest.round, manifest_hash: round.manifest_hash, side}}, round); setOpened(false);};
  return <Sheet open={opened} onOpenChange={setOpened}><SheetTrigger asChild><Button variant="outline" size="sm">이력</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>{objectId ? '문서 이력' : '변경안 이력'}</SheetTitle><SheetDescription>판단, 원본 반영, 구현 증거는 각각의 기록입니다.</SheetDescription></SheetHeader><div className="flex flex-col gap-6 overflow-auto px-4 pb-6">{loaded.key === key && loaded.error ? <Failure error={loaded.error} retry={() => setPage(value => value + 1)} /> : !data ? <p role="status">이력을 불러오는 중입니다.</p> : !data.entries.length ? <p>아직 기록된 변경 이유나 이력이 없습니다.</p> : data.entries.map((entry, index) => <section key={index} className="flex flex-col gap-3"><h2 className="font-semibold">{historyNames[entry.type]}</h2><HistoryBody entry={entry} />{entry.type === 'review' && <div className="flex flex-wrap gap-2">{entry.record.manifest.deltas.filter(delta => !objectId || delta.object_id === objectId).flatMap(delta => (['before','after'] as const).filter(side => delta[side]).map(side => <Button key={delta.object_id + side} variant="outline" size="sm" onClick={() => snapshot(entry.record, delta.object_id, side)}>{entry.record.manifest.round}차 {side === 'before' ? '변경 전' : '변경 후'}{objectId ? '' : ' · ' + delta.object_id}</Button>))}</div>}<Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm">기록 원문</Button></CollapsibleTrigger><CollapsibleContent><ValueTree value={entry as unknown as JsonValue} /></CollapsibleContent></Collapsible></section>)}{data?.next_cursor && <Button variant="outline" onClick={() => setCursor(data.next_cursor!)}>다음 기록</Button>}{cursor && <Button variant="ghost" onClick={() => setCursor(undefined)}>처음 기록으로</Button>}</div></SheetContent></Sheet>;
}
