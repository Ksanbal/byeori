import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { GetRequest, ReviewRound, ReviewResults, StudioState } from '../../contracts';
import { ReviewSession, bindingKey, reviewBinding, staleReview } from '@/lib/review-session';
import { ErrorText, diagnosticLabel, History } from '@/panels';
import { ApiError } from '@/lib/api';
import { Rows } from '@/documents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '@/components/ui/sheet';
import { FrozenDiff, useFrozenDocuments, permissionChanges } from './FrozenDiff';
import { Comments, Judgment, decisionNames, newCommentInput, type CommentInput } from './Comments';
import { Confirmation, ScopeSummary } from './Confirmation';
import { Hosts } from './Hosts';

const phaseNames = {saved: '서버에 저장됨', dirty: '아직 저장되지 않음', saving: '서버에 저장 중', error: '저장 또는 제출 실패 · 입력 유지', submitting: '최종 기록 확인 중', uncertain: '제출 결과 확인 필요 · 입력 고정', final: '최종 기록 확인됨'};
export function ReviewWorkspace({review: incoming, state, onRefresh, onSnapshot}: {review: ReviewResults; state: StudioState; onRefresh: () => void; onSnapshot: (request: GetRequest, round?: ReviewRound) => void}) {
  const [session] = useState(() => new ReviewSession(incoming));
  const current = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [selected, setSelected] = useState(''); const [query, setQuery] = useState(''); const [retry, setRetry] = useState(0); const [confirm, setConfirm] = useState(false);
  const [inputs, setInputs] = useState<Record<string, CommentInput>>({}); const [inputCopy, setInputCopy] = useState(''); const [actionError, setActionError] = useState<unknown>();
  const completed = useRef<HTMLDivElement>(null); const previousPhase = useRef(current.phase);
  const review = current.review; const manifest = review.round.manifest;
  const frozen = useFrozenDocuments(review, retry); const documents = frozen.data?.documents ?? {}; const ready = frozen.data?.ready ?? false;
  const different = bindingKey(reviewBinding(incoming)) !== bindingKey(reviewBinding(review));
  const staleError = current.error instanceof ApiError && current.error.diagnostics.some(item => ['STALE_REVIEW','STALE_BASE','WORKSPACE_MISMATCH','POLICY_MISMATCH','SOURCE_DRIFT'].includes(item.code));
  const outdated = staleReview(review) || (!review.accepted_submission && (different || staleError || !state.review));
  const editable = session.editable() && !outdated;
  const busy = current.phase === 'submitting';
  const id = manifest.items.some(item => item.item_id === selected) ? selected : manifest.items[0]?.item_id;
  const item = manifest.items.find(item => item.item_id === id);
  const decision = current.feedback.items.find(item => item.item_id === id);
  const objectId = item?.type === 'document' ? item.object_id : 'scope:implementation';
  const pair = documents[objectId]; const input = inputs[id] ?? newCommentInput(objectId);
  const title = (itemId: string) => {const item = manifest.items.find(item => item.item_id === itemId)!; if (item.type === 'implementation_scope') return '구현 범위'; return (documents[item.object_id]?.after ?? documents[item.object_id]?.before)?.projection.title ?? item.object_id;};
  const run = (action: () => Promise<void>) => {setActionError(undefined); void action().catch(setActionError);};
  useEffect(() => {session.observe(incoming);}, [session, incoming]);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {if (current.phase === 'final' && previousPhase.current !== 'final') completed.current?.focus(); previousPhase.current = current.phase;}, [current.phase]);
  const unadded = Object.values(inputs).filter(input => input.body.trim()).length;
  const pending = current.feedback.items.filter(item => item.decision === 'pending').length;
  const blockers = current.feedback.items.flatMap(item => item.comments.filter(comment => comment.blocking)).length;
  const sidebar = <div className="flex flex-col gap-4"><Field><FieldLabel htmlFor="review-search">리뷰 항목 찾기</FieldLabel><Input id="review-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="제목 또는 ID" /></Field><nav aria-label="문서 목록" className="flex flex-col gap-2">{manifest.items.filter(item => `${title(item.item_id)} ${item.item_id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <Button key={item.item_id} variant={id === item.item_id ? 'secondary' : 'ghost'} className="h-auto justify-start whitespace-normal" onClick={() => setSelected(item.item_id)}><span className="min-w-0 text-left"><span className="block break-words">{title(item.item_id)}</span><span className="block text-xs text-muted-foreground">{item.type === 'document' ? item.object_id : 'scope:implementation'} · {decisionNames[current.feedback.items.find(value => value.item_id === item.item_id)!.decision]}</span></span></Button>)}</nav></div>;
  const replaceRound = async () => {await session.loadRound(incoming); setInputCopy(JSON.stringify(inputs, null, 2)); setInputs({}); setSelected(''); setConfirm(false);};
  return <div className="flex min-w-0 flex-col"><div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3"><div><Badge variant="outline">고정 리뷰 · {manifest.round}차</Badge><p className="mt-2 text-sm">{manifest.metadata.title}</p></div><div className="flex flex-wrap gap-2"><History changeId={manifest.change_id} onSnapshot={onSnapshot} /><Button variant="outline" size="sm" onClick={onRefresh}>최신 상태 확인</Button><Hosts /></div></div>
    {outdated && <div className="px-6 pt-4"><Alert variant="destructive"><AlertTitle>이 검토본으로 새 승인을 제출할 수 없습니다</AlertTitle><AlertDescription><p>입력 사본을 보존하고 최신 리뷰를 확인해 주세요.</p>{different && <Button variant="outline" disabled={busy || current.phase === 'uncertain'} onClick={() => run(replaceRound)}>입력 사본 보존 후 새 리뷰 열기</Button>}</AlertDescription></Alert></div>}
    {(manifest.deltas.some(delta => delta.operation === 'delete') || permissionChanges(documents).length > 0) && <div className="px-6 pt-4"><Alert><AlertTitle>삭제·권한 변화를 확인해 주세요</AlertTitle><AlertDescription>선택 문서의 변경 전후와 최종 제출 요약에서 내용을 확인할 수 있습니다.</AlertDescription></Alert></div>}
    <div className="px-6 pt-4 md:hidden"><Sheet><SheetTrigger asChild><Button variant="outline">문서 목록 열기</Button></SheetTrigger><SheetContent side="left"><SheetHeader><SheetTitle>리뷰 항목</SheetTitle><SheetDescription>항목을 오가도 판단과 댓글은 유지됩니다.</SheetDescription></SheetHeader><div className="overflow-auto px-4">{sidebar}</div><SheetClose asChild><Button variant="outline">목록 닫기</Button></SheetClose></SheetContent></Sheet></div>
    <div className="flex min-w-0"><aside className="hidden w-64 shrink-0 border-r p-4 md:block">{sidebar}</aside><main className="flex min-w-0 flex-1 flex-col gap-6 p-6 lg:p-10">{item?.type === 'document' ? <FrozenDiff id={objectId} review={review} pair={pair} error={frozen.error} retry={() => setRetry(value => value + 1)} state={state} onSnapshot={onSnapshot} navigate={object => {const next = manifest.items.find(item => item.type === 'document' && item.object_id === object); if (next) setSelected(next.item_id);}} /> : <><h1 className="text-2xl font-semibold">구현 범위 검토</h1><ScopeSummary review={review} /><p>이 항목의 승인은 최종 확인에서 구현 허용을 선택하는 것과 별개입니다.</p></>}
      {decision && <section aria-label="판단과 댓글" className="flex flex-col gap-4 border-t pt-6"><Judgment value={decision} disabled={!editable || (item?.type === 'document' && !pair)} onChange={value => session.edit({...current.feedback, items: current.feedback.items.map(item => item.item_id === value.item_id ? value : item), implementation_authorization: value.decision !== 'approve' ? {allowed: false, scope_hash: null} : current.feedback.implementation_authorization})} /><Comments key={id} value={decision} input={input} view={pair?.after ?? pair?.before} objectId={objectId} disabled={!editable || (item?.type === 'document' && !pair)} onInput={input => setInputs(previous => ({...previous, [id]: input}))} onChange={value => session.edit({...current.feedback, items: current.feedback.items.map(item => item.item_id === value.item_id ? value : item), implementation_authorization: value.comments.some(comment => comment.blocking) ? {allowed: false, scope_hash: null} : current.feedback.implementation_authorization})} /></section>}
      {current.phase === 'final' && <div ref={completed} tabIndex={-1}><Alert><AlertTitle>최종 판단이 기록되었습니다</AlertTitle><AlertDescription><p>{review.approval.documents_approved ? '기획 승인 성립' : '기획 승인 성립하지 않음 · 미검토·수정 요청·차단 문제를 확인해 주세요.'}</p><p>{review.approval.implementation_allowed ? '고정 범위 구현 허용 성립' : '구현 허용 성립하지 않음'}</p><p>원본 반영과 구현 완료는 각각 별도 기록입니다.</p><p>대화에서 에이전트에게 ‘리뷰 완료’라고 알려 주세요.</p></AlertDescription></Alert></div>}
      {review.approval.blockers.filter(item => item.code !== 'REVIEW_REQUIRED').map((item, index) => <p key={index} className="text-sm">{diagnosticLabel(item.code)}</p>)}
      {Boolean(current.error || actionError) && <Alert variant="destructive"><AlertTitle>입력을 유지했습니다</AlertTitle><AlertDescription><ErrorText error={actionError ?? current.error} />{current.phase === 'uncertain' ? <><Button variant="outline" onClick={() => run(() => session.verifySubmission())}>제출 결과 확인</Button><Button variant="outline" onClick={() => run(() => session.submit())}>같은 제출 다시 시도</Button></> : <><Button variant="outline" disabled={!editable} onClick={() => run(() => session.flush())}>저장 다시 시도</Button><Button variant="outline" disabled={busy} onClick={() => run(() => session.reload())}>입력 사본 보존 후 저장본 불러오기</Button></>}</AlertDescription></Alert>}
      {(current.previousCopy || inputCopy) && <Field><FieldLabel htmlFor="preserved-copy">보존한 입력 사본 · 복사 가능</FieldLabel><Textarea id="preserved-copy" readOnly value={[current.previousCopy, inputCopy].filter(Boolean).join('\n')} /></Field>}
    </main></div>
    <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background px-6 py-4"><div role="status" aria-label="리뷰 저장 상태"><p>{current.phase === 'saved' && current.version === null ? '아직 판단을 저장하지 않았습니다' : phaseNames[current.phase]}</p><p className="text-sm text-muted-foreground">미검토 {pending}개 · 차단 댓글 {blockers}개{unadded ? ` · 추가하지 않은 댓글 ${unadded}개` : ''}</p></div>{current.phase !== 'final' && <Confirmation review={review} feedback={current.feedback} documents={documents} open={confirm} onOpen={setConfirm} onChange={feedback => session.edit(feedback)} submit={() => run(async () => {try {await session.submit();} finally {setConfirm(false);}})} disabled={!ready || outdated || busy || current.phase === 'uncertain' || unadded > 0} busy={busy} />}{current.phase === 'final' && <Rows headings={['기획', '원본 반영', '구현']} rows={[[review.approval.documents_approved ? '승인 성립' : '승인 안 됨', '이력에서 반영 기록 확인', '이력에서 별도 근거 확인']]} />}</footer>
  </div>;
}
