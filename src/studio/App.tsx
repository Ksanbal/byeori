import { useEffect, useState } from 'react';
import type { DocumentView, GetRequest, ReviewResults, ReviewRound, StudioState } from '../contracts';
import { getState, post } from '@/lib/api';
import { kindNames } from '@/documents';
import { DocumentPanel, Failure, Blank, type Load } from '@/panels';
import { ReviewWorkspace } from '@/review/ReviewWorkspace';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

export function App() {
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<Load<StudioState>>({key: ''});
  const [destination, setDestination] = useState('documents');
  const [reviewVisited, setReviewVisited] = useState(false);
  const [lastReview, setLastReview] = useState<ReviewResults | null>(null);
  const [selected, setSelected] = useState('');
  const [scope, setScope] = useState<'approved' | 'draft'>('approved');
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<GetRequest | null>(null);
  const [historicalRound, setHistoricalRound] = useState<ReviewRound | null>(null);
  const [document, setDocument] = useState<Load<DocumentView>>({key: ''});
  const [docRefresh, setDocRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    getState<StudioState>(abort.signal).then(data => {setLoaded({key: String(refresh), data}); if (data.review) setLastReview(data.review);}).catch(error => {if (!abort.signal.aborted) setLoaded(previous => ({key: String(refresh), data: previous.data, error}));});
    return () => abort.abort();
  }, [refresh]);
  // Keep the last project visible while a deliberate status refresh is pending.
  const state = loaded.data;
  const round = state?.review?.round;
  const historical = snapshot && historicalRound && snapshot.revision?.manifest_hash === historicalRound.manifest_hash ? historicalRound : null;
  const listed = historical ? historical.manifest.deltas.map(delta => {const file = delta.after ?? delta.before!; return {...file, title: document.data?.id === file.id && document.data.revision.manifest_hash === historical.manifest_hash ? document.data.projection.title : `${kindNames[file.kind]} · ${file.id}`};}) : scope === 'draft' && round ? round.manifest.target_source.entries.map(entry => ({...entry, title: state?.documents.find(item => item.id === entry.id)?.title ?? `${kindNames[entry.kind]} · ${entry.id}`})) : state?.documents ?? [];
  const selectedId = selected || listed[0]?.id || '';
  const changeId = state?.status.active_change?.change_id;
  const request: GetRequest | null = destination !== 'documents' ? null : snapshot ?? (selectedId ? {object_id: selectedId, scope: scope === 'draft' && changeId ? {type: 'change', change_id: changeId} : {type: 'approved'}} : null);
  const key = JSON.stringify([request, docRefresh]);
  useEffect(() => {
    const [requestBody] = JSON.parse(key) as [GetRequest | null, number];
    if (!requestBody) return;
    const abort = new AbortController();
    post<DocumentView>('/api/document', requestBody, abort.signal).then(data => setDocument({key, data})).catch(error => {if (!abort.signal.aborted) setDocument({key, error});});
    return () => abort.abort();
  }, [key]);
  const view = document.key === key ? document.data : undefined;
  const navigate = (id: string) => {setSelected(id); const delta = historical?.manifest.deltas.find(delta => delta.object_id === id); if (delta) {const side = snapshot?.revision?.side === 'before' && delta.before ? 'before' : delta.after ? 'after' : 'before'; setSnapshot({object_id: id, revision: {change_id: historical!.manifest.change_id, round: historical!.manifest.round, manifest_hash: historical!.manifest_hash, side}});} else setSnapshot(null);};
  const showSnapshot = (request: GetRequest, round?: ReviewRound) => {setSelected(request.object_id); setSnapshot(request); setHistoricalRound(round ?? null); setDestination('documents');};
  const docs = listed.filter(item => `${item.id} ${item.title} ${kindNames[item.kind]}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const sidebar = <div className="flex min-w-0 flex-col gap-4"><Field><FieldLabel htmlFor="document-search">문서 찾기</FieldLabel><Input id="document-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="제목 또는 ID" /></Field><nav aria-label="문서 목록" className="flex flex-col gap-1">{docs.map(item => <Button key={item.id} variant={selectedId === item.id ? 'secondary' : 'ghost'} className="justify-start" onClick={() => navigate(item.id)}><span className="truncate">{item.title}</span></Button>)}</nav>{!docs.length && <p className="text-sm text-muted-foreground">검색 결과가 없습니다.</p>}</div>;
  return <Tabs value={destination} onValueChange={value => {setDestination(value); setSnapshot(null); if (value === 'review') setReviewVisited(true);}}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-4"><div><p className="text-lg font-semibold">벼리 · {state?.project.name ?? '프로젝트'}</p><p className="text-sm text-muted-foreground">{state?.branch ?? '브랜치 없음'}</p></div><TabsList aria-label="전역 탐색"><TabsTrigger value="documents">문서</TabsTrigger><TabsTrigger value="review">리뷰</TabsTrigger></TabsList></header>
    {!state ? <main className="p-6">{loaded.error ? <Failure error={loaded.error} retry={() => setRefresh(value => value + 1)} /> : <p role="status">프로젝트를 불러오는 중입니다.</p>}</main> : <>
      <Warnings state={state} />
      {loaded.error && <div className="p-6"><Failure error={loaded.error} retry={() => setRefresh(value => value + 1)} /></div>}
      <TabsContent value="documents"><div className="flex flex-wrap items-center gap-3 border-b px-6 py-3"><Badge variant="outline">{snapshot ? '과거 고정본' : scope === 'draft' ? '변경 초안' : '현재 승인본'}</Badge><Button variant="ghost" size="sm" onClick={() => {setScope('approved'); setSnapshot(null);}}>현재 승인본</Button>{state.status.active_change && <Button variant="ghost" size="sm" onClick={() => {setScope('draft'); setSnapshot(null);}}>변경 초안</Button>}{scope === 'draft' && <span className="text-sm text-muted-foreground">목록: 마지막 고정 리뷰에 포함된 문서</span>}<span className="text-sm">{state.status.active_change?.metadata.title ?? '진행 중인 변경 없음'}</span></div>
        <div className="px-6 pt-4 md:hidden"><Sheet><SheetTrigger asChild><Button variant="outline">문서 목록 열기</Button></SheetTrigger><SheetContent side="left"><SheetHeader><SheetTitle>문서 목록</SheetTitle><SheetDescription>읽을 문서를 선택한 뒤 닫아 주세요.</SheetDescription></SheetHeader><div className="overflow-auto px-4">{sidebar}</div><SheetClose asChild><Button variant="outline">목록 닫기</Button></SheetClose></SheetContent></Sheet></div>
        <div className="flex min-w-0"><aside className="hidden w-64 shrink-0 border-r p-4 md:block">{sidebar}</aside><main className="min-w-0 flex-1 p-6 lg:p-10">{listed.length || snapshot ? <DocumentPanel view={view} error={document.key === key ? document.error : undefined} retry={() => setDocRefresh(value => value + 1)} selectedId={selectedId} state={state} navigate={navigate} onSnapshot={showSnapshot} knownIds={historical?.manifest.deltas.map(delta => delta.object_id)} /> : <Blank title="승인된 문서가 없습니다" description="원본이나 변경안을 확인해 주세요." />}</main></div>
      </TabsContent>
      <TabsContent value="review" forceMount hidden={destination !== 'review'}>{reviewVisited && (lastReview ? <ReviewWorkspace review={lastReview} state={state} onRefresh={() => setRefresh(value => value + 1)} onSnapshot={showSnapshot} /> : <Blank title="검토 중인 리뷰가 없습니다" description="변경안을 리뷰로 준비하면 고정된 문서가 표시됩니다." />)}</TabsContent>
    </>}
  </Tabs>;
}
function Warnings({state}: {state: StudioState}) {
  const warnings: string[] = [];
  if (state.status.source_integrity.state !== 'valid') warnings.push('원본 상태가 승인 기록과 다릅니다. 최신 원본을 확인해 주세요.');
  if (state.status.implementation_authorization.state === 'stale') warnings.push('구현 허가가 오래되었습니다. 다시 리뷰해야 합니다.');
  if (state.status.apply_state.state === 'recovery_required') warnings.push('원본 반영 복구가 필요합니다.');
  return warnings.length ? <div className="px-6 pt-4"><Alert variant="destructive"><AlertTitle>확인이 필요합니다</AlertTitle><AlertDescription>{warnings.map(message => <p key={message}>{message}</p>)}</AlertDescription></Alert></div> : null;
}
