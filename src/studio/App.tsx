import { useEffect, useState, type ReactNode } from 'react';
import type { DocumentView, GetRequest, HistoryResult, JsonValue, ReviewRound, StudioState } from '../contracts';
import { ApiError, getState, post } from '@/lib/api';
import { DocumentBody, kindNames, Rows, Section, ValueTree } from '@/documents';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';

type Load<T> = { key: string; data?: T; error?: unknown };
function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>내용을 불러오지 못했습니다</AlertTitle><AlertDescription>{error instanceof ApiError ? error.diagnostics.map((item, index) => <p key={index}>{diagnosticLabel(item.code)}</p>) : <p>서버 연결을 확인하거나 페이지를 새로고침해 주세요.</p>}<Button variant="outline" onClick={retry}>다시 시도</Button></AlertDescription></Alert>;
}
function Blank({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}
export function App() {
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<Load<StudioState>>({key: ''});
  const [destination, setDestination] = useState('documents');
  const [selected, setSelected] = useState('');
  const [scope, setScope] = useState<'approved' | 'draft'>('approved');
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<GetRequest | null>(null);
  const [document, setDocument] = useState<Load<DocumentView>>({key: ''});
  const [docRefresh, setDocRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    getState<StudioState>(abort.signal).then(data => setLoaded({key: String(refresh), data})).catch(error => { if (!abort.signal.aborted) setLoaded({key: String(refresh), error}); });
    return () => abort.abort();
  }, [refresh]);
  const state = loaded.key === String(refresh) ? loaded.data : undefined;
  const round = state?.review?.round;
  const listed = scope === 'draft' && round ? round.manifest.target_source.entries.map(entry => ({...entry, title: state?.documents.find(item => item.id === entry.id)?.title ?? `${kindNames[entry.kind]} · ${entry.id}`})) : state?.documents ?? [];
  const reviewDocs = round?.manifest.items.filter(item => item.type === 'document').filter(item => item.object_id.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const selectedId = selected || listed[0]?.id || '';
  const changeId = state?.status.active_change?.change_id;
  const request: GetRequest | null = snapshot ?? (selectedId ? {object_id: selectedId, scope: scope === 'draft' && changeId ? {type: 'change', change_id: changeId} : {type: 'approved'}} : null);
  const key = JSON.stringify([request, docRefresh]);
  useEffect(() => {
    const [requestBody] = JSON.parse(key) as [GetRequest | null, number];
    if (!requestBody) return;
    const abort = new AbortController();
    post<DocumentView>('/api/document', requestBody, abort.signal).then(data => setDocument({key, data})).catch(error => { if (!abort.signal.aborted) setDocument({key, error}); });
    return () => abort.abort();
  }, [key]);
  const view = document.key === key ? document.data : undefined;
  const navigate = (id: string) => { setSelected(id); setSnapshot(null); };
  const chooseReview = (id: string) => { if (round) { const delta = round.manifest.deltas.find(item => item.object_id === id); setSelected(id); setSnapshot({object_id: id, revision: {change_id: round.manifest.change_id, round: round.manifest.round, manifest_hash: round.manifest_hash, side: delta?.after ? 'after' : 'before'}}); } };
  const docs = listed.filter(item => `${item.id} ${item.title} ${kindNames[item.kind]}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const sidebar = <div className="flex min-w-0 flex-col gap-4"><Field><FieldLabel htmlFor="document-search">문서 찾기</FieldLabel><Input id="document-search" value={query} onChange={event => setQuery(event.target.value)} placeholder={destination === 'review' ? '문서 ID' : '제목 또는 ID'} /></Field><nav aria-label="문서 목록" className="flex flex-col gap-1">{destination === 'documents' ? docs.map(item => <Button key={item.id} variant={selectedId === item.id ? 'secondary' : 'ghost'} className="justify-start" onClick={() => navigate(item.id)}><span className="truncate">{item.title}</span></Button>) : reviewDocs.map(item => <Button key={item.item_id} variant={selectedId === item.object_id ? 'secondary' : 'ghost'} className="justify-start" onClick={() => chooseReview(item.object_id)}><span className="truncate">{item.object_id}</span></Button>)}</nav>{!docs.length && destination === 'documents' && <p className="text-sm text-muted-foreground">검색 결과가 없습니다.</p>}</div>;
  return <Tabs value={destination} onValueChange={value => {setDestination(value); setSnapshot(null); if (value === 'review' && reviewDocs[0]) chooseReview(reviewDocs[0].object_id);}}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-4"><div><p className="text-lg font-semibold">벼리 · {state?.project.name ?? '프로젝트'}</p><p className="text-sm text-muted-foreground">{state?.branch ?? '브랜치 없음'}</p></div><TabsList aria-label="전역 탐색"><TabsTrigger value="documents">문서</TabsTrigger><TabsTrigger value="review">리뷰</TabsTrigger></TabsList></header>
    {!state ? <main className="p-6">{loaded.error ? <Failure error={loaded.error} retry={() => setRefresh(value => value + 1)} /> : <p role="status">프로젝트를 불러오는 중입니다.</p>}</main> : <>
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3"><Badge variant="outline">{destination === 'review' ? `고정 리뷰 · ${round?.manifest.round ?? '없음'}차` : snapshot ? '과거 고정본' : scope === 'draft' ? '변경 초안' : '현재 승인본'}</Badge>{destination === 'documents' && <><Button variant="ghost" size="sm" onClick={() => {setScope('approved'); setSnapshot(null);}}>현재 승인본</Button>{state.status.active_change && <Button variant="ghost" size="sm" onClick={() => {setScope('draft'); setSnapshot(null);}}>변경 초안</Button>}</>}{scope === 'draft' && destination === 'documents' && <span className="text-sm text-muted-foreground">목록: 마지막 고정 리뷰에 포함된 문서</span>}<span className="text-sm">{state.status.active_change?.metadata.title ?? '진행 중인 변경 없음'}</span></div>
      <Warnings state={state} />
      <div className="px-6 pt-4 md:hidden"><Sheet><SheetTrigger asChild><Button variant="outline">문서 목록 열기</Button></SheetTrigger><SheetContent side="left"><SheetHeader><SheetTitle>문서 목록</SheetTitle><SheetDescription>읽을 문서를 선택한 뒤 닫아 주세요.</SheetDescription></SheetHeader><div className="overflow-auto px-4">{sidebar}</div><SheetClose asChild><Button variant="outline">목록 닫기</Button></SheetClose></SheetContent></Sheet></div>
      <div className="flex min-w-0"><aside className="hidden w-64 shrink-0 border-r p-4 md:block">{sidebar}</aside><main className="min-w-0 flex-1 p-6 lg:p-10">
        <TabsContent value="documents">{listed.length ? <DocumentPanel view={view} error={document.key === key ? document.error : undefined} retry={() => setDocRefresh(value => value + 1)} selectedId={selectedId} state={state} navigate={navigate} onSnapshot={setSnapshot} /> : <Blank title="승인된 문서가 없습니다" description="원본이나 변경안을 확인해 주세요." />}</TabsContent>
        <TabsContent value="review">{round ? <div className="flex flex-col gap-6"><ReviewSummary state={state} /><DocumentPanel view={view} error={document.key === key ? document.error : undefined} retry={() => setDocRefresh(value => value + 1)} selectedId={selectedId} state={state} navigate={chooseReview} onSnapshot={setSnapshot} /></div> : <Blank title="검토 중인 리뷰가 없습니다" description="변경안을 리뷰로 준비하면 고정된 문서가 표시됩니다." />}</TabsContent>
      </main></div>
    </>}
  </Tabs>;
}
function Warnings({state}: {state: StudioState}) {
  const warnings: string[] = [];
  if (state.status.source_integrity.state !== 'valid') warnings.push(`원본 상태: ${state.status.source_integrity.state}. 최신 원본을 다시 확인해 주세요.`);
  if (state.status.implementation_authorization.state === 'stale') warnings.push('구현 허가가 오래되었습니다. 다시 리뷰해야 합니다.');
  if (state.status.apply_state.state === 'recovery_required') warnings.push('원본 반영 복구가 필요합니다.');
  return warnings.length ? <div className="px-6 pt-4"><Alert variant="destructive"><AlertTitle>확인이 필요합니다</AlertTitle><AlertDescription>{warnings.map(message => <p key={message}>{message}</p>)}</AlertDescription></Alert></div> : null;
}
function ReviewSummary({state}: {state: StudioState}) {
  const review = state.review!; const manifest = review.round.manifest;
  return <div className="flex flex-col gap-4"><h1 className="text-2xl font-semibold">{manifest.metadata.title}</h1><p>{manifest.metadata.request}</p><p>{manifest.metadata.reason}</p><Alert><AlertTitle>사람의 리뷰를 기다립니다</AlertTitle><AlertDescription>이 화면은 고정된 검토 내용을 읽는 단계입니다. 판단 저장과 최종 제출은 아직 제공하지 않습니다.</AlertDescription></Alert><p>{manifest.deltas.length}개 문서가 고정되었습니다. {manifest.deltas.filter(delta => delta.operation === 'delete').map(delta => `삭제: ${delta.object_id}`).join(', ')}</p><Section title="구현 허용 범위"><Rows headings={['경로', '범위']} rows={manifest.metadata.implementation_scope.allowlist.map(item => [item.path, item.match])} /><p>{review.approval.implementation_allowed ? '구현 허용됨' : '구현 허용되지 않음'}</p>{manifest.metadata.implementation_scope.validation_plan.map(item => <p key={item}>{item}</p>)}{review.approval.blockers.map((item, index) => <p key={index}>{diagnosticLabel(item.code)}</p>)}</Section></div>;
}
function DocumentPanel({view, error, retry, selectedId, state, navigate, onSnapshot}: {view?: DocumentView; error?: unknown; retry: () => void; selectedId: string; state: StudioState; navigate: (id: string) => void; onSnapshot: (request: GetRequest) => void}) {
  return <div className="flex min-w-0 flex-col gap-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{view?.projection.title ?? selectedId}</h1>{view && <p className="mt-2 text-sm text-muted-foreground">{kindNames[view.kind]} · {view.provenance === 'approved' ? '현재 승인본' : view.provenance === 'draft' ? '변경 초안' : `고정본 · ${view.revision.round}차 · ${view.revision.side === 'before' ? '변경 전' : '변경 후'}`}</p>}</div><div className="flex gap-2"><History key={selectedId} objectId={selectedId} onSnapshot={onSnapshot} /><Details view={view} state={state} /></div></div><Separator />{error ? <Failure error={error} retry={retry} /> : view ? <DocumentBody view={view} onNavigate={navigate} knownIds={[...state.documents.map(item => item.id), ...state.review?.round.manifest.target_source.entries.map(item => item.id) ?? []]} /> : <p role="status">문서를 불러오는 중입니다.</p>}</div>;
}
function DetailSheet({label, children}: {label: string; children: ReactNode}) {
  return <Sheet><SheetTrigger asChild><Button variant="outline" size="sm">{label}</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>{label}</SheetTitle><SheetDescription>현재 선택한 문서와 프로젝트의 기록입니다.</SheetDescription></SheetHeader><div className="overflow-auto px-4 pb-6">{children}</div></SheetContent></Sheet>;
}
function Details({view, state}: {view?: DocumentView; state: StudioState}) {
  return <DetailSheet label="자세히"><ValueTree value={{project: state.project, branch: state.branch, revision: view?.revision ?? null, path: view?.path ?? null, semantic_hash: view?.semantic_hash ?? null, raw_hash: view?.raw_hash ?? null, status: state.status, review_blockers: state.review?.approval.blockers ?? []} as unknown as JsonValue} /></DetailSheet>;
}
function History({objectId, onSnapshot}: {objectId: string; onSnapshot: (request: GetRequest) => void}) {
  const [opened, setOpened] = useState(false); const [cursor, setCursor] = useState<string | undefined>(); const [page, setPage] = useState(0); const [loaded, setLoaded] = useState<Load<HistoryResult>>({key: ''});
  const key = JSON.stringify([objectId, cursor, page]);
  useEffect(() => { if (!opened) return; const abort = new AbortController(); post<HistoryResult>('/api/history', {object_id: objectId, limit: 25, cursor}, abort.signal).then(data => setLoaded({key, data})).catch(error => {if (!abort.signal.aborted) setLoaded({key, error});}); return () => abort.abort(); }, [opened, objectId, cursor, key]);
  const data = loaded.key === key ? loaded.data : undefined;
  const snapshot = (round: ReviewRound, side: 'before' | 'after') => {onSnapshot({object_id: objectId, revision: {change_id: round.manifest.change_id, round: round.manifest.round, manifest_hash: round.manifest_hash, side}}); setOpened(false);};
  return <Sheet open={opened} onOpenChange={setOpened}><SheetTrigger asChild><Button variant="outline" size="sm">이력</Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>문서 이력</SheetTitle><SheetDescription>승인, 원본 반영, 구현 증거는 각각의 기록입니다.</SheetDescription></SheetHeader><div className="flex flex-col gap-6 overflow-auto px-4 pb-6">{loaded.error ? <Failure error={loaded.error} retry={() => setPage(value => value + 1)} /> : !data ? <p role="status">이력을 불러오는 중입니다.</p> : !data.entries.length ? <p>아직 기록된 변경 이유나 이력이 없습니다.</p> : data.entries.map((entry, index) => <section key={index} className="flex flex-col gap-3"><h2 className="font-semibold">{entry.type}</h2>{entry.type === 'review' && <div className="flex gap-2">{(['before','after'] as const).filter(side => entry.record.manifest.deltas.some(delta => delta.object_id === objectId && delta[side])).map(side => <Button key={side} variant="outline" size="sm" onClick={() => snapshot(entry.record, side)}>{entry.record.manifest.round}차 {side === 'before' ? '변경 전' : '변경 후'}</Button>)}</div>}<ValueTree value={entry as unknown as JsonValue} /></section>)}{data?.next_cursor && <Button variant="outline" onClick={() => setCursor(data.next_cursor!)}>다음 기록</Button>}{cursor && <Button variant="ghost" onClick={() => setCursor(undefined)}>처음 기록으로</Button>}</div></SheetContent></Sheet>;
}

function diagnosticLabel(code: string): string {
  const labels: Record<string, string> = {VALIDATION_FAILED: "문서나 요청이 유효하지 않습니다. 내용을 확인해 주세요.", REVIEW_REQUIRED: "최종 리뷰와 승인이 필요합니다.", STALE_BASE: "원본이 변경되었습니다. 최신 내용으로 다시 확인해 주세요.", STALE_REVIEW: "검토본이 오래되었습니다. 최신 리뷰를 확인해 주세요.", CONFLICT: "다른 작업과 충돌했습니다. 최신 상태를 다시 확인해 주세요.", SOURCE_DRIFT: "원본과 승인 기록이 다릅니다. 원본 상태를 먼저 확인해 주세요.", UNPROCESSED_FEEDBACK: "아직 처리되지 않은 피드백이 있습니다.", APPLY_RECOVERY_REQUIRED: "원본 반영을 복구해야 합니다.", HOOK_NOT_ACTIVE: "호스트 보호 기능이 활성화되지 않았습니다.", SCOPE_DENIED: "요청한 내용이 허용 범위를 벗어났습니다.", CAPABILITY_UNAVAILABLE: "필요한 실행 기능을 사용할 수 없습니다.", WORKSPACE_MISMATCH: "프로젝트 작업 공간이 변경되었습니다.", POLICY_MISMATCH: "프로젝트 정책을 다시 확인해야 합니다.", PATH_DENIED: "이 경로에 접근할 수 없습니다.", AUTH_REQUIRED: "세션이 만료되었거나 인증되지 않았습니다. 페이지를 새로고침해 주세요.", UNEXPECTED: "서버에서 요청을 완료하지 못했습니다."};
  return labels[code] ?? "요청 상태를 다시 확인해 주세요.";
}
